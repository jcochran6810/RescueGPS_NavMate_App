/**
 * Turning a stream of raw GPS fixes into a position worth navigating on.
 *
 * A phone receiver hands the page whatever it has: a 2 000 m cell-tower
 * estimate before the GNSS chip has locked, a fix that jumps a hundred metres
 * sideways off a building, a "speed" that reads 1.4 kn while standing still.
 * Plotted straight, that is a track through a wall and a search area centred on
 * nothing. Three things happen here, in order:
 *
 *   1. **Gate.** A fix reporting worse accuracy than the crew asked for is not
 *      used, and neither is one implying a speed nothing on the incident can
 *      do. Both are counted and surfaced, never swallowed.
 *   2. **Filter.** A constant-velocity Kalman filter per axis, weighted by the
 *      accuracy the receiver itself reports, so a ±4 m fix moves the estimate
 *      and a ±40 m fix barely nudges it.
 *   3. **Derive.** Velocity comes out of the filter, so speed and course exist
 *      even on the many devices that report `null` for both.
 *
 * Everything is pure and synchronous — the store owns the geolocation watch,
 * this owns the arithmetic, and the arithmetic is what the tests drive.
 */

import type { Fix } from '@/lib/types'
import { metersPerDegree } from '@/lib/geo'

/** How good a fix is, in the terms a crew actually cares about. */
export type FixQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'coarse'

/**
 * Accuracy bands. The boundaries are the ones that change what you can do
 * with the fix: under 5 m you can walk back to a mark, under 10 m you can
 * navigate on it, under 25 m it will do for a datum, under 50 m it is a
 * position report and not much else, and beyond that the receiver is telling
 * you it has not locked.
 */
export function fixQuality(accuracyM: number | null | undefined): FixQuality {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return 'coarse'
  if (accuracyM <= 5) return 'excellent'
  if (accuracyM <= 10) return 'good'
  if (accuracyM <= 25) return 'fair'
  if (accuracyM <= 50) return 'poor'
  return 'coarse'
}

export const QUALITY_LABEL: Record<FixQuality, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  coarse: 'Coarse',
}

/**
 * Accuracy gates offered in the UI, in metres. `0` means take anything the
 * receiver offers.
 *
 * 25 m is the default: tight enough to throw away the cell-tower fix the phone
 * hands over in the first seconds, loose enough that a hillside or a wheelhouse
 * roof does not leave the crew with no position at all.
 */
export const ACCURACY_GATES = [10, 25, 50, 0] as const
export const DEFAULT_GATE_M = 25

export type RejectReason = 'accuracy' | 'jump' | 'stale'

export interface TrackFilterOptions {
  /** Worst accuracy a fix may report and still be used, metres. 0 disables. */
  maxAccuracyM?: number
  /**
   * Expected acceleration, m/s². This is the filter's whole model of how the
   * receiver is allowed to move: too low and it lags a turn, too high and it
   * follows the noise. 0.3 was picked by sweeping it against simulated 1 Hz
   * fixes — it more than halves the scatter of a phone standing still while
   * staying within a few metres of a crew that turns 90° at five knots, which
   * is the shape of the job.
   */
  accelNoise?: number
  /**
   * Speed above which a step between two fixes is a receiver glitch rather
   * than movement, m/s. 130 m/s is about 253 kn — above a SAR helicopter, so
   * nothing legitimate trips it.
   */
  maxSpeedMps?: number
  /** Gap after which the filter restarts rather than bridging it, ms. */
  resetAfterMs?: number
}

const DEFAULTS: Required<TrackFilterOptions> = {
  maxAccuracyM: DEFAULT_GATE_M,
  accelNoise: 0.3,
  maxSpeedMps: 130,
  resetAfterMs: 60_000,
}

/**
 * Innovation gate, chi-square with two degrees of freedom. 16 is roughly 4σ:
 * a fix has to disagree with the prediction by four times their combined
 * uncertainty before it is called an outlier, so a genuine manoeuvre gets
 * through and a multipath jump does not.
 */
const GATE_CHI2 = 16

/** After this many outliers in a row the receiver is right and we are wrong. */
const RESET_AFTER_OUTLIERS = 3

/**
 * Floors under "we are moving" and "this is the way we are pointing".
 *
 * The real test is against the filter's own velocity uncertainty — a speed
 * smaller than the noise on the speed is not a speed — and these only stop a
 * very confident filter from calling a centimetre a second movement.
 */
const STATIONARY_MPS = 0.25
const COURSE_MIN_MPS = 0.5

export interface AcceptedFix {
  accepted: true
  /** The filtered fix — what the app should navigate, plot and record on. */
  fix: Fix
  /** Exactly what the receiver said, kept so nothing is silently rewritten. */
  raw: Fix
  /** Speed and course came out of the filter, not the receiver. */
  derived: { speed: boolean; heading: boolean }
}

export interface RejectedFix {
  accepted: false
  reason: RejectReason
  raw: Fix
  /** One line, suitable for showing to the crew. */
  detail: string
}

