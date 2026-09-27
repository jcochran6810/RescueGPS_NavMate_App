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
   * Expected acceleration while cruising, m/s². This is the filter's model of
   * how the receiver is allowed to move: too low and it lags a turn, too high
   * and it follows the noise. 0.3 was picked by sweeping it against simulated
   * 1 Hz fixes — it more than halves the scatter of a phone standing still
   * while staying within a few metres of a crew that turns 90° at five knots.
   *
   * It is a floor, not a ceiling: a boat is not a walker. Turning 20° a
   * second at 18 kn is 3 m/s² sideways, ten times this, and a filter held to
   * 0.3 went from 7 to 82 m behind the boat in a 180° turn. So the filter
   * raises it for a manoeuvre (`manoeuvreAccel`) — when the receiver's own
   * course and speed say the boat is turning, or when a fix disagrees with
   * the prediction by more than the noise explains — and lets it decay back.
   */
  accelNoise?: number
  /** The acceleration a manoeuvre is allowed, m/s² — a planing boat's hard turn. */
  manoeuvreAccel?: number
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
  manoeuvreAccel: 4,
  maxSpeedMps: 130,
  resetAfterMs: 60_000,
}

/**
 * A fix this far from the prediction (chi-square, two degrees of freedom:
 * 9 is about 3σ, one fix in ninety by chance) is taken as the boat
 * manoeuvring, not the receiver's noise: the prediction is re-made allowing
 * `manoeuvreAccel` before the fix is judged.
 */
const MANOEUVRE_CHI2 = 9

/** How much of a manoeuvre's extra allowance is left after each fix. */
const MANOEUVRE_DECAY = 0.6

/** Weight of the past in the running mean of the filter's disagreements. */
const BIAS_WEIGHT = 0.5

/**
 * Innovation gate, chi-square with two degrees of freedom. 16 is roughly 4σ:
 * a fix has to disagree with the prediction by four times their combined
 * uncertainty before it is called an outlier, so a genuine manoeuvre gets
 * through and a multipath jump does not.
 */
const GATE_CHI2 = 16

/**
 * The hardest a boat — or anything else the crew is in, short of an
 * aircraft — changes its velocity, m/s². A planing hull in a hard turn pulls
 * about 3–4 m/s² (`manoeuvreAccel`); this is half as much again, so a real
 * manoeuvre is never mistaken for a glitch. It is what makes a multipath
 * jump recognisable: 100 m sideways in a second is 200 m/s² of
 * "acceleration", and no fix error the receiver owns up to explains it.
 */
const MAX_ACCEL_MPS2 = 6

/**
 * Spread allowed for the difference of two fixes, in units of their reported
 * accuracies (the 68 % radius, 1.51 σ each): 3.44 σ of a two-dimensional
 * error, the 99.7 % radius. The noise a step between two fixes can carry
 * and still be the boat moving.
 */
const STEP_NOISE = 3.44 / 1.51

/**
 * A run of refused fixes is believed — the receiver has re-acquired
 * somewhere else, and the filter is the one that is wrong — only when at
 * least this many of them agree with each other (a track a boat could
 * follow) and they span at least `ADOPT_SPAN_S`. A multipath reflection
 * throws one fix, or two or three that sit off together and then snap back;
 * the filter must never jump to those. At one fix a second this takes four.
 */
const ADOPT_MIN_FIXES = 3
const ADOPT_SPAN_S = 3

/**
 * After adopting a jump, this many fixes (the adopted one included) are
 * marked `settling`: the position has only just been believed, and
 * navigation must not switch waypoints or declare arrival on it.
 */
const SETTLE_FIXES = 3

/** Refused fixes remembered for judging whether they agree, at most. */
const RUN_KEEP = 12

/**
 * A run of refused fixes is believed only when the jump to it could be the
 * boat: from the position the filter was running on (dead reckoning), no
 * harder than this (a planing hull's hardest turn), sustained, since the
 * last fix it believed, once both errors are allowed for. 100 m sideways is
 * then believed after 5 s, not 4 — and put back if the old track returns:
 * a four-to-six-fix multipath excursion claiming ±4 m used to be adopted,
 * reported at ±6 m, and the true fixes that followed refused. m/s².
 */
const ADOPT_ACCEL_MPS2 = 6

/**
 * After a jump is believed, for this long (seconds) the reported accuracy
 * still includes the jump — fading to nothing — and a fix back where the old
 * track was going puts the filter back on it (the jump was a reflection that
 * lasted long enough to be believed).
 */
const ADOPT_HOLD_S = 10
/** …and over at most this many fixes that bear the jump out. */
const HOLD_FIXES = 3

/**
 * A consistent track refused for this long (seconds, at least this many
 * fixes) is believed even where dead reckoning says the boat could not have
 * got there: after that long, the filter is the one that is wrong. Longer
 * than a multipath excursion lasts.
 */
const ADOPT_ANYWAY_S = 8
const ADOPT_ANYWAY_FIXES = 5

/**
 * Refusing fixes for longer than this (ms) no longer means saying nothing:
 * the filter hands out its dead-reckoned position with an accuracy that
 * covers the refused fixes too (`Fix.estimate`), so the card warns — or
 * greys — instead of freezing on a position that reads as live.
 */
const REFUSE_QUIET_MS = 3_000

