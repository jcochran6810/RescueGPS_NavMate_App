import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FieldAssignment, FieldMessage } from '@/lib/command'

/**
 * The queues that carry field writes back to command: assignment status
 * changes, outgoing messages and read receipts, and the asset_id on shared
 * track fixes. Each must survive having no signal and must not double up on
 * a replay.
 */

const calls: { table: string; op: string; args: unknown[] }[] = []
let failNext: unknown = null
const getSessionImpl = vi.fn()

function result() {
  const error = failNext
  failNext = null
  return Promise.resolve({ error })
}

vi.mock('@/lib/supabase', () => ({
  PHOTO_BUCKET: 'waypoint-photos',
  errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e),
  supabase: {
    auth: { getSession: (...a: unknown[]) => getSessionImpl(...a) },
    rpc: (name: string, args: unknown) => {
      calls.push({ table: name, op: 'rpc', args: [args] })
      return Promise.resolve({ data: 'unit-1', error: null })
    },
    from: (table: string) => ({
      upsert: (row: unknown, opts: unknown) => {
        calls.push({ table, op: 'upsert', args: [row, opts] })
        return result()
      },
      update: (patch: unknown) => {
        const chain = {
          eq: (col: string, v: unknown) => {
            calls.push({ table, op: 'update', args: [patch, col, v] })
            return Object.assign(result(), chain)
          },
          is: (col: string, v: unknown) => {
            calls.push({ table, op: 'is', args: [col, v] })
            return result()
          },
        }
        return chain
      },
    }),
  },
}))

import { useAssignments, withPendingStatus } from './useAssignments'
import { useMessages, visibleMessages, LOCAL_PREFIX } from './useMessages'
import { useIncidentShare } from './useIncidentShare'

function assignment(over: Partial<FieldAssignment> = {}): FieldAssignment {
  return {
    id: 'a1',
    incident_id: 'inc',
    asset_id: 'unit-1',
    assigned_user_id: null,
    created_by: 'ic',
    title: 'A',
    instructions: null,
    segment_geom: null,
    pattern_type: null,
    track_spacing_m: null,
    target_speed_kts: null,
    priority: 'normal',
    status: 'assigned',
    created_at: '2026-09-24T10:00:00Z',
    updated_at: '2026-09-24T10:00:00Z',
    ...over,
  }
}

beforeEach(() => {
  calls.length = 0
  failNext = null
  vi.stubGlobal('navigator', { onLine: true })
  getSessionImpl.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } })
  useAssignments.setState({ byIncident: {}, pending: [], failed: [], syncing: false, ownerId: 'u1' })
  useMessages.setState({
    byIncident: {}, outbox: [], receipts: [], failed: [], syncing: false, ownerId: 'u1',
  })
  useIncidentShare.setState({
    queue: [], unitIds: {}, unitOwner: null, sending: false, lastPublishedAt: 0,
  })
})

describe('assignment status queue', () => {
  it('writes only status, and refuses a step the field may not take', async () => {
    const a = assignment()
    useAssignments.setState({ byIncident: { inc: [a] } })
    expect(await useAssignments.getState().setStatus(a, 'searching')).toBe(true)
    expect(calls).toContainEqual({
      table: 'field_assignments',
      op: 'update',
      args: [{ status: 'searching' }, 'id', 'a1'],
    })
    expect(useAssignments.getState().byIncident.inc[0].status).toBe('searching')

    const done = assignment({ status: 'complete' })
    expect(await useAssignments.getState().setStatus(done, 'en_route')).toBe(false)
  })

  it('keeps a change queued with no signal and shows it anyway', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const a = assignment()
    useAssignments.setState({ byIncident: { inc: [a] } })
    await useAssignments.getState().setStatus(a, 'en_route')
    const s = useAssignments.getState()
    expect(s.pending).toHaveLength(1)
    expect(withPendingStatus(s.byIncident.inc, s.pending)[0].status).toBe('en_route')
    expect(calls).toHaveLength(0)
  })
})