export type FilterResult = AcceptedFix | RejectedFix

/** One axis of a constant-velocity Kalman filter. */
interface Axis {
  p: number
  v: number
  pp: number
  pv: number
  vv: number
}

function newAxis(p: number, variance: number): Axis {
  // Velocity starts unknown, so its variance starts large: the first two fixes
  // then set it almost entirely from the data instead of from this guess.
  return { p, v: 0, pp: variance, pv: 0, vv: 100 }
}

function predict(a: Axis, dt: number, accelNoise: number): void {
  a.p += a.v * dt
  const s = accelNoise * accelNoise
  const q11 = (s * dt ** 4) / 4
  const q12 = (s * dt ** 3) / 2
  const q22 = s * dt ** 2
  a.pp += 2 * a.pv * dt + a.vv * dt * dt + q11
  a.pv += a.vv * dt + q12
  a.vv += q22
}

/** Innovation and its variance, before deciding whether to take the fix. */
function innovation(a: Axis, z: number, r: number): { y: number; s: number } {
  return { y: z - a.p, s: a.pp + r }
}

function update(a: Axis, y: number, s: number): void {
  const pp = a.pp
  const pv = a.pv
  const k1 = pp / s
  const k2 = pv / s
  a.p += k1 * y
  a.v += k2 * y
  // P = (I - KH)P, with the pre-update covariance on the right-hand side —
  // hence the copies above. Written out rather than looped: it is four terms,
  // and the one place a matrix bug here would show is a track that slowly
  // stops believing its own measurements.
  a.pp = pp - k1 * pp
  a.pv = pv - k1 * pv
  a.vv -= k2 * pv
}

/**
 * Accuracy floor, as a fraction of what the receiver reported.
 *
 * The filter assumes white measurement noise, so with enough fixes it will
 * happily claim centimetres. Real GNSS error is correlated over minutes —
 * ionosphere, multipath, a bad geometry that stays bad — so averaging does not
 * beat it down anything like that fast. Never claiming better than half the
 * receiver's own figure keeps the number honest, which matters because the
 * datum worksheet takes it as an input.
 */
const ACCURACY_FLOOR = 0.5

export class TrackFilter {
  private opts: Required<TrackFilterOptions>
  private lat0 = 0
  private lon0 = 0
  private mLat = 1
  private mLon = 1
  private x: Axis | null = null
  private y: Axis | null = null
  private t = 0
  private outliers = 0

  /** Fixes refused since the last reset, by reason. */
  readonly rejected: Record<RejectReason, number> = {
    accuracy: 0,
    jump: 0,
    stale: 0,
  }

  constructor(options: TrackFilterOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
  }

  /** Change the gate without throwing away the state built up so far. */
  setMaxAccuracy(m: number): void {
    this.opts.maxAccuracyM = Number.isFinite(m) && m > 0 ? m : 0
  }

  get maxAccuracyM(): number {
    return this.opts.maxAccuracyM
  }

  reset(): void {
    this.x = null
    this.y = null
    this.t = 0
    this.outliers = 0
    this.rejected.accuracy = 0
    this.rejected.jump = 0
    this.rejected.stale = 0
  }

  /** True once at least one fix has been taken. */
  get started(): boolean {
    return this.x !== null
  }

  push(raw: Fix): FilterResult {
    const gate = this.opts.maxAccuracyM
    const acc = raw.accuracy != null && Number.isFinite(raw.accuracy)
      ? raw.accuracy
      : null

    if (gate > 0 && (acc == null || acc > gate)) {
      this.rejected.accuracy++
      return {
        accepted: false,
        reason: 'accuracy',
        raw,
        detail:
          acc == null
            ? 'Fix arrived with no accuracy figure'
            : `Fix accurate to ±${Math.round(acc)} m, worse than the ±${gate} m limit`,
      }
    }

    // No accuracy at all and no gate: assume the worst rather than the best,
    // so an unqualified fix cannot outvote a measured one.
    const sigma = acc ?? 100
    const r = sigma * sigma

    if (this.x === null || this.y === null) {
      this.begin(raw, r)
      return this.emit(raw, raw, { speed: false, heading: false })
    }

    const dt = (raw.timestamp - this.t) / 1000
    if (dt <= 0) {
      this.rejected.stale++
      return {
        accepted: false,
        reason: 'stale',
        raw,
        detail: 'Fix is older than the one before it',
      }
    }

    if (dt * 1000 > this.opts.resetAfterMs) {
      // Minutes with no fix. Where the crew is now has nothing to do with the
      // velocity the filter was carrying, so start again from this fix rather
      // than dragging a stale course across the gap.
      this.begin(raw, r)
      return this.emit(raw, raw, { speed: false, heading: false })
    }

    const { x: zx, y: zy } = this.toLocal(raw.lat, raw.lon)

    // A step no vehicle on the incident could make is the receiver, not the
    // crew. Checked against the last accepted position, before the filter sees
    // it, because a single wild fix would otherwise widen the covariance and
    // let the next one in behind it.
    const stepM = Math.hypot(zx - this.x.p, zy - this.y.p)
    if (stepM / dt > this.opts.maxSpeedMps) {
      this.rejected.jump++
      this.countOutlier(raw, r)
      return {
        accepted: false,
        reason: 'jump',
        raw,
        detail: `Fix jumped ${Math.round(stepM)} m in ${dt.toFixed(1)} s`,
      }
    }

    predict(this.x, dt, this.opts.accelNoise)
    predict(this.y, dt, this.opts.accelNoise)

    const ix = innovation(this.x, zx, r)
    const iy = innovation(this.y, zy, r)
    const d2 = (ix.y * ix.y) / ix.s + (iy.y * iy.y) / iy.s

    if (d2 > GATE_CHI2) {
      this.rejected.jump++
      this.t = raw.timestamp
      this.countOutlier(raw, r)
      return {
        accepted: false,
        reason: 'jump',
        raw,
        detail: `Fix ${Math.round(Math.hypot(ix.y, iy.y))} m off the predicted track`,
      }
    }

    update(this.x, ix.y, ix.s)
    update(this.y, iy.y, iy.s)
    this.t = raw.timestamp
    this.outliers = 0

    return this.finish(raw)
  }

