/**
 * Unsent work kept per account when a different person signs in on the same
 * phone.
 *
 * Every queue in the app belongs to whoever recorded it, and it is only ever
 * sent under that person's sign-in (sending it as someone else would be
 * refused, or worse, credited to the wrong crew member). Before this, a
 * different sign-in cleared the local copy — queue included — so a clue or a
 * waypoint recorded out of signal was gone the moment the phone was handed
 * over. Now the unsent part is set aside under its owner, and comes back the
 * next time that person signs in on this phone.
 */

const PREFIX = 'navmate.stash.'

const key = (store: string, ownerId: string) => `${PREFIX}${store}.${ownerId}`

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** True when any of the lists holds something. */
export function hasUnsent(parts: Record<string, unknown>): boolean {
  return Object.values(parts).some((v) =>
    Array.isArray(v) ? v.length > 0 : v != null && typeof v === 'object' && Object.keys(v).length > 0,
  )
}

/**
 * Set aside a departing account's unsent lists. Lists already stashed for the
 * same account are kept and the new ones appended (arrays) or merged (objects).
 */
export function stashUnsent(store: string, ownerId: string | null, parts: Record<string, unknown>): void {
  if (!ownerId || !hasUnsent(parts)) return
  const s = storage()
  if (!s) return
  const existing = takeUnsent(store, ownerId) ?? {}
  const merged: Record<string, unknown> = { ...existing }
  for (const [k, v] of Object.entries(parts)) {
    const prev = existing[k]
    if (Array.isArray(v)) merged[k] = [...(Array.isArray(prev) ? prev : []), ...v]
    else if (v && typeof v === 'object') merged[k] = { ...((prev as object) ?? {}), ...(v as object) }
    else merged[k] = v
  }
  try {
    s.setItem(key(store, ownerId), JSON.stringify(merged))
  } catch (e) {
    // Full: better to keep the departing account's work than the newcomer's
    // empty slate — the caller then leaves the local copy alone.
    throw new Error(`could not set aside unsent ${store}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Take back (and remove) what was set aside for this account, or null. */
export function takeUnsent(store: string, ownerId: string | null): Record<string, unknown> | null {
  if (!ownerId) return null
  const s = storage()
  if (!s) return null
  const raw = s.getItem(key(store, ownerId))
  if (!raw) return null
  s.removeItem(key(store, ownerId))
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Arrays from a stash, with nothing assumed about their contents. */
export function listOf<T>(parts: Record<string, unknown> | null, name: string): T[] {
  const v = parts?.[name]
  return Array.isArray(v) ? (v as T[]) : []
}

/** An object map from a stash. */
export function mapOf<T>(parts: Record<string, unknown> | null, name: string): Record<string, T> {
  const v = parts?.[name]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {}
}

/**
 * A different account has signed in on this phone: set the departing one's
 * unsent lists aside, then let the caller clear the local copy.
 * Returns false (and leaves everything as it was) when they could not be set
 * aside — the caller must then not clear, so nothing is lost.
 */
export function setAsideFor(store: string, ownerId: string | null, parts: Record<string, unknown>): boolean {
  try {
    stashUnsent(store, ownerId, parts)
    return true
  } catch (e) {
    console.warn(e instanceof Error ? e.message : String(e))
    return false
  }
}

/** A list taken back from a stash, put in front of the current one (same type). */
export function prependFrom<T>(parts: Record<string, unknown> | null, name: string, current: T[]): T[] {
  return [...listOf<T>(parts, name), ...current]
}
