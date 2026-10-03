import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Nothing recorded in the field is lost with the phone, or with the next
 * person who signs in on it:
 *   - a different sign-in sets the departing account's unsent work aside and
 *     gives it back when that account returns;
 *   - a river-segment mark made out of signal is kept and sent later;
 *   - a subject description the server keeps refusing is set aside without
 *     blocking the others;
 *   - a clue photo taken out of signal is kept on the phone.
 */

vi.hoisted(() => {
  // Node test environment: a plain in-memory localStorage.
  const m = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = ls
})

const calls: { table: string; op: string; args: unknown[] }[] = []
let failWith: unknown = null
let session: { user: { id: string } } | null = { user: { id: 'user-a' } }

function result(data: unknown = null) {
  const error = failWith
  return Promise.resolve({ data, error })
}

vi.mock('@/lib/supabase', () => ({
  PHOTO_BUCKET: 'waypoint-photos',
  errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e),
  supabase: {
    auth: { getSession: () => Promise.resolve({ data: { session } }) },
    storage: {
      from: () => ({
        upload: (path: string) => {
          calls.push({ table: 'storage', op: 'upload', args: [path] })
          return Promise.resolve({ error: failWith })
        },
      }),
    },
    from: (table: string) => {
      const chain = {
        select: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (col: string, v: unknown) => {
          calls.push({ table, op: 'eq', args: [col, v] })
          return Object.assign(result(), chain)
        },
        maybeSingle: () => result(null),
        update: (patch: unknown) => {
          calls.push({ table, op: 'update', args: [patch] })
          return chain
        },
        insert: (row: unknown) => {
          calls.push({ table, op: 'insert', args: [row] })
          return result()
        },
        upsert: (row: unknown) => {
          calls.push({ table, op: 'upsert', args: [row] })
          return result()
        },
        then: (f: (v: unknown) => unknown) => result([]).then(f),
      }
      return chain
    },
  },
}))

import { setAsideFor, takeUnsent, hasUnsent, prependFrom } from '@/lib/accountStash'
import { useSarRecords } from './useSarRecords'
import { useSearchAreas } from './useSearchAreas'
import { useVictims } from './useVictims'
import { EMPTY_VICTIM } from '@/lib/victim'
import { listStashed, removeStashed } from '@/lib/photoStash'

beforeEach(() => {
  calls.length = 0
  failWith = null
  session = { user: { id: 'user-a' } }
  localStorage.clear()
  vi.stubGlobal('navigator', { onLine: true })
})

describe('account stash', () => {
  it('sets aside and gives back per account', () => {
    expect(hasUnsent({ pending: [], failed: [] })).toBe(false)
    expect(setAsideFor('sar', 'user-a', { pending: [{ id: 1 }], failed: [] })).toBe(true)
    expect(takeUnsent('sar', 'user-b')).toBeNull()
    const back = takeUnsent('sar', 'user-a')
    expect(prependFrom(back, 'pending', [{ id: 2 }])).toEqual([{ id: 1 }, { id: 2 }])
    // Taken once.
    expect(takeUnsent('sar', 'user-a')).toBeNull()
  })

  it('a different sign-in does not lose the queue, and its owner gets it back', async () => {
    const rec = {
      id: 'r1', kind: 'clue', lat: 1, lon: 2, recorded_at: '2026-10-03T10:00:00Z', payload: {}, note: '',
      team_id: null, incident_id: 'inc', user_id: 'user-a', created_at: '2026-10-03T10:00:00Z',
    }
    useSarRecords.setState({ ownerId: 'user-a', pending: [{ kind: 'create', record: rec } as never], failed: [], cache: [] })
    vi.stubGlobal('navigator', { onLine: false })
    session = { user: { id: 'user-b' } }
    await useSarRecords.getState().load()
    expect(useSarRecords.getState().pending).toHaveLength(0)
    expect(useSarRecords.getState().ownerId).toBe('user-b')

    session = { user: { id: 'user-a' } }
    await useSarRecords.getState().load()
    expect(useSarRecords.getState().ownerId).toBe('user-a')
    expect(useSarRecords.getState().pending).toHaveLength(1)
  })
})

