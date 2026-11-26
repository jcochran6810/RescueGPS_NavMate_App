/**
 * Steadying the GPS height.
 *
 * A phone's vertical fix is three to five times worse than its horizontal one,
 * and indoors — signals bouncing off floors and walls — a single reading can
 * be 100 m out. Shown one reading at a time, a crew on a third floor watched
 * their height swing between 40 and 350 ft. The horizontal track filter never
 * touched altitude; this is its counterpart for the vertical:
 *
 * - the shown height is the weighted median of the recent readings, so a
 *   burst of wild ones cannot drag it (see AltitudeFilter);
 * - readings claiming worse than ±75 m are not used at all;
 * - the estimate carries its own uncertainty, so the screen can say how far
 *   to trust it rather than presenting noise as a measurement.
 */

/** Readings claiming worse than this (metres) are ignored. */
export const MAX_VACC_M = 75
/** Assumed accuracy (metres) when the receiver does not say. */
export const DEFAULT_VACC_M = 30
/** How far back readings count (ms), and how many at most. */
const WINDOW_MS = 90 * 1000
const WINDOW_N = 180
/** Readings needed before the height is shown at all. */
export const SETTLE_N = 8
/** A gap this long (ms) and the old readings are not worth keeping. */
const STALE_MS = 5 * 60 * 1000
/**
 * Never claim to know height better than this (metres). Phone GPS height is
 * off by several metres in ways that averaging cannot remove (the errors are
 * correlated for minutes), so a figure tighter than this would be false.
 */
const FLOOR_SIGMA_M = 5

export interface AltitudeEstimate {
  /** Metres above sea level. */
  altitude: number
  /** One-sigma uncertainty of that, metres. */
  sigma: number
  /**
   * Enough readings to show. Before this the first one or two readings would
   * be printed as the height, and one bad one is exactly the 300 ft swing.
   */
  settled: boolean
}

interface Reading {
  h: number
  acc: number
  t: number
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Median, then again without the readings far from it. One-sided outliers
 * (reflections all read high) shift a plain median by a fraction of the
 * noise; dropping everything beyond 2.5 robust standard deviations and taking
 * the median of what is left removes most of that shift.
 */
export function robustCentre(xs: number[]): { centre: number; kept: number[] } {
  const m = median(xs)
  const sd = 1.4826 * median(xs.map((x) => Math.abs(x - m)))
  if (!(sd > 0)) return { centre: m, kept: xs }
  const kept = xs.filter((x) => Math.abs(x - m) <= 2.5 * sd)
  return kept.length >= 3 ? { centre: median(kept), kept } : { centre: m, kept: xs }
}

/**
 * The height is a robust median of the last minute and a half of readings,
 * not their average. Indoor multipath errors are one-sided — a reflected
 * signal always travels further, so it reads high — and an average gets
 * dragged up by them. Readings are deliberately **not** weighted by the
 * accuracy they claim: in the reported case the wild readings claimed to be
 * the better ones, and weighting by that made the estimate worse. The claim
 * is only used to throw out readings that admit to being hopeless. The window
 * lets real changes (a staircase, a hill) come through within about 45 s.
 */
export class AltitudeFilter {
  private readings: Reading[] = []

  reset(): void {
    this.readings = []
  }

  get estimate(): AltitudeEstimate | null {
    const rs = this.readings
    if (rs.length === 0) return null
    const { centre: altitude, kept } = robustCentre(rs.map((r) => r.h))
    const n = kept.length
    let sigma: number
    if (n < 5) {
      // Too few to judge the scatter: trust what the receiver claims.
      const accs = rs.map((r) => r.acc).sort((a, b) => a - b)
      sigma = accs[Math.floor(n / 2)] / Math.sqrt(n)
    } else {
      // Scatter about the median, as a robust standard deviation. The
      // standard error of the median shrinks with more readings, but indoor
      // errors are one-sided and partly shared between readings, so a third
      // of the scatter is kept as a bias allowance that averaging cannot
      // remove. Without it the screen claimed ±16 ft while reading 30 ft high.
      const dev = kept.map((h) => Math.abs(h - altitude)).sort((a, b) => a - b)
      const sd = 1.4826 * dev[Math.floor(n / 2)]
      const se = (1.2533 * sd) / Math.sqrt(n)
      sigma = Math.hypot(se, sd / 3)
    }
    return { altitude, sigma: Math.max(sigma, FLOOR_SIGMA_M), settled: rs.length >= SETTLE_N }
  }

  push(
    altitude: number | null | undefined,
    vAcc: number | null | undefined,
    timeMs: number,
  ): AltitudeEstimate | null {
    if (altitude == null || !Number.isFinite(altitude)) return this.estimate
    const acc = vAcc != null && Number.isFinite(vAcc) && vAcc > 0 ? vAcc : DEFAULT_VACC_M
    if (acc > MAX_VACC_M) return this.estimate
    const last = this.readings[this.readings.length - 1]
    if (last && timeMs - last.t > STALE_MS) this.readings = []
    this.readings.push({ h: altitude, acc, t: timeMs })
    this.readings = this.readings.filter((r) => timeMs - r.t <= WINDOW_MS).slice(-WINDOW_N)
    return this.estimate
  }
}
