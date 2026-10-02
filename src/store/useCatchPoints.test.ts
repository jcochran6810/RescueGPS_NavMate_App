import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: { table: string; op: string; args: unknown[] }[] = []
let failNext: unknown = null
const getSessionImpl = vi.fn()

vi.mock('@/lib/supabase', () => ({
  errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e),
  supabase: {
    auth: { getSession: (...a: unknown[]) => getSessionImpl(...a) },
    from: (table: string) => ({
      upsert: (row: unknown, opts: unknown) => {
        calls.push({ table, op: 'upsert', args: [row, opts] })
        const error = failNext
        failNext = null
        return Promise.resolve({ error })
      },
    }),
  },
}))

import { useCatchPoints, visibleCatchPoints } from './useCatchPoints'
import { buildIncidentLayer } from '@/lib/command'

describe('catch points from the field (NW5)', () => {
  beforeEach(() => {
    calls.length = 0
    failNext = null
    vi.stubGlobal('navigator', { onLine: true })
    getSessionImpl.mockResolvedValue({ data: { session: { user: { id: 'crew-1' } } } })
    useCatchPoints.getState().clearLocal()
  })

  it('reports at the position, as the crew, idempotently', async () => {
    const p = await useCatchPoints.getState().report('inc', { kind: 'strainer', lat: 38.9, lon: -78.2, notes: ' downed tree ' })
    expect(p).not.toBeNull()
    expect(calls).toHaveLength(1)
    const [row, opts] = calls[0].args as [Record<string, unknown>, Record<string, unknown>]
    expect(calls[0].table).toBe('catch_points')
    expect(row).toMatchObject({ kind: 'strainer', lat: 38.9, lng: -78.2, source: 'field', reported_by: 'crew-1', notes: 'downed tree' })
    expect(row.client_id).toBe(row.id)
    expect(opts).toEqual({ onConflict: 'id', ignoreDuplicates: true })
    expect(useCatchPoints.getState().outbox).toHaveLength(0)
    expect(useCatchPoints.getState().byIncident.inc).toHaveLength(1)
  })

  it('a database without the table refuses it: kept for three tries, then failed with the reason', async () => {
    const terminal = { code: '42P01', message: 'relation "catch_points" does not exist' }
    failNext = terminal
    await useCatchPoints.getState().report('inc', { kind: 'eddy', lat: 1, lon: 2 })
    expect(useCatchPoints.getState().outbox).toHaveLength(1)
    failNext = terminal
    await useCatchPoints.getState().flush()
    failNext = terminal
    await useCatchPoints.getState().flush()
    expect(useCatchPoints.getState().outbox).toHaveLength(0)
    expect(useCatchPoints.getState().failed[0].reason).toMatch(/catch_points/)
  })

  it('shows queued and cached points, never deleted ones, and draws them', () => {
    const base = { incident_id: 'inc', label: null, notes: null, source: 'field' as const, lat: 30, lng: -90, reported_by: 'x', created_at: 't' }
    const list = visibleCatchPoints(
      [{ ...base, id: 'a', kind: 'snag', deleted_at: null }, { ...base, id: 'b', kind: 'eddy', deleted_at: 'gone' }],
      [{ point: { ...base, id: 'c', kind: 'log_jam', deleted_at: null } }],
      'inc',
    )
    expect(list.map((p) => p.id)).toEqual(['c', 'a'])
    const layer = buildIncidentLayer({ assignments: [], areas: [], hazards: [], lkp: null, userId: null, unitId: null, nowMs: 0, catchPoints: list })
    expect(layer.catchPoints?.map((c) => c.label)).toEqual(['Log jam', 'Snag'])
  })
})
