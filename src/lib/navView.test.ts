import { describe, it, expect } from 'vitest'
import {
  arrivalSettingNote,
  bearingText,
  declinationFor,
  etaText,
  feetFirst,
  formatClock,
  hasRoute,
  legRows,
  navBannerView,
  navCardView,
  needsConfirmation,
  planFailureView,
  routeMarks,
  routeSegments,
  routeSummary,
  segmentStyle,
  type NavCardInput,
} from './navView'
import { projectPosition } from './sar'
import { FT_PER_NM, ROUTE_ARRIVAL_FT_CHOICES } from './steer'
import { declinationAt } from './geomag'
import type { LatLon } from './search'
import type { RouteLeg } from './routing'

const ft = (n: number) => n / FT_PER_NM
const go = (p: LatLon, deg: number, nm: number) => projectPosition(p.lat, p.lon, deg, nm)

const A = { lat: 29.3, lon: -94.8 }
/** North 1 NM to B, east 1 NM to C, north 1 NM to D. */
const B = go(A, 0, 1)
const C = go(B, 90, 1)
const D = go(C, 0, 1)

function leg(n: number, extra: Partial<RouteLeg> = {}): RouteLeg {
  return {
    n,
    courseDeg: n === 2 ? 90 : 0,
    lengthNM: 1,
    etaHours: n,
    minChartedDepthM: 5,
    channelFraction: null,
    caution: 'ok',
    minClearanceM: null,
    ...extra,
  } as RouteLeg
}

const PLAN = {
  points: [A, B, C, D],
  legs: [leg(1), leg(2), leg(3)],
  arrivalFt: [150, 150, 150, 150],
}

const NOW = new Date(2026, 8, 27, 14, 0, 0).getTime()

function input(over: Partial<NavCardInput> = {}): NavCardInput {
  return {
    plan: PLAN,
    status: 'navigating',
    targetIdx: 2,
    fix: { ...go(B, 90, 0.5), timestamp: NOW - 1000, accuracy: 5, heading: 90 },
    now: NOW,
    speedKn: 10,
    cruiseKn: 20,
    arrivalFt: 150,
    bearingPref: 'true',
    declination: null,
    gpsPoor: false,
    rerouting: false,
    offCourseSince: null,
    error: null,
    destLabel: 'Datum',
    ...over,
  }
}

describe('small formatters', () => {
  it('writes feet first, metres in brackets', () => {
    expect(feetFirst(0.9144)).toBe('3 ft (0.9 m)')
    expect(feetFirst(1.5)).toBe('4.9 ft (1.5 m)')
    expect(feetFirst(30.48)).toBe('100 ft (30 m)')
    expect(feetFirst(null)).toBe('—')
  })

  it('marks an ETA that falls tomorrow', () => {
    const today = formatClock(NOW + 3_600_000, NOW)!
    expect(today.dayOffset).toBe(0)
    expect(today.dayMark).toBe('')
    const late = new Date(2026, 8, 27, 23, 40).getTime()
    const tomorrow = formatClock(late + 90 * 60_000, late)!
    expect(tomorrow.dayOffset).toBe(1)
    expect(tomorrow.dayMark).toBe('+1 day')
    expect(etaText(tomorrow)).toMatch(/^ETA .+ \+1 day$/)
    expect(formatClock(NOW + 50 * 3_600_000, NOW)!.dayMark).toBe('+2 days')
    expect(formatClock(Number.NaN, NOW)).toBeNull()
  })

  it('labels every bearing with its north', () => {
    expect(bearingText(47, 'true', null)).toBe('047°T')
    expect(bearingText(47, 'magnetic', 5)).toBe('042°M')
    // Magnetic asked for, but no declination known: true, and says so.
    expect(bearingText(47, 'magnetic', null)).toBe('047°T')
  })

  it('works a declination from the model, cached', () => {
    const d = declinationFor(29.3, -94.8, NOW)!
    expect(d).toBeCloseTo(declinationAt(29.25, -94.75, 0, new Date(NOW)), 6)
    expect(declinationFor(29.31, -94.79, NOW)).toBe(d)
    expect(declinationFor(Number.NaN, 0)).toBeNull()
  })
})

describe('routeSummary', () => {
  it('reads like a route-finder: distance · time · ETA', () => {
    const s = routeSummary({ totalNM: 12.4, hours: 1 }, { cruiseKn: 20, now: NOW })
    expect(s.distance).toBe('12.4 NM')
    expect(s.duration).toBe('37 min')
    expect(s.line).toMatch(/^12\.4 NM · 37 min · ETA \S+/)
  })

  it('falls back to the planned time, and to distance alone', () => {
    expect(routeSummary({ totalNM: 5, hours: 0.5 }, { now: NOW }).duration).toBe('30 min')
    const bare = routeSummary({ totalNM: 5, hours: Number.NaN }, { cruiseKn: 0, now: NOW })
    expect(bare.line).toBe('5.00 NM')
    expect(bare.eta).toBeNull()
  })
})

