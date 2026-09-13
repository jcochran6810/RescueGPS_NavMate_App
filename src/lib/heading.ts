/**
 * Turning a device-orientation event into a heading a crew can steer by.
 *
 * The naive phone compass reads `360 - alpha` and calls it done. That is exact
 * for a phone lying flat and wrong the moment it is not, because `alpha` is the
 * azimuth of the *top edge of the screen* — and when the phone is held up to
 * look at, the top edge points at the sky, where every direction is the same
 * direction. Roll the phone a few degrees in that attitude and the heading
 * swings tens of degrees. That is the failure everyone has seen: a needle that
 * will not settle, and cannot, because the number it is built from has stopped
 * meaning anything.
 *
 * So this file works from the full rotation matrix and picks the pointing
 * direction to suit how the phone is being held:
 *
 *   - held flat, like a hand-bearing compass — the top edge of the screen is
 *     what points;
 *   - held up to read — the back of the phone points, which is the direction
 *     the person holding it is facing.
 *
 * Between the two it interpolates, and in that band the two agree anyway, so
 * the needle does not jump as the hand moves. Screen rotation is taken into
 * account, because "up the screen" is not a fixed device axis once the phone
 * turns to landscape.
 *
 * Nothing here talks to a sensor. It is arithmetic on numbers, so it can be
 * tested against attitudes worked out by hand — which is the only way any of
 * this gets verified, since a test cannot tilt a phone.
 */

const RAD = Math.PI / 180

/** 0–360, for any input including negatives and multiples of a turn. */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * The short way round from one bearing to another, -180 to 180.
 *
 * Positive is clockwise. This is what stops a dial spinning 358° backwards when
 * a heading crosses north.
 */
export function shortestDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180
}

/**
 * `next` expressed near `prev` rather than wrapped into 0–360.
 *
 * Rotations have to be continuous or the animation takes the long way round;
 * the value this returns grows without bound on purpose.
 */
export function unwrapDeg(prev: number, next: number): number {
  return prev + shortestDelta(prev, next)
}

