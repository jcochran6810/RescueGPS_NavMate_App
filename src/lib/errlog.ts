import { supabase } from './supabase'

/**
 * Best-effort runtime error reporting into `app_errors`, where the platform
 * admin dashboard counts and reads them.
 *
 * Deliberately quiet about its own failures: an error logger that throws, or
 * that queues while offline, would turn one problem into two. If the insert
 * cannot happen right now the report is simply dropped — the console still
 * has it, and the dashboard's numbers are counts of what got through, which
 * the UI labels honestly.
 */

/** Reports per session, so an error loop cannot flood the table. */
const MAX_REPORTS = 20
/** Suppress duplicates within this window. */
const DEDUPE_MS = 60_000

let sent = 0
const recent = new Map<string, number>()

export async function reportError(
  message: string,
  options: {
    stack?: string
    severity?: 'warn' | 'error' | 'fatal'
    route?: string
    context?: Record<string, unknown>
  } = {},
): Promise<void> {
  try {
    if (sent >= MAX_REPORTS) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return

    const key = message.slice(0, 200)
    const last = recent.get(key)
    const now = Date.now()
    if (last !== undefined && now - last < DEDUPE_MS) return
    recent.set(key, now)

    const uid = (await supabase.auth.getSession()).data.session?.user?.id
    if (!uid) return

    sent += 1
    await supabase.from('app_errors').insert({
      user_id: uid,
      message: String(message).slice(0, 2000),
      stack: (options.stack ?? '').slice(0, 8000),
      severity: options.severity ?? 'error',
      route: (options.route ?? '').slice(0, 200),
      context: options.context ?? {},
    })
  } catch {
    // Never let the logger become the problem.
  }
}

/** Wire window-level handlers once, from App. Returns the teardown. */
export function installErrorReporting(): () => void {
  const onError = (e: ErrorEvent) => {
    void reportError(e.message || 'Unhandled error', {
      stack: e.error instanceof Error ? (e.error.stack ?? '') : '',
      severity: 'error',
      route: window.location.hash || window.location.pathname,
    })
  }
  const onRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason
    void reportError(
      reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection'),
      {
        stack: reason instanceof Error ? (reason.stack ?? '') : '',
        severity: 'error',
        route: window.location.hash || window.location.pathname,
      },
    )
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