  private begin(raw: Fix, r: number): void {
    this.lat0 = raw.lat
    this.lon0 = raw.lon
    const m = metersPerDegree(raw.lat)
    this.mLat = m.lat
    this.mLon = m.lon
    this.x = newAxis(0, r)
    this.y = newAxis(0, r)
    this.t = raw.timestamp
    this.outliers = 0
  }

  private countOutlier(raw: Fix, r: number): void {
    this.outliers++
    if (this.outliers >= RESET_AFTER_OUTLIERS) {
      // Three in a row is not multipath, it is a receiver that has re-acquired
      // somewhere else. Believe it rather than sitting on a position the crew
      // has visibly left.
      this.begin(raw, r)
    }
  }

  /** Degrees to metres east/north of wherever the filter was started. */
  private toLocal(lat: number, lon: number): { x: number; y: number } {
    return {
      x: (lon - this.lon0) * this.mLon,
      y: (lat - this.lat0) * this.mLat,
    }
  }

  private toDegrees(x: number, y: number): { lat: number; lon: number } {
    return { lat: this.lat0 + y / this.mLat, lon: this.lon0 + x / this.mLon }
  }

  /** Build the output fix from the filter state after an accepted update. */
  private finish(raw: Fix): AcceptedFix {
    const ax = this.x as Axis
    const ay = this.y as Axis
    const { lat, lon } = this.toDegrees(ax.p, ay.p)

    const est = Math.sqrt((ax.pp + ay.pp) / 2)
    const floor = (raw.accuracy ?? est) * ACCURACY_FLOOR
    const accuracy = Math.max(est, floor)

    const vMps = Math.hypot(ax.v, ay.v)
    // How uncertain that velocity is, from the filter's own covariance. A
    // stationary phone still produces a wandering velocity; reporting it as
    // speed is how a moored boat ends up with three knots of tide on it.
    const sigmaV = Math.sqrt((ax.vv + ay.vv) / 2)
    const moving = vMps > Math.max(STATIONARY_MPS, 2 * sigmaV)

    const derivedSpeed = raw.speed == null
    const speed = derivedSpeed ? (moving ? vMps : 0) : raw.speed

    const derivedHeading = raw.heading == null
    let heading = raw.heading
    if (derivedHeading && moving && vMps >= COURSE_MIN_MPS) {
      heading = ((Math.atan2(ax.v, ay.v) * 180) / Math.PI + 360) % 360
    }

    return {
      accepted: true,
      fix: { ...raw, lat, lon, accuracy, speed, heading },
      raw,
      derived: {
        speed: derivedSpeed && speed != null,
        heading: derivedHeading && heading != null,
      },
    }
  }

  private emit(
    fix: Fix,
    raw: Fix,
    derived: { speed: boolean; heading: boolean },
  ): AcceptedFix {
    return { accepted: true, fix, raw, derived }
  }
}

/**
 * Whether a fix earns a place in the recorded path.
 *
 * Two gates, both needed. Time keeps an hour of tracking to a few hundred
 * points. Distance keeps a phone left on a thwart from drawing a mile of
 * scribble: unless the position has moved further than it is uncertain, it has
 * not been shown to have moved at all.
 */
export function shouldRecord(
  last: Fix | undefined,
  fix: Fix,
  intervalS: number,
  moveM = 5,
): boolean {
  if (!last) return true
  if (fix.timestamp - last.timestamp < intervalS * 1000) return false
  const m = metersPerDegree(fix.lat)
  const dx = (fix.lon - last.lon) * m.lon
  const dy = (fix.lat - last.lat) * m.lat
  const threshold = Math.max(moveM, fix.accuracy ?? 0, last.accuracy ?? 0)
  return Math.hypot(dx, dy) > threshold
}
