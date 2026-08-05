/**
 * The "60 D Street" relation — 60 × D = S × T.
 *
 * The navigator's mnemonic tying distance, speed and time together, where D is
 * nautical miles, S is knots and T is **minutes**. The 60 is there to convert
 * the hour in "knots" into the minutes a crew actually works in:
 *
 *     T = 60 × D ÷ S      how long will it take
 *     D = S × T ÷ 60      how far will we get
 *     S = 60 × D ÷ T      how fast must we go
 *
 * Give it any two and it returns the third, which is the point: the question
 * in the field is rarely "what is my ETA". It is just as often "we have forty
 * minutes of daylight left, how far can we search" or "the helicopter is on
 * scene in twenty minutes, what speed do we need to make".
 *
 * The units are not negotiable. Knots are nautical miles per hour, so a
 * statute mile or a kilometre in D silently produces a wrong answer, which is
 * why nothing here accepts a unit argument.
 */

export type SixtyDstQuantity = 'distance' | 'speed' | 'time'

export interface SixtyDstInput {
  /** Nautical miles. */
  distanceNM: number | null
  /** Knots. */
  speedKn: number | null
  /** Minutes. */
  timeMin: number | null
}

export interface SixtyDstSolved {
  distanceNM: number
  speedKn: number
  timeMin: number
  /** Which one was worked out, or null when all three were given. */
  solvedFor: SixtyDstQuantity | null
  /** The arithmetic written out, so the crew can check it against a card. */
  working: string
  /**
   * Set when all three were given and they do not agree, saying what the time
   * should have been. A plan that does not close is worth being told about.
   */
  mismatch: string | null
}

export type SixtyDstResult =
  | ({ ok: true } & SixtyDstSolved)
  | { ok: false; error: string }

/** Present, a real number, and greater than zero. */
function given(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0
}

/** Trim a computed figure to something a crew would actually read out. */
function tidy(value: number): number {
  return Math.round(value * 100) / 100
}

function show(value: number): string {
  return String(tidy(value))
}

/**
 * Solve 60 D = S × T for whichever quantity is missing.
 *
 * Zero is treated as missing rather than as a value: a speed of zero never
 * arrives and a time of zero covers no ground, so both would divide the answer
 * into infinity. Saying "fill this in" is more use than showing ∞.
 */
export function solveSixtyDst(input: SixtyDstInput): SixtyDstResult {
  // Pulled into locals so the type guard below narrows them. TypeScript will
  // not carry a narrowing through a mutable property of an object.
  const { distanceNM, speedKn, timeMin } = input
  const hasD = given(distanceNM)
  const hasS = given(speedKn)
  const hasT = given(timeMin)
  const count = Number(hasD) + Number(hasS) + Number(hasT)

  if (count < 2) {
    return {
      ok: false,
      error: 'Enter any two of distance, speed and time to get the third.',
    }
  }

  if (hasD && hasS && hasT) {
    const expected = (60 * distanceNM) / speedKn
    // A minute either way is rounding, not disagreement.
    const agrees = Math.abs(expected - timeMin) <= 1
    return {
      ok: true,
      distanceNM,
      speedKn,
      timeMin,
      solvedFor: null,
      working: `60 × ${show(distanceNM)} ÷ ${show(speedKn)} = ${show(expected)} min`,
      mismatch: agrees
        ? null
        : `Those three do not agree — at ${show(speedKn)} kn, ` +
          `${show(distanceNM)} NM takes ${show(expected)} min, not ${show(timeMin)}.`,
    }
  }

  if (hasD && hasS) {
    const solved = (60 * distanceNM) / speedKn
    return {
      ok: true,
      distanceNM,
      speedKn,
      timeMin: solved,
      solvedFor: 'time',
      working: `T = 60 × ${show(distanceNM)} ÷ ${show(speedKn)} = ${show(solved)} min`,
      mismatch: null,
    }
  }

  if (hasS && hasT) {
    const solved = (speedKn * timeMin) / 60
    return {
      ok: true,
      distanceNM: solved,
      speedKn,
      timeMin,
      solvedFor: 'distance',
      working: `D = ${show(speedKn)} × ${show(timeMin)} ÷ 60 = ${show(solved)} NM`,
      mismatch: null,
    }
  }

  if (hasD && hasT) {
    const solved = (60 * distanceNM) / timeMin
    return {
      ok: true,
      distanceNM,
      speedKn: solved,
      timeMin,
      solvedFor: 'speed',
      working: `S = 60 × ${show(distanceNM)} ÷ ${show(timeMin)} = ${show(solved)} kn`,
      mismatch: null,
    }
  }

  // Unreachable: two of three known means one of the pairs above matched.
  return {
    ok: false,
    error: 'Enter any two of distance, speed and time to get the third.',
  }
}

/** Minutes as `42 min` or `1 h 25 min`. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—'
  const total = Math.round(minutes)
  if (total < 60) return `${total} min`
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`
  return `${h} h ${m} min`
}

/** Parse a typed field, treating blank and rubbish alike as "not given". */
export function readField(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? n : null
}