/** Blend two bearings, taking the short way round. `t` runs 0 (a) to 1 (b). */
export function blendDeg(a: number, b: number, t: number): number {
  return normalizeDeg(a + shortestDelta(a, b) * t)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Hermite ramp — 0 below `edge0`, 1 above `edge1`, smooth in between. */
function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export type HoldMode = 'flat' | 'upright'

export interface DeviceHeading {
  /** Degrees clockwise from the sensor's reference north, 0–360. */
  heading: number
  /**
   * How the device is being held, which decides what "pointing" means.
   */
  mode: HoldMode
  /**
   * Degrees away from the ideal attitude for that mode — flat for `flat`,
   * vertical for `upright`. A compass read at a large tilt is a compass read
   * badly, and the card says so.
   */
  tilt: number
  /**
   * Where the bubble sits on a spirit level drawn on the screen, in screen
   * coordinates: x right, y down, each -1 to 1, (0, 0) dead level.
   */
  level: { x: number; y: number }
  /**
   * Length of the horizontal projection the heading came from, 0–1. Near zero
   * the direction is noise; this is what says so.
   */
  confidence: number
}

/**
 * Heading from a `deviceorientation` event's Euler angles.
 *
 * `screenAngle` is `screen.orientation.angle` — the angle the page has been
 * rotated by, which is how the device knows landscape from portrait.
 *
 * Returns null when the angles are not usable. The reference direction is
 * whatever the sensor is referenced to; on every browser that ships this event
 * that is magnetic north, and correcting it to true north is `geomag.ts`'s job.
 */
export function headingFromOrientation(
  alpha: number | null | undefined,
  beta: number | null | undefined,
  gamma: number | null | undefined,
  screenAngle = 0,
): DeviceHeading | null {
  if (
    alpha == null ||
    beta == null ||
    gamma == null ||
    !Number.isFinite(alpha) ||
    !Number.isFinite(beta) ||
    !Number.isFinite(gamma)
  ) {
    return null
  }

  const a = alpha * RAD
  const b = beta * RAD
  const g = gamma * RAD
  const cA = Math.cos(a)
  const sA = Math.sin(a)
  const cB = Math.cos(b)
  const sB = Math.sin(b)
  const cG = Math.cos(g)
  const sG = Math.sin(g)

  /*
   * The W3C rotation matrix, device axes to Earth axes (x east, y north,
   * z up), as the intrinsic Z-X'-Y'' sequence the event's angles describe.
   * Only its three columns are ever needed, so only they are built.
   */
  // Device +X — to the right of the screen in its natural orientation.
  const xe = cA * cG - sA * sB * sG
  const xn = cG * sA + cA * sB * sG
  const xu = -cB * sG
  // Device +Y — the top edge of the screen.
  const ye = -cB * sA
  const yn = cA * cB
  const yu = sB
  // Device +Z — out of the screen, towards whoever is looking at it.
  const ze = cA * sG + cG * sA * sB
  const zn = sA * sG - cA * cG * sB
  const zu = cB * cG

  /* "Up the screen" as the user sees it, which in landscape is a different
     device axis from the one it is in portrait. */
  const th = screenAngle * RAD
  const sTh = Math.sin(th)
  const cTh = Math.cos(th)
  const upE = sTh * xe + cTh * ye
  const upN = sTh * xn + cTh * yn

  /* The back of the device — where the camera looks, and where the person
     holding it up to read is facing. */
  const backE = -ze
  const backN = -zn

  const upH = Math.hypot(upE, upN)
  const backH = Math.hypot(backE, backN)

  /*
   * Which way is up, in the device's own frame — the third row of the same
   * matrix — resolved onto the screen's own axes so that landscape behaves
   * like portrait turned sideways, which is what it is.
   *
   * `gUp` is how far the top of the screen is raised towards the sky; `gNorm`
   * is how far the screen itself still faces upwards.
   */
  // The up-components of the three columns are the matrix's third row, which
  // is which way is up expressed in the device's own axes.
  const gRight = xu * cTh - yu * sTh
  const gUp = xu * sTh + yu * cTh
  const gNorm = zu

  /*
   * Which pointer to read, and it cannot be settled by tilt alone.
   *
   * Raising the top of the screen and lowering it look identical to any test
   * on the angle from level — yet one is a phone lifted to eye height, whose
   * camera points where you are facing, and the other is a phone read at waist
   * height, whose top edge still points. So the elevation of the top of the
   * screen picks the branch, and within the raised branch the changeover
   * happens as the screen stops facing the sky: that band, from about 50° to
   * 72° of lift, is exactly where the two pointers converge, so crossing it
   * moves the needle by nothing.
   *
   * The lowered branch keeps the top edge until it is within a few degrees of
   * straight down, where its azimuth has stopped meaning anything at all.
   * There is a 180° flip at the bottom of that ramp, and there is no avoiding
   * one: a phone whose top edge points at the ground is pointing at every
   * bearing at once. It is put where nobody holds a phone.
   */
  const w = gUp > 0 ? smoothstep(0.62, 0.3, gNorm) : smoothstep(0.1, 0.02, upH)

  const upHeading = normalizeDeg(Math.atan2(upE, upN) / RAD)
  const backHeading = normalizeDeg(Math.atan2(backE, backN) / RAD)
  const heading =
    w <= 0 ? upHeading : w >= 1 ? backHeading : blendDeg(upHeading, backHeading, w)

  const mode: HoldMode = w >= 0.5 ? 'upright' : 'flat'

  /* Tilt is measured from whatever counts as level for that hold: screen up
     for a compass held flat, screen vertical for one held up to read. */
  const tiltCos = mode === 'flat' ? gNorm : gUp
  const level =
    mode === 'flat'
      ? { x: gRight, y: -gUp }
      : { x: gRight, y: gNorm }

  return {
    heading,
    mode,
    tilt: Math.acos(clamp(tiltCos, -1, 1)) / RAD,
    level: { x: clamp(level.x, -1, 1), y: clamp(level.y, -1, 1) },
    confidence: mode === 'upright' ? backH : upH,
  }
}

/**
 * A smoother that settles when the device is still and keeps up when it turns.
 *
 * Two things it has to get right, and a fixed low-pass gets neither:
 *
 *   - bearings are angles, so 359 and 1 average to 0 and not to 180. They are
 *     folded in as unit vectors for that reason;
 *   - the gain cannot be a constant. Enough smoothing to hold a needle steady
 *     in a shaking hand puts it seconds behind a boat coming round, and a crew
 *     steering by a lagging compass will chase it. So the time constant closes
 *     up as the error grows: still is smooth, turning is immediate.
 *
 * It is time-aware rather than sample-aware, because these events arrive at
 * whatever rate the device feels like and a per-sample gain would smooth twice
 * as hard on a phone that reports twice as fast.
 */
export class HeadingSmoother {
  private x: number | null = null
  private y: number | null = null
  private last = 0

  /** Seconds to settle when the reading is steady. */
  static readonly TAU_STEADY = 0.4
  /** Seconds to settle when it is clearly turning. */
  static readonly TAU_TURNING = 0.05
  /** Error at which the gain is fully open, degrees. */
  static readonly FAST_DEG = 20

  reset(): void {
    this.x = null
    this.y = null
    this.last = 0
  }

  /** True once it has a value to report. */
  get ready(): boolean {
    return this.x !== null
  }

  /** The smoothed heading without folding anything new in. */
  value(): number | null {
    if (this.x === null || this.y === null) return null
    return normalizeDeg(Math.atan2(this.y, this.x) / RAD)
  }

  /**
   * Fold in a reading taken at `nowMs` and return the smoothed heading.
   */
  update(deg: number, nowMs: number): number {
    const x = Math.cos(deg * RAD)
    const y = Math.sin(deg * RAD)

    if (this.x === null || this.y === null) {
      this.x = x
      this.y = y
      this.last = nowMs
      return normalizeDeg(deg)
    }

    // A jump in the clock (a phone waking up, a tab coming back) would
    // otherwise open the gain wide for one sample, which is harmless, or
    // produce a negative dt, which is not.
    const dt = clamp((nowMs - this.last) / 1000, 0, 1)
    this.last = nowMs

    const current = normalizeDeg(Math.atan2(this.y, this.x) / RAD)
    const err = Math.abs(shortestDelta(current, deg))
    const k = clamp(err / HeadingSmoother.FAST_DEG, 0, 1)
    const tau =
      HeadingSmoother.TAU_STEADY +
      (HeadingSmoother.TAU_TURNING - HeadingSmoother.TAU_STEADY) * k
    const gain = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau)

    this.x += (x - this.x) * gain
    this.y += (y - this.y) * gain
    return normalizeDeg(Math.atan2(this.y, this.x) / RAD)
  }
}