describe('legRows', () => {
  it('flags unsafe legs with their least depth or clearance, dots approaches', () => {
    const rows = legRows([
      leg(1, { caution: 'shallow-approach' }),
      leg(2, { caution: 'unsafe-depth', minChartedDepthM: 0.9144 }),
      leg(3, { caution: 'reduced-clearance', minClearanceM: 6.096 }),
      leg(4),
      leg(5, { caution: 'unsafe-depth', minChartedDepthM: null }),
    ])
    expect(rows.map((r) => [r.flagged, r.dotted])).toEqual([
      [false, true],
      [true, false],
      [true, false],
      [false, false],
      [true, false],
    ])
    expect(rows[0].note).toBe('Check depth here')
    expect(rows[1].note).toBe('Too shallow — 3 ft (0.9 m) charted')
    expect(rows[2].note).toBe('Close to land or a hazard — 20 ft (6.1 m) off')
    expect(rows[3].note).toBeNull()
    expect(rows[4].note).toBe('Too shallow — not surveyed')
  })

  it('uses the crew’s depth unit when given one', () => {
    const rows = legRows([leg(1, { caution: 'unsafe-depth', minChartedDepthM: 1 })], {
      formatDepth: (m) => `${m} m`,
    })
    expect(rows[0].note).toBe('Too shallow — 1 m charted')
  })
})

describe('plan gates', () => {
  it('needs confirmation for best-effort plans only', () => {
    expect(needsConfirmation({ source: 'best-effort', needsConfirm: true })).toBe(true)
    expect(needsConfirmation({ source: 'best-effort', needsConfirm: false })).toBe(true)
    expect(needsConfirmation({ source: 'charted', needsConfirm: false })).toBe(false)
    expect(needsConfirmation(null)).toBe(false)
  })

  it('has a route only with a line of at least one leg, never for none', () => {
    expect(hasRoute({ source: 'charted', points: [A, B] })).toBe(true)
    expect(hasRoute({ source: 'none', points: [] })).toBe(false)
    expect(hasRoute({ source: 'charted', points: [A] })).toBe(false)
    expect(hasRoute(null)).toBe(false)
  })
})

describe('the route on the map', () => {
  it('draws a preview all ahead', () => {
    const segs = routeSegments(PLAN, null)
    expect(segs).toHaveLength(3)
    expect(segs.every((s) => s.state === 'ahead')).toBe(true)
    expect(segs[1].from).toBe(B)
    expect(segs[1].to).toBe(C)
  })

  it('fades what is behind, brightens the leg being run', () => {
    const segs = routeSegments(
      { ...PLAN, legs: [leg(1), leg(2, { caution: 'unsafe-depth' }), leg(3)] },
      2,
    )
    expect(segs.map((s) => s.state)).toEqual(['behind', 'active', 'ahead'])
    expect(segs[1].caution).toBe('unsafe-depth')
  })

  it('has no active leg while getting to the start', () => {
    expect(routeSegments(PLAN, 0).map((s) => s.state)).toEqual(['ahead', 'ahead', 'ahead'])
  })

  it('numbers the turn points and rings the active one', () => {
    const marks = routeMarks(PLAN.points, 2)
    expect(marks.map((m) => m.kind)).toEqual(['start', 'turn', 'turn', 'end'])
    expect(marks.map((m) => m.label)).toEqual(['', '1', '2', '3'])
    expect(marks.map((m) => m.state)).toEqual(['passed', 'passed', 'active', 'upcoming'])
    expect(routeMarks(PLAN.points, null).every((m) => m.state === 'upcoming')).toBe(true)
  })

  it('styles legs: behind faint, flagged red whatever, approaches dotted', () => {
    const behind = segmentStyle({ state: 'behind', caution: 'ok' })
    expect(behind.opacity).toBeLessThan(1)
    expect(behind.color).toBe('#94a3b8')
    const red = segmentStyle({ state: 'ahead', caution: 'reduced-clearance' })
    expect(red.color).toBe('#f87171')
    expect(red.dash).toBeNull()
    const dots = segmentStyle({ state: 'ahead', caution: 'shallow-approach' })
    expect(dots.dash).not.toBeNull()
    expect(dots.linecap).toBe('round')
    const active = segmentStyle({ state: 'active', caution: 'ok' })
    const ahead = segmentStyle({ state: 'ahead', caution: 'ok' })
    expect(active.width).toBeGreaterThan(ahead.width)
    expect(active.color).not.toBe(ahead.color)
  })
})

