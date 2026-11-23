/**
 * Height above sea level from a GPS altitude.
 *
 * Android (Chrome and the NavMate app) reports altitude as height above the
 * WGS84 **ellipsoid** — a smooth mathematical Earth — not above the sea. The
 * two differ by the geoid height N, which on the Texas coast is about −28 m:
 * the sea sits 28 m *below* the ellipsoid there. So a phone at the waterline
 * in Galveston read about −27 m, and a crew saw themselves 21 m under water.
 *
 *     height above sea level = ellipsoid height − N
 *
 * N comes from EGM96 on a 1° grid (`geoidData.ts`), bilinearly interpolated.
 * It is ~0.5 m rms from the full model over the US — far inside the 5–15 m a
 * phone's vertical fix is good for.
 *
 * iPhone/iPad Safari already report height above sea level (Core Location's
 * `altitude` is MSL), so correcting them again would put them 28 m too high.
 */
import { GEOID_1DEG_B64 } from './geoidData'

const ROWS = 181
const COLS = 360

let grid: Int8Array | null = null

function load(): Int8Array {
  if (grid) return grid
  const bin = atob(GEOID_1DEG_B64)
  const g = new Int8Array(bin.length)
  for (let i = 0; i < bin.length; i++) g[i] = (bin.charCodeAt(i) << 24) >> 24
  grid = g
  return g
}

/** EGM96 geoid height N, metres above the WGS84 ellipsoid (negative = sea below it). */
export function geoidHeight(lat: number, lon: number): number | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null
  const g = load()
  const y = 90 - lat
  const x = ((lon % 360) + 360) % 360
  const i = Math.min(Math.floor(y), ROWS - 2)
  const j = Math.floor(x) % COLS
  const j1 = (j + 1) % COLS
  const fy = y - i
  const fx = x - Math.floor(x)
  const at = (r: number, c: number) => g[r * COLS + c]
  return (
    at(i, j) * (1 - fx) * (1 - fy) +
    at(i, j1) * fx * (1 - fy) +
    at(i + 1, j) * (1 - fx) * fy +
    at(i + 1, j1) * fx * fy
  )
}

/** Does this browser report altitude above the ellipsoid (true) or above sea level? */
export function reportsEllipsoidHeight(userAgent: string, maxTouchPoints = 0): boolean {
  const ios =
    /iPhone|iPad|iPod/.test(userAgent) ||
    (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
  return !ios
}

let ellipsoidCache: boolean | null = null
function deviceReportsEllipsoid(): boolean {
  if (ellipsoidCache === null) {
    ellipsoidCache =
      typeof navigator === 'undefined'
        ? true
        : reportsEllipsoidHeight(navigator.userAgent, navigator.maxTouchPoints)
  }
  return ellipsoidCache
}

/**
 * The receiver's altitude as height above sea level. Pass `ellipsoid` to
 * override the device detection (tests, or a source known to be one or the other).
 */
export function seaLevelAltitude(
  altitude: number | null | undefined,
  lat: number,
  lon: number,
  ellipsoid: boolean = deviceReportsEllipsoid(),
): number | null {
  if (altitude == null || !Number.isFinite(altitude)) return null
  if (!ellipsoid) return altitude
  const n = geoidHeight(lat, lon)
  return n == null ? altitude : altitude - n
}