describe('river segment marks', () => {
  const area = { id: 'seg-1', incident_id: 'inc', name: 'Segment 1' } as never

  it('keeps a mark made out of signal and sends it later', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    useSearchAreas.setState({ pendingMarks: [], byIncident: {} })
    const r = await useSearchAreas.getState().markSegment(area, 'negative')
    expect(r).toEqual({ ok: true, queued: true })
    expect(useSearchAreas.getState().pendingMarks).toHaveLength(1)
    expect(calls.filter((c) => c.table === 'search_areas')).toHaveLength(0)

    vi.stubGlobal('navigator', { onLine: true })
    await useSearchAreas.getState().flushMarks()
    expect(useSearchAreas.getState().pendingMarks).toHaveLength(0)
    expect(calls.some((c) => c.table === 'search_areas' && c.op === 'update')).toBe(true)
  })

  it("never sends another account's mark", async () => {
    useSearchAreas.setState({
      pendingMarks: [{ areaId: 'seg-1', incidentId: 'inc', patch: { status: 'x' }, ownerId: 'user-z', attempts: 0 }],
    })
    await useSearchAreas.getState().flushMarks()
    expect(useSearchAreas.getState().pendingMarks).toHaveLength(1)
    expect(calls.filter((c) => c.table === 'search_areas')).toHaveLength(0)
  })
})

describe('subject description', () => {
  it('a refused one is set aside after three tries and does not block the others', async () => {
    useVictims.setState({
      drafts: { a: { ...EMPTY_VICTIM, name: 'A' }, b: { ...EMPTY_VICTIM, name: 'B' } },
      pending: ['a', 'b'],
      attempts: {},
      failed: [],
      syncing: false,
    })
    failWith = { code: '42501', message: 'permission denied' }
    for (let i = 0; i < 3; i++) await useVictims.getState().flush()
    const s = useVictims.getState()
    expect(s.pending).toEqual([])
    expect(s.failed.map((f) => f.incidentId).sort()).toEqual(['a', 'b'])
    expect(s.drafts.a).toBeTruthy()

    failWith = null
    await useVictims.getState().retryFailed()
    expect(useVictims.getState().failed).toEqual([])
    expect(useVictims.getState().pending).toEqual([])
  })

  it('no signal keeps it queued without counting a try', async () => {
    useVictims.setState({ drafts: { a: { ...EMPTY_VICTIM, name: 'A' } }, pending: ['a'], attempts: {}, failed: [], syncing: false })
    failWith = Object.assign(new TypeError('Failed to fetch'), {})
    await useVictims.getState().flush()
    expect(useVictims.getState().pending).toEqual(['a'])
    expect(useVictims.getState().attempts).toEqual({})
  })
})

describe('clue photo out of signal', () => {
  it('is kept on the phone instead of dropped', async () => {
    const rec = {
      id: 'r2', kind: 'clue', lat: 1, lon: 2, recorded_at: '2026-10-03T10:00:00Z', payload: {}, note: '',
      team_id: null, incident_id: 'inc', user_id: 'user-a', created_at: '2026-10-03T10:00:00Z',
    }
    useSarRecords.setState({ ownerId: 'user-a', cache: [rec as never], pending: [], failed: [] })
    vi.stubGlobal('navigator', { onLine: false })
    const file = new File(['x'], 'clue.jpg', { type: 'image/jpeg' })
    const r = await useSarRecords.getState().attachPhoto('r2', file)
    expect(r).toBe('queued')
    const kept = await listStashed('sar')
    expect(kept.map((k) => k.targetId)).toContain('r2')
    await removeStashed(kept.map((k) => k.id))
  })
})