describe('navCardView', () => {
  it('names the next waypoint, bearing (T) and distance', () => {
    const v = navCardView(input())
    expect(v.title).toBe('To waypoint 2 of 3')
    expect(v.bearing).toBe('090°T')
    expect(v.distance).toMatch(/^0\.50 NM$/)
    expect(v.stale).toBe(false)
    expect(v.notices).toEqual([])
    expect(v.then).toBe('Then 000°T for 1.00 NM')
  })

  it('gives distance in feet under a tenth of a mile', () => {
    const v = navCardView(input({ fix: { ...go(C, 270, ft(420)), timestamp: NOW, heading: 90 } }))
    expect(v.distance).toBe('420 ft')
  })

  it('gives the bearing magnetic when asked and a declination is known', () => {
    expect(navCardView(input({ bearingPref: 'magnetic', declination: 3 })).bearing).toBe('087°M')
    expect(navCardView(input({ bearingPref: 'magnetic', declination: null })).bearing).toBe('090°T')
  })

  it('withholds the bearing inside the arrival circle', () => {
    const v = navCardView(input({ fix: { ...go(C, 270, ft(60)), timestamp: NOW, heading: 90 } }))
    expect(v.atMark).toBe(true)
    expect(v.bearing).toBeNull()
    expect(v.turn).toBeNull()
  })

  it('says which way to turn from the course over ground', () => {
    const right = navCardView(input({ fix: { ...go(B, 90, 0.5), timestamp: NOW, heading: 45 } }))
    expect(right.turn).toMatchObject({ kind: 'turn', side: 'right', deg: 45, text: 'Come right 45°' })
    const left = navCardView(input({ fix: { ...go(B, 90, 0.5), timestamp: NOW, heading: 120 } }))
    expect(left.turn).toMatchObject({ kind: 'turn', side: 'left', deg: 30 })
    const on = navCardView(input({ fix: { ...go(B, 90, 0.5), timestamp: NOW, heading: 92 } }))
    expect(on.turn).toEqual({ kind: 'ahead', text: 'Steady — on course' })
    const none = navCardView(input({ fix: { ...go(B, 90, 0.5), timestamp: NOW, heading: null } }))
    expect(none.turn).toBeNull()
  })

  it('gives distance and time to the END, and the ETA clock', () => {
    const v = navCardView(input())
    // 0.5 NM to C, then 1 NM to D.
    expect(v.remaining).toBe('1.50 NM')
    expect(v.timeToGo).toBe('9 min')
    expect(v.eta?.dayOffset).toBe(0)
    expect(v.speedNote).toBe('at 10.0 kn')
  })

  it('works the time at cruise when the boat is not making way, and says so', () => {
    const v = navCardView(input({ speedKn: 0.3 }))
    expect(v.speedNote).toBe('at cruise speed, 20 kn — not making way over the ground')
    expect(v.timeToGo).toBe('5 min')
    expect(navCardView(input({ speedKn: null })).speedNote).toBe(
      'at cruise speed, 20 kn — no speed over the ground yet',
    )
  })

  it('marks an ETA after midnight', () => {
    const late = new Date(2026, 8, 27, 23, 55).getTime()
    const v = navCardView(input({ now: late, fix: { ...go(B, 90, 0.5), timestamp: late, heading: 90 } }))
    expect(v.eta?.dayMark).toBe('+1 day')
  })

  it('greys out on a stale fix and says how long ago', () => {
    const v = navCardView(input({ fix: { ...go(B, 90, 0.5), timestamp: NOW - 42_000, heading: 90 } }))
    expect(v.stale).toBe(true)
    expect(v.notices[0]).toEqual({
      kind: 'stale',
      text: 'GPS signal lost — last fix 42 s ago. These numbers are not live.',
    })
    // The last known numbers are still there — greyed, not blanked.
    expect(v.bearing).toBe('090°T')
    // …but no turn instruction from a position that is not live.
    expect(v.turn).toBeNull()
  })

  it('waits for a first fix', () => {
    const v = navCardView(input({ fix: null }))
    expect(v.stale).toBe(true)
    expect(v.distance).toBe('—')
    expect(v.notices[0].kind).toBe('waiting')
  })

  it('shows re-routing, off course and a poor GPS', () => {
    expect(navCardView(input({ rerouting: true })).notices.map((n) => n.text)).toContain('Re-routing…')
    expect(navCardView(input({ offCourseSince: NOW - 3000 })).notices[0].kind).toBe('off-course')
    // Re-routing supersedes the off-course notice.
    const both = navCardView(input({ rerouting: true, offCourseSince: NOW - 3000 }))
    expect(both.notices.map((n) => n.kind)).toEqual(['rerouting'])
    const poor = navCardView(input({ gpsPoor: true, fix: { ...go(B, 90, 0.5), timestamp: NOW, accuracy: 60, heading: 90 } }))
    expect(poor.notices[0]).toMatchObject({ kind: 'gps-poor' })
    expect(poor.notices[0].text).toContain('±197 ft')
    expect(navCardView(input({ error: 'Could not re-route: no signal' })).notices[0].kind).toBe('error')
  })

  it('shows the per-point circle actually in use — a hairpin’s 30 ft', () => {
    const hairpin = { ...PLAN, arrivalFt: [150, 150, 30, 150] }
    const v = navCardView(input({ plan: hairpin, fix: { ...go(B, 90, 0.5), timestamp: NOW, accuracy: 60 } }))
    expect(v.radiusFt).toBe(30)
    expect(v.radiusText).toBe('Counts as reached within 30 ft')
    // The crew's own setting caps it too.
    expect(navCardView(input({ arrivalFt: 100 })).radiusFt).toBe(100)
  })

  it('titles the start and the destination', () => {
    expect(navCardView(input({ targetIdx: 0 })).title).toBe('To the start of the route')
    const last = navCardView(input({ targetIdx: 3 }))
    expect(last.title).toBe('To the destination · Datum')
    expect(last.then).toBeNull()
  })

  it('says you have arrived', () => {
    const v = navCardView(input({ status: 'arrived', targetIdx: 3 }))
    expect(v.phase).toBe('arrived')
    expect(v.arrivedText).toBe('You have arrived at Datum')
    expect(navCardView(input({ status: 'arrived', destLabel: null })).arrivedText).toBe('You have arrived')
  })
})

