import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Waypoint } from '@/lib/types'

/**
 * Regression tests for the offline queue's failure modes:
 *
 * 1. Ops appended while a flush is awaiting the network must survive the
 *    flush — losing them meant a second quick "Stamp my position" vanished.
 * 2. An op the server refuses outright (RLS, bad row) must stop blocking the
 *    queue after bounded retries, and be set aside where the UI can show it.
 * 3. A queue written by one account must never be replayed under another
 *    account's session.
 */

const upsertImpl = vi.fn<(row: unknown) => Promise<{ error: unknown }>>()
const getSessionImpl = vi.fn()

vi.mock('@/lib/supabase', () => ({
  PHOTO_BUCKET: 'waypoint-photos',
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e),
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => getSessionImpl(...args),
    },
    from: () => ({
      upsert: (row: unknown) => upsertImpl(row),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      select: () => ({
        order: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
    storage: {
      from: () => ({
        remove: () => Promise.resolve({ error: null }),
        upload: () => Promise.resolve({ error: null }),
        createSignedUrl: () => Promise.resolve({ data: null, error: 'no' }),
      }),
    },
  },
}))

import { useWaypoints, type PendingOp } from './useWaypoints'

function waypoint(id: string, over: Partial<Waypoint> = {}): Waypoint {
  return {
    id,
    user_id: 'u1',
    team_id: null,
    name: id,
    lat: 30,
    lon: -95,
    note: '',
    photos: [],
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

const createOp = (id: string): PendingOp => ({
  kind: 'create',
  waypoint: waypoint(id),
})

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  upsertImpl.mockReset()
  getSessionImpl.mockReset()
  getSessionImpl.mockResolvedValue({
    data: { session: { user: { id: 'u1' } } },
  })
  useWaypoints.setState({
    cache: [],
    pending: [],
    failed: [],
    syncing: false,
    loading: false,
    ownerId: 'u1',
  })
})

describe('flush', () => {
  it('keeps ops appended while a flush is in flight', async () => {
    // First upsert blocks until we let it finish, simulating a slow link.
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve))
    upsertImpl.mockImplementation(async () => {
      await gate
      return { error: null }
    })

    useWaypoints.setState({ pending: [createOp('a1')] })
    const flushing = useWaypoints.getState().flush()

    // A second stamp lands while the first is still uploading.
    await Promise.resolve() // let flush pass its early-return checks
    useWaypoints.setState({
      pending: [...useWaypoints.getState().pending, createOp('a2')],
    })

    releaseFirst()
    await flushing

    const ids = useWaypoints
      .getState()
      .pending.map((op) => (op.kind === 'create' ? op.waypoint.id : ''))
    expect(ids).toContain('a2')
    expect(ids).not.toContain('a1')
  })

  it('sets a permanently refused op aside after bounded retries and drains the rest', async () => {
    const rlsError = { code: '42501', message: 'row-level security' }
    upsertImpl.mockImplementation(async (row) => {
      const r = row as { id: string }
      return r.id === 'bad' ? { error: rlsError } : { error: null }
    })

    useWaypoints.setState({ pending: [createOp('bad'), createOp('ok')] })

    // Three flushes: two bounded retries, then the op is set aside and the
    // one behind it finally syncs.
    await useWaypoints.getState().flush()
    expect(useWaypoints.getState().pending).toHaveLength(2)
    await useWaypoints.getState().flush()
    expect(useWaypoints.getState().pending).toHaveLength(2)
    await useWaypoints.getState().flush()

    const s = useWaypoints.getState()
    expect(s.pending).toHaveLength(0)
    expect(s.failed).toHaveLength(1)
    expect(s.failed[0].op.kind).toBe('create')
  })

  it('does not replay a queue under a different account', async () => {
    getSessionImpl.mockResolvedValue({
      data: { session: { user: { id: 'someone-else' } } },
    })
    useWaypoints.setState({ pending: [createOp('a1')], ownerId: 'u1' })

    await useWaypoints.getState().flush()

    expect(upsertImpl).not.toHaveBeenCalled()
    expect(useWaypoints.getState().pending).toHaveLength(1)
  })

  it('retryFailed puts refused ops back at the head of the queue', async () => {
    upsertImpl.mockResolvedValue({ error: null })
    useWaypoints.setState({
      failed: [
        {
          op: { ...createOp('bad'), attempts: 3 },
          reason: 'refused',
          failedAt: '2026-08-05T00:00:00.000Z',
        },
      ],
    })

    await useWaypoints.getState().retryFailed()

    const s = useWaypoints.getState()
    expect(s.failed).toHaveLength(0)
    expect(s.pending).toHaveLength(0) // synced on the retry flush
    expect(upsertImpl).toHaveBeenCalledTimes(1)
  })
})