describe('messages', () => {
  it('sends with the phone-made client_id and does nothing on a repeat', async () => {
    await useMessages.getState().send('inc', 'on scene', 'urgent')
    const up = calls.find((c) => c.table === 'field_messages' && c.op === 'upsert')!
    const [row, opts] = up.args as [Record<string, unknown>, Record<string, unknown>]
    expect(typeof row.client_id).toBe('string')
    expect(row).toMatchObject({ incident_id: 'inc', sender_id: 'u1', body: 'on scene', priority: 'urgent' })
    expect(row).not.toHaveProperty('id')
    expect(opts).toEqual({ onConflict: 'client_id', ignoreDuplicates: true })
    // Sent: it left the outbox and landed in the cache, still under a local id.
    const s = useMessages.getState()
    expect(s.outbox).toHaveLength(0)
    expect(s.byIncident.inc[0].id.startsWith(LOCAL_PREFIX)).toBe(true)
  })

  it('replies to the sender, in the thread', async () => {
    const original: FieldMessage = {
      id: 'm1', client_id: null, incident_id: 'inc', sender_id: 'ic',
      recipient_id: null, recipient_asset_id: 'unit-1', body: 'search A',
      priority: 'normal', thread_id: null, in_reply_to: null,
      delivered_at: null, read_at: null, created_at: '2026-09-24T10:00:00Z',
    }
    await useMessages.getState().send('inc', 'copy', 'normal', original)
    const [row] = calls.find((c) => c.op === 'upsert')!.args as [Record<string, unknown>]
    expect(row).toMatchObject({ recipient_id: 'ic', in_reply_to: 'm1', thread_id: 'm1' })
  })

  it('writes a read receipt only where none exists, and shows it at once', async () => {
    const m: FieldMessage = {
      id: 'm1', client_id: null, incident_id: 'inc', sender_id: 'ic',
      recipient_id: 'u1', recipient_asset_id: null, body: 'x', priority: 'normal',
      thread_id: null, in_reply_to: null, delivered_at: null, read_at: null,
      created_at: '2026-09-24T10:00:00Z',
    }
    useMessages.setState({ byIncident: { inc: [m] } })
    vi.stubGlobal('navigator', { onLine: false })
    useMessages.getState().markRead(m)
    const s = useMessages.getState()
    // Read implies delivered.
    expect(s.receipts.map((r) => r.field)).toEqual(['delivered_at', 'read_at'])
    const shown = visibleMessages(s.byIncident.inc, s.outbox, s.receipts, 'inc')[0]
    expect(shown.read_at).not.toBeNull()

    vi.stubGlobal('navigator', { onLine: true })
    await useMessages.getState().flush()
    expect(calls.filter((c) => c.op === 'is').map((c) => c.args[0])).toEqual([
      'delivered_at',
      'read_at',
    ])
    expect(useMessages.getState().receipts).toHaveLength(0)
  })
})

describe('unit registration (N4)', () => {
  it('attributes buffered fixes to the unit once it is registered', async () => {
    useIncidentShare.setState({
      queue: [
        {
          client_id: 'u1:1', incident_id: 'inc', lat: 29.5, lng: -94.8,
          heading_deg: null, speed_mps: null, accuracy_m: null, altitude_m: null,
          recorded_at: '2026-09-24T10:00:00Z', provider: 'navmate',
        },
      ],
    })
    const id = await useIncidentShare.getState().registerUnit('inc', 'boat-1')
    expect(id).toBe('unit-1')
    expect(calls[0]).toEqual({
      table: 'integ_register_unit',
      op: 'rpc',
      args: [{ p_incident_id: 'inc', p_vessel_id: 'boat-1' }],
    })
    // Let the flush it kicked off finish.
    await useIncidentShare.getState().flush()
    const up = calls.find((c) => c.table === 'asset_tracks' && c.op === 'upsert')!
    const [rows] = up.args as [Record<string, unknown>[]]
    expect(rows[0]).toMatchObject({ asset_id: 'unit-1', user_id: 'u1' })
  })
})