describe('navBannerView', () => {
  it('fits the next waypoint and the passage on two lines', () => {
    const b = navBannerView(navCardView(input()))
    expect(b.primary).toBe('WP 2 · 090°T · 0.50 NM')
    expect(b.secondary).toMatch(/^1\.50 NM to go · ETA \S+/)
    expect(b.tone).toBe('normal')
  })

  it('leads with re-routing, and goes stale with the fix', () => {
    expect(navBannerView(navCardView(input({ rerouting: true }))).primary).toMatch(/^Re-routing… · WP 2/)
    expect(navBannerView(navCardView(input({ rerouting: true }))).tone).toBe('alert')
    const stale = navCardView(input({ fix: { ...go(B, 90, 0.5), timestamp: NOW - 60_000 } }))
    expect(navBannerView(stale).tone).toBe('stale')
  })

  it('names the destination and the start', () => {
    expect(navBannerView(navCardView(input({ targetIdx: 3 }))).primary).toMatch(/^Dest · /)
    expect(navBannerView(navCardView(input({ targetIdx: 0 }))).primary).toMatch(/^Start · /)
  })

  it('says arrived', () => {
    const b = navBannerView(navCardView(input({ status: 'arrived' })))
    expect(b).toEqual({ primary: 'You have arrived at Datum', secondary: null, tone: 'arrived' })
  })
})

describe('planFailureView', () => {
  const none = { failure: 'No charted water route joins the start and the destination.', coverage: 'full' as const, warnings: [] }

  it('asks for a boat before anything else', () => {
    const v = planFailureView({ error: null, plan: null, hasBoat: false, online: true, originSet: false })
    expect(v.actions).toEqual(['add-boat'])
    expect(v.title).toBe('Set up your boat first')
  })

  it('gives the plain reason, what to change and Retry', () => {
    const v = planFailureView({ error: null, plan: none, hasBoat: true, online: true, originSet: false })
    expect(v.reason).toBe(none.failure)
    expect(v.actions).toEqual(['pick-dest', 'edit-boat', 'retry'])
    expect(v.hints).toEqual([])
  })

  it('prefers the store’s error, and offers the start when one was set by hand', () => {
    const v = planFailureView({ error: 'No GPS position yet.', plan: null, hasBoat: true, online: true, originSet: true })
    expect(v.reason).toBe('No GPS position yet.')
    expect(v.actions).toContain('change-start')
  })

  it('says when the phone is offline, or the area has no chart', () => {
    const off = planFailureView({ error: 'x', plan: null, hasBoat: true, online: false, originSet: false })
    expect(off.hints[0]).toMatch(/offline/)
    const uncharted = planFailureView({
      error: null,
      plan: { failure: 'No chart here.', coverage: 'none', warnings: ['Partial.'] },
      hasBoat: true,
      online: true,
      originSet: false,
    })
    expect(uncharted.hints[0]).toMatch(/no NOAA chart/)
    expect(uncharted.hints).toContain('Partial.')
  })
})

describe('arrivalSettingNote', () => {
  it('explains the setting, and a 50 ft search setting', () => {
    expect(arrivalSettingNote(150, ROUTE_ARRIVAL_FT_CHOICES)).toMatch(/^Steering moves on/)
    expect(arrivalSettingNote(50, ROUTE_ARRIVAL_FT_CHOICES)).toMatch(/^Now 50 ft \(set for search patterns\)/)
  })
})
