/**
 * Retrying the Supabase calls that are worth retrying, and saying something
 * useful about the ones that are not.
 *
 * The case this exists for: PostgREST answers before Postgres is ready — while
 * a paused project wakes, or across a database restart — and returns
 *
 *     PGRST002  Could not query the database for the schema cache. Retrying.
 *
 * That is the API telling us it is about to fix itself. Showing it to a crew
 * verbatim and stopping is the wrong response twice over: the words are
 * PostgREST's internals rather than anything actionable, and the operation
 * would have worked on the second attempt.
 *
 * What is deliberately *not* retried is a genuine loss of signal. The app
 * already queues writes for that, and spending seven seconds retrying before
 * admitting there is no network only delays the truth.
 */

/** Attempt delays in milliseconds. Four tries over about seven seconds. */
const BACKOFF_MS = [1000, 2000, 4000]

/**
 * PostgREST codes meaning "the API is up but the database is not reachable
 * yet". All three clear on their own.
 */
const TRANSIENT_CODES = new Set(['PGRST000', 'PGRST001', 'PGRST002'])

/** Gateway statuses that mean the request never reached the database. */
const TRANSIENT_STATUS = new Set([502, 503, 504])

interface Errorish {
  code?: unknown
  status?: unknown
  message?: unknown
  error_description?: unknown
  name?: unknown
}

function asErrorish(error: unknown): Errorish {
  return error && typeof error === 'object' ? (error as Errorish) : {}
}

function textOf(error: unknown): string {
  if (typeof error === 'string') return error
  const e = asErrorish(error)
  if (typeof e.message === 'string') return e.message
  if (typeof e.error_description === 'string') return e.error_description
  return ''
}

/** True when the database could not be reached and it is worth going again. */
export function isTransient(error: unknown): boolean {
  if (!error) return false
  const e = asErrorish(error)

  if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true
  if (typeof e.status === 'number' && TRANSIENT_STATUS.has(e.status)) return true

  // PostgREST does not always attach a code to the body the client surfaces,
  // so the sentence itself is the last resort.
  const text = textOf(error).toLowerCase()
  return text.includes('schema cache') && text.includes('retrying')
}

/** True when the request never left the device — no signal, not a server fault. */
export function isOffline(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const e = asErrorish(error)
  const text = textOf(error).toLowerCase()
  return (
    e.name === 'TypeError' &&
    (text.includes('failed to fetch') ||
      text.includes('networkerror') ||
      text.includes('load failed'))
  )
}

/**
 * A Supabase error as a sentence a crew can act on.
 *
 * Everything that is not one of the known shapes falls through unchanged —
 * inventing friendlier wording for an error nobody has seen yet would only
 * hide it.
 */
export function describeError(error: unknown): string {
  if (!error) return 'Unknown error'

  if (isOffline(error)) {
    return 'No connection to the server. Check your signal and try again.'
  }
  if (isTransient(error)) {
    return (
      'The database is still waking up. This normally clears within a minute — ' +
      'try again shortly.'
    )
  }

  const text = textOf(error)
  return text || 'Unknown error'
}

/** Shape every supabase-js call resolves to. */
export interface Answer<T> {
  data: T
  error: unknown
}

export interface RetryOptions {
  /** Swap in for tests, so a retry does not take seven real seconds. */
  sleep?: (ms: number) => Promise<void>
  /** Delays between attempts. One fewer entry than the number of attempts. */
  backoffMs?: number[]
  /** Called before each wait, for a "still trying" message. */
  onRetry?: (attempt: number, error: unknown) => void
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run a Supabase call, repeating it while the failure is transient.
 *
 * Returns the last answer either way, so callers keep the `{ data, error }`
 * shape they already handle and nothing has to learn to catch.
 */
export async function retrying<T>(
  attempt: () => PromiseLike<Answer<T>>,
  options: RetryOptions = {},
): Promise<Answer<T>> {
  const { sleep = realSleep, backoffMs = BACKOFF_MS, onRetry } = options

  let answer = await attempt()
  for (let i = 0; i < backoffMs.length; i++) {
    if (!answer.error || !isTransient(answer.error)) return answer
    onRetry?.(i + 1, answer.error)
    await sleep(backoffMs[i])
    answer = await attempt()
  }
  return answer
}
