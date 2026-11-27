import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Saving a callsign failed for every user with "null value in column email of
 * relation profiles violates not-null constraint": an upsert's insert half is
 * checked for NOT NULL before Postgres sees the conflict. The save now updates
 * the existing row, and only inserts (with the email) when there is none.
 */
const calls: { op: string; payload?: unknown }[] = []
let existing: Record<string, unknown> | null = null

function table() {
  const q: Record<string, unknown> = {}
  let op = ''
  let payload: unknown
  q.update = (p: unknown) => ((op = 'update'), (payload = p), q)
  q.insert = (p: unknown) => ((op = 'insert'), (payload = p), q)
  q.upsert = (p: unknown) => ((op = 'upsert'), (payload = p), q)
  q.eq = () => q
  q.select = () => q
  const finish = async () => {
    calls.push({ op, payload })
    if (op === 'upsert') {
      return { data: null, error: { message: 'null value in column "email"' } }
    }
    if (op === 'update') {
      return { data: existing ? { ...existing, ...(payload as object) } : null, error: null }
    }
    return { data: { ...(payload as object) }, error: null }
  }
  q.maybeSingle = finish
  q.single = finish
  return q
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => table(), auth: { getSession: vi.fn(), onAuthStateChange: vi.fn() } },
  errorMessage: (e: { message: string }) => e.message,
}))

const { useAuth } = await import('./useAuth')

beforeEach(() => {
  calls.length = 0
  useAuth.setState({
    user: { id: 'u1', email: 'crew@example.com' } as never,
    profile: null,
  })
})

describe('updateProfile', () => {
  it('updates an existing profile without needing its email', async () => {
    existing = { id: 'u1', email: 'crew@example.com', call_sign: null }
    const res = await useAuth.getState().updateProfile({ call_sign: 'JCochran' })
    expect(res.error).toBeUndefined()
    expect(calls.map((c) => c.op)).toEqual(['update'])
    expect(useAuth.getState().profile?.call_sign).toBe('JCochran')
  })

  it('creates a missing profile with the email the table requires', async () => {
    existing = null
    const res = await useAuth.getState().updateProfile({ call_sign: 'JCochran' })
    expect(res.error).toBeUndefined()
    expect(calls.map((c) => c.op)).toEqual(['update', 'insert'])
    expect(calls[1].payload).toMatchObject({ id: 'u1', email: 'crew@example.com', call_sign: 'JCochran' })
  })
})
