import { describe, it, expect, vi } from 'vitest'
import { isTransient, isOffline, describeError, retrying } from './retry'

/** The body PostgREST returns while it cannot reach Postgres. */
const SCHEMA_CACHE = {
  code: 'PGRST002',
  message: 'Could not query the database for the schema cache. Retrying.',
  details: null,
  hint: null,
}

const noSleep = () => Promise.resolve()

describe('isTransient', () => {
  it('recognises the schema cache error by code', () => {
    expect(isTransient(SCHEMA_CACHE)).toBe(true)
  })

  it('recognises it by its wording when no code came through', () => {
    expect(
      isTransient({
        message: 'Could not query the database for the schema cache. Retrying.',
      }),
    ).toBe(true)
  })

  it('recognises the other connection codes', () => {
    expect(isTransient({ code: 'PGRST000' })).toBe(true)
    expect(isTransient({ code: 'PGRST001' })).toBe(true)
  })

  it('recognises a gateway that never reached the database', () => {
    expect(isTransient({ status: 503 })).toBe(true)
    expect(isTransient({ status: 504 })).toBe(true)
  })

  it('does not retry a refusal', () => {
    // A row level security refusal is a decision, not a hiccup. Retrying it
    // would hammer the API to arrive at the same answer.
    expect(
      isTransient({
        code: '42501',
        message: 'new row violates row-level security policy',
      }),
    ).toBe(false)
  })

  it('does not retry a statement timeout', () => {
    // A query too slow once is too slow again; retrying only adds load.
    expect(isTransient({ code: 'PGRST003' })).toBe(false)
  })

  it('does not retry a bad request or a not-found', () => {
    expect(isTransient({ status: 400 })).toBe(false)
    expect(isTransient({ status: 404 })).toBe(false)
    expect(isTransient({ code: 'PGRST202', message: 'function not found' })).toBe(false)
  })

  it('is false for no error at all', () => {
    expect(isTransient(null)).toBe(false)
    expect(isTransient(undefined)).toBe(false)
  })

  it('survives an error of an unexpected shape', () => {
    expect(isTransient('some string')).toBe(false)
    expect(isTransient(42)).toBe(false)
    expect(isTransient({})).toBe(false)
  })
})

describe('isOffline', () => {
  it('recognises a failed fetch', () => {
    const err = new TypeError('Failed to fetch')
    expect(isOffline(err)).toBe(true)
  })

  it('recognises the Safari and Firefox wordings', () => {
    expect(isOffline(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true)
    expect(isOffline(new TypeError('Load failed'))).toBe(true)
  })

  it('does not mistake a server error for being offline', () => {
    expect(isOffline(SCHEMA_CACHE)).toBe(false)
  })
})

describe('describeError', () => {
  it('explains the waking database in words a crew can act on', () => {
    const text = describeError(SCHEMA_CACHE)
    expect(text).toMatch(/waking up/i)
    expect(text).not.toMatch(/schema cache/i)
  })

  it('explains a lost connection', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/connection/i)
  })

  it('passes an unrecognised error through untouched', () => {
    // Inventing kinder wording for an unknown failure would only hide it.
    expect(describeError({ message: 'duplicate key value violates unique constraint' })).toBe(
      'duplicate key value violates unique constraint',
    )
  })

  it('handles nothing at all', () => {
    expect(describeError(null)).toBe('Unknown error')
    expect(describeError({})).toBe('Unknown error')
  })
})

describe('retrying', () => {
  it('does not retry a call that worked', async () => {
    const attempt = vi.fn().mockResolvedValue({ data: 'ok', error: null })
    const answer = await retrying(attempt, { sleep: noSleep })
    expect(answer.data).toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('retries a waking database and returns the eventual success', async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: SCHEMA_CACHE })
      .mockResolvedValueOnce({ data: null, error: SCHEMA_CACHE })
      .mockResolvedValue({ data: { id: 't1' }, error: null })

    const answer = await retrying(attempt, { sleep: noSleep })
    expect(answer.error).toBeNull()
    expect(answer.data).toEqual({ id: 't1' })
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('gives up after the last attempt and hands back the failure', async () => {
    const attempt = vi.fn().mockResolvedValue({ data: null, error: SCHEMA_CACHE })
    const answer = await retrying(attempt, { sleep: noSleep })
    expect(answer.error).toBe(SCHEMA_CACHE)
    // Three backoff delays means four attempts in total.
    expect(attempt).toHaveBeenCalledTimes(4)
  })

  it('does not retry an error that will not fix itself', async () => {
    const denied = { code: '42501', message: 'row-level security' }
    const attempt = vi.fn().mockResolvedValue({ data: null, error: denied })
    const answer = await retrying(attempt, { sleep: noSleep })
    expect(answer.error).toBe(denied)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('waits longer between each attempt', async () => {
    const waits: number[] = []
    const attempt = vi.fn().mockResolvedValue({ data: null, error: SCHEMA_CACHE })
    await retrying(attempt, {
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })
    expect(waits).toEqual([1000, 2000, 4000])
  })

  it('reports each retry so the UI can say it is still trying', async () => {
    const seen: number[] = []
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: SCHEMA_CACHE })
      .mockResolvedValue({ data: 'ok', error: null })
    await retrying(attempt, { sleep: noSleep, onRetry: (n) => seen.push(n) })
    expect(seen).toEqual([1])
  })

  it('honours a caller-supplied backoff', async () => {
    const attempt = vi.fn().mockResolvedValue({ data: null, error: SCHEMA_CACHE })
    await retrying(attempt, { sleep: noSleep, backoffMs: [10] })
    expect(attempt).toHaveBeenCalledTimes(2)
  })
})