/**
 * A fix worse than the crew's gate is still used after `REFUSE_QUIET_MS` of
 * nothing better — flagged `poor`, at its own accuracy — if it is no worse
 * than this, metres. Beyond it is a cell-tower position, not a GPS fix.
 */
const POOR_MAX_M = 100

/** The extra acceleration a dead-reckoned position is allowed, m/s² — its error grows ½·a·t². */
const DR_ACCEL_MPS2 = 2

/**
 * A fix back on the old track (after a believed jump) is within this, plus
 * twice its own step noise, of where the old track was going — metres.
 */
const RETURN_NEAR_M = 10

/**
 * The receiver's Doppler speed does not jump with a reflected position. A
 * step from the last fix taken faster than `DOPPLER_FACTOR` times it, plus
 * `DOPPLER_SLACK_MPS` (once both fixes' errors are allowed for), is the
 * position jumping, not the boat — and a filter velocity that fast, run on
 * between fixes, is brought back to it. rc3 drift-6 (lies): a 110 m jump
 * claiming ±4 m, taken in "as a turn" (the receiver's own course was
 * swinging), dragged the velocity to 45 m/s; dead-reckoned on, the position
 * ran 630 m from the boat while the true fixes were refused. Used only
 * while the receiver says the boat is making way (`DOPPLER_MIN_MPS`): a
 * phone that reports 0 for "no idea" must not hold a moving boat still.
 */
const DOPPLER_FACTOR = 1.5
const DOPPLER_SLACK_MPS = 3
const DOPPLER_MIN_MPS = 1

/**
 * A sudden jump the filter took in (a fix well off the prediction with no
 * turn leading up to it) is held open for this many fixes: if the receiver
 * comes back to where the boat was going before it, the jump was a
 * reflection, and the filter is put back as it was — as if the jump had
 * never been seen. Otherwise it stands (it was the start of a manoeuvre).
 */
const SNAP_FIXES = 3

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
  /**
   * The position has just jumped: the filter adopted it after refusing a run
   * of fixes that agreed with each other (the receiver re-acquired somewhere
   * else). True for `SETTLE_FIXES` fixes; `fix.settling` says the same.
   */
  settling: boolean
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

