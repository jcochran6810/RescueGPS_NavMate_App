import { describe, it, expect } from 'vitest'
import { MOVING_KN, parseCustomSpeed, resolveEtaSpeed, speedText } from './etaSpeed'
import { navCardView, routeSummary, etaLabelOf } from './navView'
import type { RoutePlan } from './routing'

/*
 * "Add a way to show eta at current speed, top speed (for that selected
 * vessel), or a custom speed. If the user is at a standstill the eta shows in
 * days and is not accurate." (2026-09-28)
 */

const boat = { cruiseKn: 25, topKn: 38 }

describe('resolveEtaSpeed', () => {
  it('current: the speed made good along the route, while making way', () => {
    const e = resolveEtaSpeed({ mode: 'current', madeGoodKn: 14.2, sogKn: 15, ...boat })
    expect(e).toMatchObject({ speedKn: 14.2, source: 'current', notMoving: false, label: 'at 14.2 kn (current)', note: null })
  })

  it('current: the speed over the ground only until made good is known', () => {
    expect(resolveEtaSpeed({ mode: 'current', madeGoodKn: null, sogKn: 9, ...boat }).speedKn).toBe(9)
  })

  it('current while stationary or crawling: never an ETA in days — cruise, said plainly', () => {
    for (const made of [0, 0.4, 1.2, MOVING_KN - 0.01, -3]) {
      const e = resolveEtaSpeed({ mode: 'current', madeGoodKn: made, sogKn: 0.3, ...boat })
      expect(e.speedKn).toBe(25)
      expect(e.notMoving).toBe(true)
      expect(e.note).toBe('Not moving — ETA at cruise 25 kn')
    }
    // Going fast the wrong way is not making way along the route either.
    expect(resolveEtaSpeed({ mode: 'current', madeGoodKn: -12, sogKn: 12, ...boat }).notMoving).toBe(true)
    // With no cruise speed set: top speed, and says so; with neither, no ETA.
    expect(resolveEtaSpeed({ mode: 'current', madeGoodKn: 0, topKn: 38 }).note).toBe('Not moving — ETA at top speed 38 kn')
    expect(resolveEtaSpeed({ mode: 'current', madeGoodKn: 0 })).toMatchObject({ speedKn: null, note: 'Not moving — no ETA' })
  })

  it('cruise and top: the selected boat’s own speeds', () => {
    expect(resolveEtaSpeed({ mode: 'cruise', ...boat })).toMatchObject({ speedKn: 25, label: 'at 25 kn (cruise)' })
    expect(resolveEtaSpeed({ mode: 'top', ...boat })).toMatchObject({ speedKn: 38, label: 'at 38 kn (top)' })
    expect(resolveEtaSpeed({ mode: 'top', cruiseKn: 25, topKn: 0 }).note).toBe('No top speed set for this boat — ETA at cruise 25 kn')
  })

  it('custom: the crew’s speed, in their own unit on the label', () => {
    expect(resolveEtaSpeed({ mode: 'custom', customKn: 18, ...boat })).toMatchObject({ speedKn: 18, label: 'at 18 kn (custom)' })
    expect(resolveEtaSpeed({ mode: 'custom', customKn: 18, unit: 'mph', ...boat }).label).toBe('at 20.7 mph (custom)')
    expect(resolveEtaSpeed({ mode: 'custom', customKn: null, ...boat }).note).toBe('No custom speed set — ETA at cruise 25 kn')
  })
})

describe('parseCustomSpeed', () => {
  it('reads a number in the crew’s unit', () => {
    expect(parseCustomSpeed('18')).toEqual({ kn: 18, error: null })
    expect(parseCustomSpeed(' 18,5 ').kn).toBeCloseTo(18.5)
    expect(parseCustomSpeed('20', 'kmh').kn).toBeCloseTo(10.8, 1)
  })
  it('refuses what cannot be a boat’s speed, in plain words', () => {
    expect(parseCustomSpeed('').error).toBe('Enter a speed.')
    expect(parseCustomSpeed('fast').error).toMatch(/as a number/)
    expect(parseCustomSpeed('-3').error).toMatch(/as a number/)
    expect(parseCustomSpeed('0').error).toMatch(/more than 0/)
    expect(parseCustomSpeed('0.5').error).toMatch(/under 1 kn/)
    expect(parseCustomSpeed('400').error).toMatch(/over 80 kn/)
  })
  it('formats speeds without a pointless decimal', () => {
    expect(speedText(25)).toBe('25 kn')
    expect(speedText(14.24)).toBe('14.2 kn')
  })
})

