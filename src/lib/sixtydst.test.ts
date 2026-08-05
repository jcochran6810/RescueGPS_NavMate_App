import { describe, it, expect } from 'vitest'
import {
  solveSixtyDst,
  formatMinutes,
  readField,
  type SixtyDstInput,
} from './sixtydst'

const input = (over: Partial<SixtyDstInput> = {}): SixtyDstInput => ({
  distanceNM: null,
  speedKn: null,
  timeMin: null,
  ...over,
})

/** Narrow to the success case so the tests read without optional chaining. */
function solved(i: SixtyDstInput) {
  const r = solveSixtyDst(i)
  if (!r.ok) throw new Error(`expected a solution, got: ${r.error}`)
  return r
}

describe('solving for time', () => {
  it('works out how long a leg takes', () => {
    // 4 NM at 8 knots is half an hour.
    const r = solved(input({ distanceNM: 4, speedKn: 8 }))
    expect(r.solvedFor).toBe('time')
    expect(r.timeMin).toBeCloseTo(30)
  })

  it('shows the arithmetic', () => {
    const r = solved(input({ distanceNM: 4, speedKn: 8 }))
    expect(r.working).toBe('T = 60 × 4 ÷ 8 = 30 min')
  })

  it('handles a slow speed over a long distance', () => {
    // A drifting search at 1.5 kn over 12 NM: eight hours.
    const r = solved(input({ distanceNM: 12, speedKn: 1.5 }))
    expect(r.timeMin).toBeCloseTo(480)
  })
})

describe('solving for distance', () => {
  it('works out how far you get in the time available', () => {
    // The question the daylight countdown raises: 40 minutes left at 9 kn.
    const r = solved(input({ speedKn: 9, timeMin: 40 }))
    expect(r.solvedFor).toBe('distance')
    expect(r.distanceNM).toBeCloseTo(6)
    expect(r.working).toBe('D = 9 × 40 ÷ 60 = 6 NM')
  })
})

describe('solving for speed', () => {
  it('works out the speed needed to make a rendezvous', () => {
    // 7 NM to run, 20 minutes to do it in.
    const r = solved(input({ distanceNM: 7, timeMin: 20 }))
    expect(r.solvedFor).toBe('speed')
    expect(r.speedKn).toBeCloseTo(21)
    expect(r.working).toBe('S = 60 × 7 ÷ 20 = 21 kn')
  })
})

describe('round trips', () => {
  it('returns the input when a solved value is fed back in', () => {
    const time = solved(input({ distanceNM: 4.2, speedKn: 6 })).timeMin
    const speed = solved(input({ distanceNM: 4.2, timeMin: time })).speedKn
    const distance = solved(input({ speedKn: speed, timeMin: time })).distanceNM
    expect(speed).toBeCloseTo(6, 6)
    expect(distance).toBeCloseTo(4.2, 6)
  })

  it('always returns all three quantities, not only the solved one', () => {
    const r = solved(input({ distanceNM: 4, speedKn: 8 }))
    expect(r.distanceNM).toBe(4)
    expect(r.speedKn).toBe(8)
    expect(r.timeMin).toBeCloseTo(30)
  })
})

describe('checking three given values', () => {
  it('accepts a set that agrees', () => {
    const r = solved(input({ distanceNM: 4, speedKn: 8, timeMin: 30 }))
    expect(r.solvedFor).toBeNull()
    expect(r.mismatch).toBeNull()
  })

  it('tolerates a minute of rounding', () => {
    expect(solved(input({ distanceNM: 4, speedKn: 8, timeMin: 31 })).mismatch).toBeNull()
  })

  it('says so when the three do not agree', () => {
    const r = solved(input({ distanceNM: 4, speedKn: 8, timeMin: 45 }))
    expect(r.mismatch).toMatch(/do not agree/)
    expect(r.mismatch).toContain('30')
  })
})

describe('refusals', () => {
  it('needs two of the three', () => {
    expect(solveSixtyDst(input({ distanceNM: 4 }))).toEqual({
      ok: false,
      error: 'Enter any two of distance, speed and time to get the third.',
    })
    expect(solveSixtyDst(input()).ok).toBe(false)
  })

  it('treats a zero speed as missing rather than dividing by it', () => {
    // Standing still never arrives; an infinite ETA is not an answer.
    const r = solveSixtyDst(input({ distanceNM: 4, speedKn: 0 }))
    expect(r.ok).toBe(false)
  })

  it('treats a zero time as missing', () => {
    expect(solveSixtyDst(input({ distanceNM: 4, timeMin: 0 })).ok).toBe(false)
  })

  it('rejects negatives — there is no such thing as a negative leg', () => {
    expect(solveSixtyDst(input({ distanceNM: -4, speedKn: 8 })).ok).toBe(false)
    expect(solveSixtyDst(input({ distanceNM: 4, speedKn: -8 })).ok).toBe(false)
  })

  it('rejects values that are not numbers', () => {
    expect(solveSixtyDst(input({ distanceNM: Number.NaN, speedKn: 8 })).ok).toBe(false)
    expect(
      solveSixtyDst(input({ distanceNM: Number.POSITIVE_INFINITY, speedKn: 8 })).ok,
    ).toBe(false)
  })
})

describe('readField', () => {
  it('reads a typed number', () => {
    expect(readField('4.2')).toBe(4.2)
    expect(readField(' 8 ')).toBe(8)
  })

  it('treats blank as not given', () => {
    expect(readField('')).toBeNull()
    expect(readField('   ')).toBeNull()
  })

  it('treats rubbish as not given rather than as zero', () => {
    // Number('abc') is NaN but Number('') is 0, and a silent zero here would
    // become an infinite ETA rather than a prompt to fill the box in.
    expect(readField('abc')).toBeNull()
    expect(readField('-3')).toBeNull()
    expect(readField('0')).toBeNull()
  })
})

describe('formatMinutes', () => {
  it('reads minutes under the hour', () => {
    expect(formatMinutes(42)).toBe('42 min')
    expect(formatMinutes(59.4)).toBe('59 min')
  })

  it('rolls into hours', () => {
    expect(formatMinutes(85)).toBe('1 h 25 min')
    expect(formatMinutes(120)).toBe('2 h 0 min')
  })

  it('rolls into days', () => {
    expect(formatMinutes(60 * 30)).toBe('1 d 6 h')
  })

  it('refuses the unknown', () => {
    expect(formatMinutes(Number.NaN)).toBe('—')
    expect(formatMinutes(-1)).toBe('—')
  })
})