function newAxis(p: number, variance: number, v = 0, vv = 100): Axis {
  // Velocity starts unknown, so its variance starts large: the first two fixes
  // then set it almost entirely from the data instead of from this guess.
  return { p, v, pp: variance, pv: 0, vv }
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
 * beat it down anything like that fast. This used to be half the receiver's
 * figure; the filtered position is now never claimed better than the
 * receiver's own figure at all. The number steers boats as well as feeding
 * the datum worksheet: the steering card compares it with the boat's safety
 * margin, and a figure too good to be true is the one thing it must not get.
 */
const ACCURACY_FLOOR = 1

/** Radius of the 68 % circle of a two-dimensional normal error, in σ. */
const CIRCLE_68 = 1.51

/** A fix in the filter's local frame: metres east/north, its accuracy, its time. */
interface LocalFix {
  x: number
  y: number
  acc: number
  t: number
}

/** The filter as it was just before a sudden jump — see `SNAP_FIXES`. */
interface Snapshot {
  x: Axis
  y: Axis
  t: number
  boost: number
  inManoeuvre: boolean
  lastInnov: { x: number; y: number } | null
  bias: { x: number; y: number }
  lastRaw: LocalFix | null
  moving: boolean
  /** Which way the jump pulled the estimate, metres east/north. */
  jx: number
  jy: number
  /** Fixes taken since. */
  count: number
  /** The last fix looked like a return to the old track (see `push`). */
  revertSeen?: boolean
}

/** The filter as it was just before it believed a jump — see `ADOPT_HOLD_S`. */
interface Adopted {
  x: Axis
  y: Axis
  t: number
  lat0: number
  lon0: number
  mLat: number
  mLon: number
  lastRaw: LocalFix | null
  moving: boolean
  /** When the jump was believed, ms, and how far it moved the position, m. */
  at: number
  jumpM: number
}

/** Chi-square of a fix against an axis pair predicted `dt` on with `q`. */
function d2Against(ax: Axis, ay: Axis, dt: number, q: number, zx: number, zy: number, r: number): number {
  const px = { ...ax }
  const py = { ...ay }
  predict(px, dt, q)
  predict(py, dt, q)
  return (zx - px.p) ** 2 / (px.pp + r) + (zy - py.p) ** 2 / (py.pp + r)
}

/**
 * Could the thing carrying the receiver have got from `a` to `b` — given the
 * velocity it had at `a` (`vx`, `vy`, uncertain by `sigmaV`) — without
 * accelerating harder than `MAX_ACCEL_MPS2`, once each fix's own claimed
 * error is allowed for? Also refuses any step faster than `maxSpeed`.
 */
function reachable(
  a: LocalFix,
  b: LocalFix,
  vx: number,
  vy: number,
  sigmaV: number,
  maxSpeed: number,
): boolean {
  const dt = (b.t - a.t) / 1000
  if (!(dt > 0)) return false
  const noise = STEP_NOISE * Math.hypot(a.acc, b.acc)
  const step = Math.hypot(b.x - a.x, b.y - a.y)
  if ((step - noise) / dt > maxSpeed) return false
  const dv = Math.hypot((b.x - a.x) / dt - vx, (b.y - a.y) / dt - vy)
  return dv - noise / dt - 3 * sigmaV <= MAX_ACCEL_MPS2 * dt
}

/** The receiver's Doppler speed, when it says the boat is making way; else null. */
function dopplerOf(raw: Fix): number | null {
  const v = raw.speed
  return v != null && Number.isFinite(v) && v >= DOPPLER_MIN_MPS ? v : null
}

/**
 * Bring a filter velocity faster than the Doppler speed allows back to that
 * speed, keeping its course, and widen its variance to match.
 */
function capToDoppler(ax: Axis, ay: Axis, doppler: number | null): void {
  if (doppler == null) return
  const v = Math.hypot(ax.v, ay.v)
  if (!(v > DOPPLER_FACTOR * doppler + DOPPLER_SLACK_MPS)) return
  const k = doppler / v
  ax.v *= k
  ay.v *= k
  const vv = Math.max(ax.vv, ay.vv, (v - doppler) ** 2 / 4)
  ax.vv = vv
  ay.vv = vv
  ax.pv = 0
  ay.pv = 0
}

export class TrackFilter {
  private opts: Required<TrackFilterOptions>
  private lat0 = 0
  private lon0 = 0
  private mLat = 1
  private mLon = 1
  private x: Axis | null = null
  private y: Axis | null = null
  private t = 0
  /** Extra acceleration still allowed after a manoeuvre, m/s² (decays). */
  private boost = 0
  /** The receiver's last course, degrees, for its turn rate. */
  private lastHeading: number | null = null
  /** The last fix needed the manoeuvre allowance. */
  private inManoeuvre = false
  /** The last fix's disagreement with the prediction, metres east/north. */
  private lastInnov: { x: number; y: number } | null = null
  /** Running mean of those disagreements, metres east/north. */
  private bias = { x: 0, y: 0 }
  /** The last fix taken, as the receiver gave it — what a jump is measured from. */
  private lastRaw: LocalFix | null = null
  /** Fixes refused since the last one taken, oldest first. */
  private run: LocalFix[] = []
  /** Fixes still to be marked `settling` after adopting a jump. */
  private settle = 0
  /** Reporting a speed: hysteresis, so a moving boat's speed does not flicker to 0. */
  private moving = false
  /** The refused run began with a step no boat could make (a jump, not a turn). */
  private runJump = false
  /** The filter before a sudden jump it took in, while that jump is on probation. */
  private snap: Snapshot | null = null
  /** The filter before it believed a jump, while `ADOPT_HOLD_S` lasts. */
  private adopted: Adopted | null = null
  /** A jump the position took (believed, or let in as a manoeuvre): when, and how far. */
  private held: { at: number; jumpM: number; fixes: number } | null = null
  /** The fix being processed is a poor one let past the gate (`POOR_MAX_M`). */
  private poorPass = false

  /** Is this disagreement on the same side as the last one? */
  private sameSide(x: number, y: number): boolean {
    const l = this.lastInnov
    return !!l && l.x * x + l.y * y > 0
  }

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
    this.run = []
    this.runJump = false
    this.snap = null
    this.adopted = null
    this.held = null
    this.lastRaw = null
    this.settle = 0
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

    // Worse than the gate — but fixes keep arriving, and nothing better has
    // for a while: a GPS fix at its own honest (poor) accuracy says more
    // than silence, which read on the card as "signal lost". Used, and
    // flagged so nothing is switched on it.
    this.poorPass =
      gate > 0 &&
      acc != null &&
      acc > gate &&
      acc <= POOR_MAX_M &&
      this.x !== null &&
      raw.timestamp - this.t > REFUSE_QUIET_MS
    if (gate > 0 && (acc == null || acc > gate) && !this.poorPass) {
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

    // A jump believed a few seconds ago, and this fix is back where the old
    // track was going (and not where the new one is): the jump was a
    // reflection after all. Put the filter back as it was before it.
    if (this.adopted) {
      if ((raw.timestamp - this.adopted.at) / 1000 > ADOPT_HOLD_S) this.adopted = null
      else if (this.returnsToOld(raw, r)) this.unadopt()
    }

    const { x: zx, y: zy } = this.toLocal(raw.lat, raw.lon)
    const here: LocalFix = { x: zx, y: zy, acc: sigma, t: raw.timestamp }

    // A jump taken in a fix or three ago, and now the receiver is back where
    // the boat was going before it: that was a reflection. Put the filter back
    // as it was and judge this fix against that.
    if (this.snap) {
      if (this.reverts(here, r)) {
        // One fix back on the old track undoes a jump only one or two fixes
        // old. A jump two fixes have already borne out (a hard turn) is not
        // undone by one fix that happens to lie where the old track was
        // going — that is as likely a reflection itself: it takes two.
        if (this.snap.count < 2 || this.snap.revertSeen) this.rollback()
        else this.snap.revertSeen = true
      } else {
        this.snap.revertSeen = false
        if (++this.snap.count >= SNAP_FIXES) this.snap = null
      }
    }
    const dtNow = (raw.timestamp - this.t) / 1000

    // Still in a run that began with a jump no boat could make, and this fix
    // sits with that run rather than with the track: it is more of the same
    // reflection. Refused with it — and counted towards believing it, if it
    // goes on long enough and consistently enough to be the receiver right
    // and the filter wrong.
    if (this.run.length > 0 && this.runJump) {
      const last = this.run[this.run.length - 1]
      const px = this.x.p + this.x.v * dtNow
      const py = this.y.p + this.y.v * dtNow
      const toRun = Math.hypot(zx - last.x, zy - last.y)
      const toTrack = Math.hypot(zx - px, zy - py)
      if (toRun < toTrack && reachable(last, here, 0, 0, 30, this.opts.maxSpeedMps)) {
        return this.refuse(raw, here, r, `Fix ${Math.round(toTrack)} m off the track, with the fixes refused before it`)
      }
    }

    // A step no vehicle on the incident could make is the receiver, not the
    // crew. Checked against the last fix taken, before the filter sees it,
    // because a single wild fix would otherwise widen the covariance and
    // let the next one in behind it.
    const stepM = Math.hypot(zx - this.x.p, zy - this.y.p)
    if (stepM / dtNow > this.opts.maxSpeedMps) {
      if (this.run.length === 0) this.runJump = true
      return this.refuse(raw, here, r, `Fix jumped ${Math.round(stepM)} m in ${dtNow.toFixed(1)} s`)
    }

    // Faster than the receiver's own Doppler speed allows, from the last fix
    // taken: the position has jumped, whatever the course is doing.
    const doppler = dopplerOf(raw)
    if (doppler != null && this.lastRaw) {
      const dtR = (raw.timestamp - this.lastRaw.t) / 1000
      const stepR = Math.hypot(zx - this.lastRaw.x, zy - this.lastRaw.y)
      const noiseR = STEP_NOISE * Math.hypot(this.lastRaw.acc, sigma)
      if (dtR > 0 && (stepR - noiseR) / dtR > DOPPLER_FACTOR * doppler + DOPPLER_SLACK_MPS) {
        if (this.run.length === 0) this.runJump = true
        return this.refuse(
          raw,
          here,
          r,
          `Fix jumped ${Math.round(stepR)} m in ${dtR.toFixed(1)} s — faster than the receiver's own speed (${doppler.toFixed(1)} m/s)`,
        )
      }
    }

    // A step the boat could not have made from the last fix taken, at the
    // velocity it had, without accelerating harder than any boat does — once
    // both fixes' own claimed errors are allowed for. Measured from the
    // receiver's last fix rather than the filter's estimate, which lags a
    // hard turn: a turn stays within this, a multipath jump of tens of
    // metres in a second does not. This is what keeps a jump that lasts two
    // or three fixes out, where the statistical gate below — widened for a
    // manoeuvre by the first of them — used to let the second one in.
    const sigmaV = Math.sqrt((this.x.vv + this.y.vv) / 2)
    if (
      this.lastRaw &&
      !reachable(this.lastRaw, here, this.x.v, this.y.v, sigmaV, this.opts.maxSpeedMps)
    ) {
      if (this.run.length === 0) this.runJump = true
      return this.refuse(
        raw,
        here,
        r,
        `Fix jumped ${Math.round(Math.hypot(zx - this.lastRaw.x, zy - this.lastRaw.y))} m in ${dtNow.toFixed(1)} s — more than the boat could move`,
      )
    }

    // After refusing a run that began with a jump no boat could make, the
    // statistical gate below is wide — the
    // prediction has run on for seconds, at a manoeuvre's allowance — and a
    // multipath excursion four fixes long got through it as "the boat
    // turning" (140 m in 4 s at 20 kn), dragging the velocity to 60 m/s. A
    // fix after refusals must also be one the boat could have reached from
    // where dead reckoning puts it (`plausibleJump`); until then it joins
    // the refused run.
    if (this.run.length > 0 && this.runJump && this.plausibleJump(here) == null) {
      return this.refuse(
        raw,
        here,
        r,
        `Fix ${Math.round(Math.hypot(zx - (this.x.p + this.x.v * dtNow), zy - (this.y.p + this.y.v * dtNow)))} m from where the boat was heading`,
      )
    }

    // How hard the boat may be accelerating: the cruising floor, what is
    // left of a recent manoeuvre, and — when the receiver reports its own
    // course and speed — the sideways acceleration of the turn it reports.
    let q = Math.max(this.opts.accelNoise, this.boost)
    const turnAccel = this.turnAccel(raw, dtNow)
    if (turnAccel > q) q = Math.min(turnAccel, this.opts.manoeuvreAccel)

    const x0 = { ...this.x }
    const y0 = { ...this.y }
    predict(this.x, dtNow, q)
    predict(this.y, dtNow, q)

    let ix = innovation(this.x, zx, r)
    let iy = innovation(this.y, zy, r)
    let d2 = (ix.y * ix.y) / ix.s + (iy.y * iy.y) / iy.s
    // How the fix looked against the plain prediction, before any allowance
    // for a manoeuvre: a big disagreement with no turn leading up to it (and
    // none reported by the receiver) is put on probation below.
    const first = { d2, x: ix.y, y: iy.y }
    const trend = (this.inManoeuvre && this.sameSide(ix.y, iy.y)) || turnAccel > this.opts.accelNoise

    // A turn shows first as fixes all falling the same side of the
    // prediction, each within the noise. Their running mean is the tell: for
    // white noise it has a third of the variance of one fix, so a mean that
    // far out is a manoeuvre the prediction is missing.
    const bx = BIAS_WEIGHT * this.bias.x + (1 - BIAS_WEIGHT) * ix.y
    const by = BIAS_WEIGHT * this.bias.y + (1 - BIAS_WEIGHT) * iy.y
    const biasVar = (1 - BIAS_WEIGHT) / (1 + BIAS_WEIGHT)
    const bias2 = (bx * bx) / (ix.s * biasVar) + (by * by) / (iy.s * biasVar)

    if ((d2 > MANOEUVRE_CHI2 || bias2 > MANOEUVRE_CHI2) && q < this.opts.manoeuvreAccel) {
      // More than the noise explains: the boat is turning or changing speed
      // faster than the prediction allowed. Predict again allowing it, then
      // judge the fix — a hard turn must not be thrown away as multipath.
      Object.assign(this.x, x0)
      Object.assign(this.y, y0)
      q = this.opts.manoeuvreAccel
      predict(this.x, dtNow, q)
      predict(this.y, dtNow, q)
      ix = innovation(this.x, zx, r)
      iy = innovation(this.y, zy, r)
      d2 = (ix.y * ix.y) / ix.s + (iy.y * iy.y) / iy.s
    }
    if (d2 > MANOEUVRE_CHI2 && this.inManoeuvre && this.sameSide(ix.y, iy.y)) {
      // Still well off after allowing a manoeuvre — and the fix before was
      // off the same way. That is a turn the filter has fallen behind, not
      // a reflection (multipath throws one fix, or several in no consistent
      // direction, and a jump no boat could make never gets this far): stop
      // trusting the prediction as much as it claims, by just enough to
      // bring this fix to the manoeuvre threshold.
      const lambda = d2 / MANOEUVRE_CHI2
      for (const a of [this.x, this.y]) {
        a.pp *= lambda
        a.pv *= lambda
        a.vv *= lambda
      }
      ix = innovation(this.x, zx, r)
      iy = innovation(this.y, zy, r)
      d2 = (ix.y * ix.y) / ix.s + (iy.y * iy.y) / iy.s
    }

    if (d2 > GATE_CHI2) {
      // Refused: the filter is left exactly as it was before this fix — not
      // predicted forward with a manoeuvre's worth of doubt, which is what
      // let the next fix of a two-fix jump in, and made the speed of a boat
      // that had ignored a single bad fix read 0 for the next few.
      Object.assign(this.x, x0)
      Object.assign(this.y, y0)
      // A fix a boat COULD have reached (it passed the test above) that is
      // still off the prediction is most likely the first fix of a turn the
      // filter is behind: if the next one is off the same way, it is let in
      // as one (the same-side rule above).
      this.inManoeuvre = true
      this.lastInnov = { x: ix.y, y: iy.y }
      return this.refuse(
        raw,
        here,
        r,
        `Fix ${Math.round(Math.hypot(ix.y, iy.y))} m off the predicted track`,
      )
    }

    if (!this.snap && first.d2 > MANOEUVRE_CHI2 && !trend) {
      this.snap = {
        x: { ...x0 },
        y: { ...y0 },
        t: this.t,
        boost: this.boost,
        inManoeuvre: this.inManoeuvre,
        lastInnov: this.lastInnov,
        bias: this.bias,
        lastRaw: this.lastRaw,
        moving: this.moving,
        jx: first.x,
        jy: first.y,
        count: 0,
      }
      // Taken in as a manoeuvre, but sudden: until it is borne out the
      // position may be the old one, and the reported error says so.
      const jumpM = Math.hypot(first.x, first.y)
      if (jumpM > 2 * sigma) this.held = { at: raw.timestamp, jumpM, fixes: 0 }
    }
    this.inManoeuvre = d2 > MANOEUVRE_CHI2 || q > this.opts.accelNoise
    this.lastInnov = { x: ix.y, y: iy.y }
    this.bias = { x: bx, y: by }
    update(this.x, ix.y, ix.s)
    update(this.y, iy.y, iy.s)
    this.t = raw.timestamp
    this.run = []
    this.runJump = false
    this.lastRaw = here
    // Keep allowing the manoeuvre for a few fixes, fading, so the next fix
    // of the same turn is not fought over again.
    this.boost = q > this.opts.accelNoise ? q * MANOEUVRE_DECAY : 0

    return this.finish(raw, Math.hypot(zx - this.x.p, zy - this.y.p))
  }

  /**
   * Is this fix back where the boat was going before the jump on probation —
   * consistent with the filter as it was then (predicted on at the cruising
   * allowance), further from where the jump took it, and on the far side of
   * it from the jump?
   */
  private reverts(here: LocalFix, r: number): boolean {
    const s = this.snap
    if (!s || !this.x || !this.y) return false
    const dtS = (here.t - s.t) / 1000
    const dtC = (here.t - this.t) / 1000
    if (!(dtS > 0) || !(dtC > 0)) return false
    const q0 = this.opts.accelNoise
    const d2s = d2Against(s.x, s.y, dtS, Math.max(q0, s.boost), here.x, here.y, r)
    if (d2s > MANOEUVRE_CHI2) return false
    const d2c = d2Against(this.x, this.y, dtC, Math.max(q0, this.boost), here.x, here.y, r)
    if (d2c <= d2s) return false
    const ex = here.x - (this.x.p + this.x.v * dtC)
    const ey = here.y - (this.y.p + this.y.v * dtC)
    return ex * s.jx + ey * s.jy < 0
  }

  /** Put the filter back as it was before the jump on probation. */
  private rollback(): void {
    const s = this.snap
    if (!s) return
    this.x = { ...s.x }
    this.y = { ...s.y }
    this.t = s.t
    this.boost = s.boost
    this.inManoeuvre = s.inManoeuvre
    this.lastInnov = s.lastInnov
    this.bias = s.bias
    this.lastRaw = s.lastRaw
    this.moving = s.moving
    this.rejected.jump += s.count + 1
    this.snap = null
    this.held = null
    this.run = []
    this.runJump = false
  }

  /**
   * Refuse a fix — and, when the fixes refused in a row now agree with each
   * other well enough (`ADOPT_MIN_FIXES` of them over `ADOPT_SPAN_S`, each
   * reachable from the one before), believe them instead: the receiver has
   * re-acquired somewhere else. The filter restarts there, with the velocity
   * those fixes show, so the speed and course do not start again from
   * nothing; the next few fixes are marked `settling`.
   */
  private refuse(raw: Fix, here: LocalFix, r: number, detail: string): FilterResult {
    this.rejected.jump++
    this.run.push(here)
    if (this.run.length > RUN_KEEP) this.run.shift()
    const agreed = this.agreeingTail()
    let jumpM = agreed ? this.plausibleJump(agreed[agreed.length - 1]) : null
    // Refusing a consistent track for long enough is the filter being
    // wrong, whatever dead reckoning says — its own velocity can be what is
    // off (after a reflection it half-followed). Believed then, jump held in
    // the accuracy as ever.
    if (
      agreed &&
      jumpM == null &&
      agreed.length >= ADOPT_ANYWAY_FIXES &&
      (raw.timestamp - this.t) / 1000 >= ADOPT_ANYWAY_S &&
      this.x &&
      this.y
    ) {
      const last = agreed[agreed.length - 1]
      const T = (last.t - this.t) / 1000
      jumpM = Math.hypot(last.x - (this.x.p + this.x.v * T), last.y - (this.y.p + this.y.v * T))
    }
    if (agreed && jumpM != null) {
      const first = agreed[0]
      const last = agreed[agreed.length - 1]
      const span = (last.t - first.t) / 1000
      const vx = (last.x - first.x) / span
      const vy = (last.y - first.y) / span
      const sv = (STEP_NOISE * Math.hypot(first.acc, last.acc)) / span / 3
      const before: Adopted | null =
        this.x && this.y
          ? {
              x: { ...this.x },
              y: { ...this.y },
              t: this.t,
              lat0: this.lat0,
              lon0: this.lon0,
              mLat: this.mLat,
              mLon: this.mLon,
              lastRaw: this.lastRaw,
              moving: this.moving,
              at: raw.timestamp,
              jumpM,
            }
          : null
      // The velocity is measured in the old frame, before `begin` moves the
      // origin to this fix — a difference, so the frame does not matter.
      this.begin(raw, r, { vx, vy, vv: Math.max(sv * sv, 0.25) })
      capToDoppler(this.x as Axis, this.y as Axis, dopplerOf(raw))
      this.settle = SETTLE_FIXES
      this.adopted = before
      this.held = { at: raw.timestamp, jumpM, fixes: 0 }
      return this.finish(raw)
    }
    if (this.x && raw.timestamp - this.t > REFUSE_QUIET_MS) return this.deadReckon(raw, here)
    return { accepted: false, reason: 'jump', raw, detail }
  }

  /**
   * How far the jump to `last` moves the position from where the filter's
   * dead reckoning puts the boat at that time, metres — when a boat could
   * have got there (no harder than `ADOPT_ACCEL_MPS2` since the last fix
   * believed, errors allowed for); null when it could not, yet.
   */
  private plausibleJump(last: LocalFix): number | null {
    if (!this.x || !this.y) return 0
    const T = (last.t - this.t) / 1000
    const ax = { ...this.x }
    const ay = { ...this.y }
    predict(ax, T, this.opts.accelNoise)
    predict(ay, T, this.opts.accelNoise)
    const off = Math.hypot(last.x - ax.p, last.y - ay.p)
    // The prediction's own spread (its velocity was not known exactly
    // either), and both fixes' errors.
    const est = CIRCLE_68 * Math.sqrt((ax.pp + ay.pp) / 2)
    const noise = STEP_NOISE * Math.hypot(last.acc, est)
    return off <= 0.5 * ADOPT_ACCEL_MPS2 * T * T + noise ? off : null
  }

  /**
   * The position the filter runs on to when it has refused everything for
   * `REFUSE_QUIET_MS`: its own prediction, nothing updated, flagged
   * `estimate: 'dead-reckoned'` (and settling), with an accuracy that covers
   * both where dead reckoning puts the boat and where the refused fix does
   * — one of them is wrong, and the filter cannot yet say which.
   */
  private deadReckon(raw: Fix, here: LocalFix): AcceptedFix {
    const ax = { ...(this.x as Axis) }
    const ay = { ...(this.y as Axis) }
    const dt = (raw.timestamp - this.t) / 1000
    capToDoppler(ax, ay, dopplerOf(raw))
    const q = Math.max(this.opts.accelNoise, this.boost)
    predict(ax, dt, q)
    predict(ay, dt, q)
    const { lat, lon } = this.toDegrees(ax.p, ay.p)
    const est = CIRCLE_68 * Math.sqrt((ax.pp + ay.pp) / 2) + 0.5 * DR_ACCEL_MPS2 * dt * dt
    const toRaw = Math.hypot(here.x - ax.p, here.y - ay.p) + here.acc
    const accuracy = Math.max(est, toRaw)
    const vMps = Math.hypot(ax.v, ay.v)
    const heading =
      this.moving && vMps >= COURSE_MIN_MPS
        ? ((Math.atan2(ax.v, ay.v) * 180) / Math.PI + 360) % 360
        : raw.heading
    return {
      accepted: true,
      fix: {
        ...raw,
        lat,
        lon,
        accuracy,
        speed: this.moving ? vMps : 0,
        heading,
        settling: true,
        estimate: 'dead-reckoned',
      },
      raw,
      derived: { speed: true, heading: heading !== raw.heading },
      settling: true,
    }
  }

  /**
   * Is this fix back on the track the filter was running before it believed
   * the jump (`adopted`) — consistent with it, and much less so with the
   * track since?
   */
  private returnsToOld(raw: Fix, r: number): boolean {
    const o = this.adopted
    if (!o || !this.x || !this.y) return false
    const dtO = (raw.timestamp - o.t) / 1000
    const dtN = (raw.timestamp - this.t) / 1000
    if (!(dtO > 0) || !(dtN > 0)) return false
    const zo = {
      x: (raw.lon - o.lon0) * o.mLon,
      y: (raw.lat - o.lat0) * o.mLat,
    }
    const q = this.opts.manoeuvreAccel
    const d2o = d2Against(o.x, o.y, dtO, q, zo.x, zo.y, r)
    if (d2o > MANOEUVRE_CHI2) return false
    const zn = this.toLocal(raw.lat, raw.lon)
    const d2n = d2Against(this.x, this.y, dtN, q, zn.x, zn.y, r)
    if (d2n <= GATE_CHI2) return false
    // …and actually ON the old track, not merely inside a manoeuvre's worth
    // of doubt about where it went: seconds after the jump that doubt is a
    // hundred metres wide, and a second reflection 110 m off both tracks
    // (rc3 dock-0, lies) passed for "the old track", put the filter back six
    // seconds and took the reflection in at 55 m/s.
    const dOld = Math.hypot(zo.x - (o.x.p + o.x.v * dtO), zo.y - (o.y.p + o.y.v * dtO))
    const dNew = Math.hypot(zn.x - (this.x.p + this.x.v * dtN), zn.y - (this.y.p + this.y.v * dtN))
    const sigma = Math.sqrt(r)
    return dOld <= RETURN_NEAR_M + 2 * STEP_NOISE * sigma && dOld < 0.5 * dNew
  }

  /** Put the filter back as it was before it believed the jump. */
  private unadopt(): void {
    const o = this.adopted
    if (!o) return
    this.lat0 = o.lat0
    this.lon0 = o.lon0
    this.mLat = o.mLat
    this.mLon = o.mLon
    this.x = { ...o.x }
    this.y = { ...o.y }
    this.t = o.t
    this.lastRaw = o.lastRaw
    this.moving = o.moving
    this.boost = 0
    this.inManoeuvre = false
    this.lastInnov = null
    this.bias = { x: 0, y: 0 }
    this.snap = null
    this.run = []
    this.runJump = false
    this.settle = 0
    this.adopted = null
    this.held = null
  }

  /**
   * The longest tail of the refused run in which every fix is reachable from
   * the one before it at the velocity the fixes before that one show — when
   * it is long enough to believe; else null.
   */
  private agreeingTail(): LocalFix[] | null {
    const run = this.run
    let start = run.length - 1
    while (start > 0) {
      const a = run[start - 1]
      const b = run[start]
      let vx = 0
      let vy = 0
      let sv = 30
      if (start >= 2) {
        const p = run[start - 2]
        const dt = (a.t - p.t) / 1000
        if (dt > 0) {
          vx = (a.x - p.x) / dt
          vy = (a.y - p.y) / dt
          sv = (STEP_NOISE * Math.hypot(a.acc, p.acc)) / dt / 3
        }
      } else if (this.x && this.y) {
        vx = this.x.v
        vy = this.y.v
        sv = 30
      }
      if (!reachable(a, b, vx, vy, sv, this.opts.maxSpeedMps)) break
      start--
    }
    const tail = run.slice(start)
    if (tail.length < ADOPT_MIN_FIXES) return null
    if ((tail[tail.length - 1].t - tail[0].t) / 1000 < ADOPT_SPAN_S - 1e-9) return null
    return tail
  }

  /**
   * The sideways acceleration of the turn the receiver itself reports, m/s²:
   * its speed times its rate of turn. 0 without a course and speed from it.
   */
  private turnAccel(raw: Fix, dt: number): number {
    const h = raw.heading
    const prev = this.lastHeading
    this.lastHeading = h != null && Number.isFinite(h) ? h : null
    if (h == null || prev == null || !Number.isFinite(h) || dt <= 0) return 0
    const v = raw.speed
    if (v == null || !Number.isFinite(v) || v <= 0) return 0
    const dh = Math.abs((((h - prev) % 360) + 540) % 360 - 180)
    return v * ((dh * Math.PI) / 180 / dt)
  }

  private begin(raw: Fix, r: number, vel?: { vx: number; vy: number; vv: number }): void {
    this.boost = 0
    this.inManoeuvre = false
    this.lastInnov = null
    this.bias = { x: 0, y: 0 }
    this.lastHeading = raw.heading != null && Number.isFinite(raw.heading) ? raw.heading : null
    this.lat0 = raw.lat
    this.lon0 = raw.lon
    const m = metersPerDegree(raw.lat)
    this.mLat = m.lat
    this.mLon = m.lon
    this.x = newAxis(0, r, vel?.vx ?? 0, vel?.vv ?? 100)
    this.y = newAxis(0, r, vel?.vy ?? 0, vel?.vv ?? 100)
    this.t = raw.timestamp
    this.run = []
    this.runJump = false
    this.snap = null
    this.adopted = null
    this.held = null
    this.settle = 0
    this.moving = false
    this.lastRaw = { x: 0, y: 0, acc: Math.sqrt(r), t: raw.timestamp }
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

  /**
   * Build the output fix from the filter state after an accepted update.
   *
   * `residualM` is how far the estimate now sits from the fix it was given.
   * The accuracy reported is the most honest of three: the filter's own
   * uncertainty, the receiver's figure (see `ACCURACY_FLOOR`), and — when
   * the estimate sits further from the fix than the receiver's own claimed
   * error — that distance. The covariance alone says what the filter
   * believes, and a filter lagging a turn believes it is right: it reported
   * 8–10 m while 82 m behind the boat. A gap between estimate and fix wider
   * than the fix's own error is the lag showing, and it is shown.
   */
  private finish(raw: Fix, residualM = 0): AcceptedFix {
    const ax = this.x as Axis
    const ay = this.y as Axis
    const { lat, lon } = this.toDegrees(ax.p, ay.p)

    // The covariance is per axis; the accuracy a receiver reports is the
    // radius of a circle (about 68 %), which is 1.5 σ in two dimensions.
    const est = CIRCLE_68 * Math.sqrt((ax.pp + ay.pp) / 2)
    const floor = (raw.accuracy ?? est) * ACCURACY_FLOOR
    const lag = raw.accuracy != null && residualM > raw.accuracy ? residualM : 0
    // Just believed a jump: until it is borne out, the old position is as
    // likely as the new, and the reported error says so — fading over
    // `ADOPT_HOLD_S`. A ±4 m claim straight after a 100 m jump was the
    // filter vouching for a reflection.
    // It fades as fixes bear the new position out: all of it on the first,
    // two thirds on the next, and so on — and never longer than
    // `ADOPT_HOLD_S`. (Held for the whole ten seconds, a jump borne out at
    // once still kept a boat at its destination from being told it had
    // arrived.)
    const h = this.held
    let held = 0
    if (h) {
      const left = Math.min(
        1 - h.fixes / HOLD_FIXES,
        1 - (raw.timestamp - h.at) / 1000 / ADOPT_HOLD_S,
      )
      held = h.jumpM * Math.max(0, left)
      h.fixes++
      if (held <= 0) this.held = null
    }
    const accuracy = Math.max(est, floor, lag, held)

    const vMps = Math.hypot(ax.v, ay.v)
    // How uncertain that velocity is, from the filter's own covariance. A
    // stationary phone still produces a wandering velocity; reporting it as
    // speed is how a moored boat ends up with three knots of tide on it. A
    // boat already under way keeps its speed until it drops below one σ
    // rather than two: on a ±20 m receiver the velocity noise is big enough
    // that "twice the noise" dropped a boat making five knots to 0 one fix
    // in six — and every 0 dragged the ETA with it.
    const sigmaV = Math.sqrt((ax.vv + ay.vv) / 2)
    this.moving = vMps > Math.max(STATIONARY_MPS, (this.moving ? 1 : 2) * sigmaV)
    const moving = this.moving

    const derivedSpeed = raw.speed == null
    const speed = derivedSpeed ? (moving ? vMps : 0) : raw.speed

    const derivedHeading = raw.heading == null
    let heading = raw.heading
    if (derivedHeading && moving && vMps >= COURSE_MIN_MPS) {
      heading = ((Math.atan2(ax.v, ay.v) * 180) / Math.PI + 360) % 360
    }

    // Just adopted after a jump, or a sudden jump still on probation: not
    // yet borne out — nothing is to be switched or arrived on it.
    const poor = this.poorPass
    const settling = this.settle > 0 || this.snap != null || poor
    if (this.settle > 0) this.settle--

    return {
      accepted: true,
      fix: {
        ...raw,
        lat,
        lon,
        accuracy,
        speed,
        heading,
        ...(settling ? { settling: true } : {}),
        ...(poor ? { estimate: 'poor' as const } : {}),
      },
      raw,
      derived: {
        speed: derivedSpeed && speed != null,
        heading: derivedHeading && heading != null,
      },
      settling,
    }
  }

  private emit(
    fix: Fix,
    raw: Fix,
    derived: { speed: boolean; heading: boolean },
  ): AcceptedFix {
    return { accepted: true, fix, raw, derived, settling: false }
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