/**
 * How badly the raw readings are wandering, in degrees RMS.
 *
 * This is the only calibration signal available on Android, which reports no
 * accuracy figure at all (`samples` is expected to be one recent window of
 * raw readings with their timestamps). An uncalibrated or disturbed magnetometer does not
 * read *wrong* steadily — it reads differently every sample, and a needle that
 * will not settle is the tell.
 *
 * But "the readings keep changing" is also what a boat coming round looks
 * like, and telling a crew mid-turn that their compass needs calibrating is
 * worse than saying nothing. So what is measured is the scatter **about a
 * steady rate of turn**: a straight line is fitted through the recent readings
 * and the residual reported. A turn, however fast, fits the line and leaves
 * almost nothing behind; jitter does not fit it at any speed.
 *
 * The readings are unwrapped first, or a pass through north would register as
 * the largest turn the device has ever made.
 */
export function headingWander(
  samples: { deg: number; t: number }[],
): number | null {
  const n = samples.length
  if (n < 8) return null

  const recent = samples
  const t0 = recent[0].t
  const ts: number[] = new Array(n)
  const ys: number[] = new Array(n)
  ys[0] = recent[0].deg
  ts[0] = 0
  for (let i = 1; i < n; i++) {
    ys[i] = ys[i - 1] + shortestDelta(recent[i - 1].deg, recent[i].deg)
    ts[i] = (recent[i].t - t0) / 1000
  }

  let sumT = 0
  let sumY = 0
  for (let i = 0; i < n; i++) {
    sumT += ts[i]
    sumY += ys[i]
  }
  const meanT = sumT / n
  const meanY = sumY / n
  let stt = 0
  let sty = 0
  for (let i = 0; i < n; i++) {
    stt += (ts[i] - meanT) ** 2
    sty += (ts[i] - meanT) * (ys[i] - meanY)
  }
  const rate = stt > 0 ? sty / stt : 0

  let sq = 0
  for (let i = 0; i < n; i++) {
    sq += (ys[i] - (meanY + rate * (ts[i] - meanT))) ** 2
  }
  return Math.sqrt(sq / n)
}


/**
 * "turn 40° right" / "dead ahead", from a bearing and the way you are facing.
 *
 * Under 5° is called dead ahead because that is inside what anyone can hold a
 * boat to, and a compass that keeps asking for a 2° correction gets ignored.
 */
export function describeTurn(bearing: number, heading: number): string {
  const rel = ((((bearing - heading) % 360) + 540) % 360) - 180
  if (!Number.isFinite(rel)) return ''
  if (Math.abs(rel) < 5) return 'dead ahead'
  return `turn ${Math.round(Math.abs(rel))}° ${rel > 0 ? 'right' : 'left'}`
}