/* A two-leg route, 10 NM, for the card and the summary. */
const A = { lat: 29.3, lon: -94.8 }
const B = { lat: 29.3 + 5 / 60, lon: -94.8 }
const C = { lat: 29.3 + 10 / 60, lon: -94.8 }
const leg = (n: number, from: typeof A, to: typeof A) => ({
  n, from, to, courseDeg: 0, lengthNM: 5, kind: 'search', etaHours: 0, minChartedDepthM: 5,
  channelFraction: null, caution: 'ok', minClearanceM: 50,
})
const PLAN = {
  points: [A, B, C],
  legs: [leg(1, A, B), leg(2, B, C)],
  totalNM: 10,
  hours: 0.5,
  source: 'charted',
  coverage: 'full',
  warnings: [],
  movedStart: null,
  movedEnd: null,
  outsideChannelNM: null,
  arrivalFt: [150, 150, 150],
  failure: null,
  needsConfirm: false,
} as unknown as RoutePlan

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0)
const card = (extra: object) =>
  navCardView({
    plan: PLAN,
    status: 'navigating',
    targetIdx: 1,
    fix: { lat: A.lat, lon: A.lon, accuracy: 5, heading: 0, speed: 0, timestamp: NOW },
    now: NOW,
    speedKn: 0.2,
    cruiseKn: 25,
    arrivalFt: 150,
    bearingPref: 'true',
    declination: null,
    gpsPoor: false,
    rerouting: false,
    offCourseSince: null,
    ...extra,
  })

describe('the steering card follows the ETA choice', () => {
  it('stationary with "current": the time at cruise, labelled "Not moving" — never days', () => {
    const v = card({ etaMode: 'current', madeGoodKn: 0.1, topKn: 38 })
    expect(v.notMoving).toBe(true)
    expect(v.etaLabel).toBe('Not moving — ETA at cruise 25 kn')
    // 10 NM at 25 kn, plus the arrival and turn allowance: well under an hour.
    expect(v.timeToGo).toMatch(/^2\d\smin$/)
    expect(v.timeToGo).not.toMatch(/d|day/)
  })

  it('under way with "current": the speed made good', () => {
    const v = card({ etaMode: 'current', madeGoodKn: 10, speedKn: 10, topKn: 38 })
    expect(v.etaLabel).toBe('ETA at 10 kn (current)')
    expect(v.timeToGo).toMatch(/^1\sh \d\smin$/)
  })

  it('"top" and "custom" work the time at exactly that speed', () => {
    const top = card({ etaMode: 'top', topKn: 40 })
    expect(top.etaLabel).toBe('ETA at 40 kn (top)')
    expect(top.timeToGo).toMatch(/^1\d\smin$/)
    const custom = card({ etaMode: 'custom', customKn: 5, topKn: 40 })
    expect(custom.etaLabel).toBe('ETA at 5 kn (custom)')
    expect(custom.timeToGo).toMatch(/^2\sh \d+\smin$/)
  })

  it('without a choice it is the card it always was', () => {
    const v = card({})
    expect(v.etaLabel).toBeNull()
    expect(v.notMoving).toBe(false)
  })
})

describe('the route summary follows the ETA choice', () => {
  it('works the time at the chosen speed, and says which', () => {
    const top = resolveEtaSpeed({ mode: 'top', ...boat })
    const s = routeSummary(PLAN, { now: NOW, eta: top })
    expect(s.line).toMatch(/^10\.0+ NM · 1\d\smin · ETA /)
    expect(s.etaLabel).toBe('ETA at 38 kn (top)')
    const still = resolveEtaSpeed({ mode: 'current', madeGoodKn: 0, ...boat })
    expect(routeSummary(PLAN, { now: NOW, eta: still }).etaLabel).toBe('Not moving — ETA at cruise 25 kn')
    expect(etaLabelOf(null)).toBeNull()
  })
})
