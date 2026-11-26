/**
 * Which build of NavMate this is, and whether a newer one is out.
 *
 * Every build carries the commit it was made from (`__APP_SHA__`), and the
 * website publishes the commit it is serving at `/version.json`. The website
 * and the Android APK are both built from each push of `main`, so "the live
 * site is on a different commit than me" means "a newer version is out".
 */
import { PUBLIC_ORIGIN, appOrigin } from './native'

export const APP_SHA: string = typeof __APP_SHA__ === 'string' ? __APP_SHA__ : 'dev'
export const APP_BUILT_AT: string | null =
  typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : null
export const APP_VERSION: string | null =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null

/** Where the newest Android APK is published. */
export const ANDROID_RELEASES_URL =
  'https://github.com/jcochran6810/RescueGPS_NavMate_App/releases/latest'

/** "1.0.10 · 24 Nov 2026 · fdc2f4a" — what Help shows. */
export function versionLabel(
  version: string | null = APP_VERSION,
  sha: string = APP_SHA,
  builtAt: string | null = APP_BUILT_AT,
): string {
  const parts: string[] = []
  if (version) parts.push(version)
  if (builtAt) {
    const d = new Date(builtAt)
    if (!Number.isNaN(d.getTime())) {
      parts.push(
        d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
      )
    }
  }
  if (sha && sha !== 'dev') parts.push(sha.slice(0, 7))
  return parts.length ? parts.join(' · ') : 'development build'
}

/**
 * Is the live build newer than this one? Unknown (no answer, a dev build, a
 * malformed file) is never "newer" — a false alarm teaches people to ignore
 * the banner.
 */
export function isNewer(live: unknown, mine: string = APP_SHA): boolean {
  if (!mine || mine === 'dev') return false
  if (!live || typeof live !== 'object') return false
  const sha = (live as { sha?: unknown }).sha
  return typeof sha === 'string' && sha.length >= 7 && sha !== 'dev' && sha !== mine
}

/** Ask the live site which build it is serving. Null when it cannot be reached. */
export async function fetchLiveVersion(
  origin: string = appOrigin() || PUBLIC_ORIGIN,
): Promise<{ sha: string; builtAt?: string } | null> {
  try {
    const res = await fetch(`${origin}/version.json?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'omit',
    })
    if (!res.ok) return null
    const body = (await res.json()) as { sha?: unknown; builtAt?: unknown }
    return typeof body.sha === 'string'
      ? { sha: body.sha, builtAt: typeof body.builtAt === 'string' ? body.builtAt : undefined }
      : null
  } catch {
    return null
  }
}
