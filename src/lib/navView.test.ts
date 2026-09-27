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
  declutterMarks,
  gpsChip,
  legNote,
  noBreakMeridiem,
  reconfirmBannerView,
  showNavBanner,
  failureFrame,
  groupLabelBox,
  initialTab,
  keepUnitsTogether,
  safetyMarginM,
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
    expect(b).toEqual({
      primary: 'You have arrived at Datum',
      secondary: null,
      tone: 'arrived',
      alertText: null,
    })
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
    // Reworded on purpose (finding R13): a 50 ft Search-tab setting no
    // longer applies to routes — they use 100 ft, and the note says so.
    expect(arrivalSettingNote(50, ROUTE_ARRIVAL_FT_CHOICES)).toMatch(
      /^The Search tab is set to 50 ft for search patterns; routes use 100 ft/,
    )
  })
})

/* -------------------------------------------------------------------------
 * Review fixes
 * ---------------------------------------------------------------------- */

describe('leg notes say what is actually wrong (R5, R10, R12)', () => {
  it('a hop off a dock the chart draws as land is dotted, "by eye" — not red', () => {
    const rows = legRows([leg(1, { caution: 'off-chart-end' }), leg(2), leg(3, { caution: 'off-chart-end' })])
    expect(rows[0].dotted).toBe(true)
    expect(rows[0].flagged).toBe(false)
    expect(rows[0].note).toMatch(/^Leave the dock by eye/)
    expect(rows[2].note).toMatch(/^Come alongside by eye/)
    expect(segmentStyle({ state: 'ahead', caution: 'off-chart-end' }).dash).not.toBeNull()
  })

  it('a leg over land is not "too shallow — 0 ft"', () => {
    const [row] = legRows([leg(1, { caution: 'unsafe-depth', minChartedDepthM: 0, overLand: true })])
    expect(row.note).toBe('Over land on the chart — leave or approach by eye')
  })

  it('quotes the least depth OUTSIDE the dock stretches — the figure the warning quotes', () => {
    const [row] = legRows([
      leg(1, { caution: 'unsafe-depth', minChartedDepthM: 0.3, minDepthOutsideM: 0.8 }),
    ])
    expect(row.note).toBe(`Too shallow — ${feetFirst(0.8)} charted`)
  })

  it('a leg flagged for shallow water beside it says how close', () => {
    const [row] = legRows([
      leg(1, { caution: 'unsafe-depth', minChartedDepthM: 4, nearShoalDepthM: 1.8, nearShoalDistM: 2 }),
    ])
    expect(row.note).toBe(`Passes ${feetFirst(2)} from ${feetFirst(1.8)} water`)
  })

  it('an approach leg says whether it was the depth, the stand-off, or both', () => {
    const depth = legNote(leg(1, { caution: 'shallow-approach', approachReasons: ['depth'] }))
    const close = legNote(
      leg(1, { caution: 'shallow-approach', approachReasons: ['clearance'], minClearanceM: 4.6 }),
    )
    const both = legNote(
      leg(1, { caution: 'shallow-approach', approachReasons: ['depth', 'clearance'], minClearanceM: 4.6 }),
    )
    expect(depth).toBe('Check depth here')
    expect(close).toBe(`Passes ${feetFirst(4.6)} from land or a structure near the end — keep a lookout`)
    expect(both).toMatch(/^Check depth here · Passes/)
  })

  it('a leg not checked for the new boat says so', () => {
    expect(legNote(leg(1, { caution: 'unsafe-depth', unverified: true }))).toMatch(/Not checked/)
  })
})

describe('the card and banner on a flagged leg (R11)', () => {
  const flaggedPlan = {
    ...PLAN,
    legs: [leg(1), leg(2, { caution: 'unsafe-depth' as const, minChartedDepthM: 0.9 }), leg(3)],
  }

  it('says the leg being run is flagged, in red, and the banner turns to an alert', () => {
    const v = navCardView(input({ plan: flaggedPlan, targetIdx: 2 }))
    expect(v.legCaution).toBe('unsafe-depth')
    const n = v.notices.find((x) => x.kind === 'leg-caution')
    expect(n?.tone).toBe('alert')
    expect(n?.text).toBe(`This leg: too shallow — ${feetFirst(0.9)} charted`)
    const b = navBannerView(v)
    expect(b.tone).toBe('alert')
    expect(b.primary).toMatch(/^Shallow leg · /)
  })

  it('says nothing for a sound leg, or one already run', () => {
    expect(navCardView(input({ plan: flaggedPlan, targetIdx: 3 })).notices.some((x) => x.kind === 'leg-caution')).toBe(false)
    const ok = navCardView(input({ targetIdx: 2 }))
    expect(ok.notices.some((x) => x.kind === 'leg-caution')).toBe(false)
    expect(navBannerView(ok).tone).toBe('normal')
  })

  it('a shallow approach leg is a caution (amber), not an alert', () => {
    const plan = { ...PLAN, legs: [leg(1), leg(2, { caution: 'shallow-approach' as const }), leg(3)] }
    const v = navCardView(input({ plan, targetIdx: 2 }))
    expect(v.notices.find((x) => x.kind === 'leg-caution')?.tone).toBe('caution')
    expect(navBannerView(v).tone).toBe('normal')
  })
})

describe('re-route needing confirmation, and water too shallow under the boat (R2, voyage-1)', () => {
  it('keeps the card, says a re-route needs the crew’s OK, and the banner alerts on every tab', () => {
    const v = navCardView(input({ pendingReroute: true }))
    expect(v.notices.find((x) => x.kind === 'reroute-confirm')?.text).toMatch(/needs your confirmation/)
    const b = navBannerView(v)
    expect(b.tone).toBe('alert')
    expect(b.primary).toMatch(/^Re-route needs your OK/)
    expect(b.alertText).toBe('Re-route needs your OK')
  })

  it('says so when the chart puts the boat in water shallower than it needs', () => {
    const v = navCardView(input({ shallowHere: { depthM: 1.8, land: false } }))
    expect(v.notices.find((x) => x.kind === 'shallow-here')?.text).toBe(
      `Charted depth here ${feetFirst(1.8)} — less than your boat needs. Check your depth now.`,
    )
    expect(navBannerView(v).tone).toBe('alert')
  })

  it('a paused route keeps a banner up, as an alert', () => {
    const b = reconfirmBannerView()
    expect(b.tone).toBe('alert')
    expect(b.primary).toMatch(/not fully safe/)
  })
})

describe('a failed re-route on the card (R8)', () => {
  it('is shown while it stands, and not once the store has cleared it', () => {
    const v = navCardView(input({ rerouteError: 'Could not re-route: offline' }))
    expect(v.notices.some((x) => x.kind === 'error' && /offline/.test(x.text))).toBe(true)
    expect(navCardView(input({ rerouteError: null })).notices.some((x) => x.kind === 'error')).toBe(false)
  })
})

describe('freshness on the phone clock (R14)', () => {
  it('a fix stamped a minute off by GNSS time, that has just arrived, is live on the card', () => {
    const fix = { ...go(B, 90, 0.5), timestamp: NOW - 60_000, receivedAt: NOW - 1_000, accuracy: 5, heading: 90 }
    const v = navCardView(input({ fix }))
    expect(v.stale).toBe(false)
  })
})

describe('the clock never wraps (UI-11)', () => {
  it('puts a no-break space before AM/PM', () => {
    expect(noBreakMeridiem('04:10 AM')).toBe('04:10\u00a0AM')
    expect(noBreakMeridiem('04:10\u202fp.m.')).toBe('04:10\u00a0p.m.')
    expect(noBreakMeridiem('14:52')).toBe('14:52')
  })
})

describe('gpsChip — the header agrees with the card (UI-8)', () => {
  it('says "GPS lost" while the watch runs but no fix has come for 15 s', () => {
    expect(gpsChip(true, { timestamp: NOW - 18_000 }, NOW).label).toBe('GPS lost')
    expect(gpsChip(true, null, NOW).label).toBe('GPS lost')
    expect(gpsChip(true, { timestamp: NOW - 2_000 }, NOW).label).toBe('GPS live')
    expect(gpsChip(false, { timestamp: NOW - 2_000 }, NOW).label).toBe('GPS fix')
    expect(gpsChip(false, null, NOW).label).toBe('GPS off')
    expect(gpsChip(true, { timestamp: NOW - 18_000 }, NOW).title).toMatch(/No fix for 18 s/)
  })
})

describe('declutterMarks (UI-4)', () => {
  it('leaves out turn points on top of each other, never the start, the end or the active one', () => {
    const marks = routeMarks([A, B, B, B, C], 3)
    const xy = (m: { idx: number }) => ({ x: [0, 100, 105, 110, 200][m.idx], y: 0 })
    const kept = declutterMarks(marks, xy)
    expect(kept.map((k) => k.mark.idx)).toEqual([0, 1, 3, 4])
    expect(kept[1].hidden).toEqual([2])
  })
})

describe('showNavBanner (UI-1, R2)', () => {
  const base = { onChartTab: false, status: 'navigating', reconfirm: false, cardInView: true }
  it('is up on the other tabs while steering, and on the Chart tab only when its card is out of view', () => {
    expect(showNavBanner(base)).toBe(true)
    expect(showNavBanner({ ...base, onChartTab: true })).toBe(false)
    expect(showNavBanner({ ...base, onChartTab: true, cardInView: false })).toBe(true)
    expect(showNavBanner({ ...base, status: 'arrived' })).toBe(true)
  })
  it('stays up while steering is paused for review, and not for an ordinary preview', () => {
    expect(showNavBanner({ ...base, status: 'preview', reconfirm: true })).toBe(true)
    expect(showNavBanner({ ...base, status: 'preview' })).toBe(false)
    expect(showNavBanner({ ...base, status: 'idle' })).toBe(false)
  })
})

describe('failureFrame (UI-10)', () => {
  it('frames the boat and the destination that failed, 0.87 NM away — not just the boat', () => {
    const dest = go(A, 217, 0.87)
    const f = failureFrame({ status: 'failed', dest, origin: null, fix: A, lastPlannedAt: 5 })!
    expect(f.points).toEqual([
      { lat: A.lat, lon: A.lon },
      { lat: dest.lat, lon: dest.lon },
    ])
    expect(f.key).toBe('none:5')
  })
  it('uses a start chosen by hand, and frames the destination alone with no position', () => {
    const origin = go(A, 90, 1)
    expect(failureFrame({ status: 'failed', dest: B, origin, fix: A, lastPlannedAt: 1 })!.points[0]).toEqual(origin)
    expect(failureFrame({ status: 'failed', dest: B, origin: null, fix: null, lastPlannedAt: 1 })!.points).toHaveLength(1)
  })
  it('is nothing unless planning failed', () => {
    expect(failureFrame({ status: 'preview', dest: B, origin: null, fix: A, lastPlannedAt: 1 })).toBeNull()
  })
})

describe('rounding a turn point first (C1)', () => {
  // Switched to C (index 2) 150 ft short of B, but the line to C is not clear.
  const here = { ...go(B, 180, ft(150)), timestamp: NOW - 1000, accuracy: 5, heading: 0 }

  it('steers to the turn point, says so, and counts the distance to go through it', () => {
    const v = navCardView(input({ fix: here, targetIdx: 2, roundIdx: 1 }))
    expect(v.rounding).toBe(true)
    expect(v.targetIdx).toBe(1)
    expect(v.title).toBe('Round waypoint 1 first — don’t cut the corner')
    // The bearing to B — shown even though the boat is inside B's circle.
    expect(v.atMark).toBe(false)
    expect(v.bearing).toBe('000°T')
    expect(v.distance).toBe('150 ft')
    expect(v.radiusText).toBe('Then waypoint 2')
    expect(v.then).toBe('Then 090°T for 1.00 NM')
    // 150 ft to B, then B→C and C→D.
    expect(v.remaining).toBe(`${(ft(150) + 2).toFixed(2)} NM`)
    expect(v.notices.find((n) => n.kind === 'round-first')?.text).toMatch(
      /straight line from here to waypoint 2 is not clear.*Steer for waypoint 1 until it is/,
    )
    const b = navBannerView(v)
    expect(b.primary).toBe('Round WP 1 first · 000°T · 150 ft')
    expect(b.tone).toBe('alert')
  })

  it('names the destination when that is the point after the turn', () => {
    const v = navCardView(input({ fix: here, targetIdx: 3, roundIdx: 2 }))
    expect(v.radiusText).toBe('Then the destination')
  })

  it('is ordinary steering with no turn point to round', () => {
    const v = navCardView(input({ fix: here, targetIdx: 2, roundIdx: null }))
    expect(v.rounding).toBe(false)
    expect(v.title).toBe('To waypoint 2 of 3')
  })
})

describe('the GPS error against the boat’s margins (M1)', () => {
  it('takes the smaller of the stand-off and the depth margin', () => {
    expect(safetyMarginM(30)).toBe(10)
    expect(safetyMarginM(5)).toBe(5)
    expect(safetyMarginM(0)).toBe(10)
    expect(safetyMarginM(null)).toBeNull()
  })

  it('says when the fix is less certain than the margin', () => {
    const fix = { ...go(B, 90, 0.5), timestamp: NOW - 1000, accuracy: 18, heading: 90 }
    const v = navCardView(input({ fix, safetyMarginM: 10 }))
    expect(v.notices.find((n) => n.kind === 'gps-margin')?.text).toBe(
      'GPS accuracy ±59 ft — wider than your safety margin (33 ft). Keep a sharp lookout.',
    )
    expect(navCardView(input({ safetyMarginM: 10 })).notices.some((n) => n.kind === 'gps-margin')).toBe(false)
  })

  it('words water or land within the GPS error as "may be", in amber', () => {
    const fix = { ...go(B, 90, 0.5), timestamp: NOW - 1000, accuracy: 15, heading: 90 }
    const shoal = navCardView(input({ fix, shallowHere: { depthM: 0.9, land: false, maybe: true } }))
    const n = shoal.notices.find((x) => x.kind === 'shallow-here')!
    expect(n.tone).toBe('caution')
    expect(n.text).toBe(
      'You may be in water too shallow for your boat — 3 ft (0.9 m) is charted within your GPS accuracy (±49 ft). Check your depth now.',
    )
    expect(navBannerView(shoal).primary.startsWith('May be shallow')).toBe(true)
    const land = navCardView(input({ fix, shallowHere: { depthM: null, land: true, maybe: true } }))
    expect(land.notices.find((x) => x.kind === 'shallow-here')?.text).toMatch(/^You may be close to land/)
    expect(navBannerView(land).primary.startsWith('Land may be close')).toBe(true)
    // At the fix itself it is still a fact, in red.
    const here = navCardView(input({ fix, shallowHere: { depthM: 0.9, land: false } }))
    expect(here.notices.find((x) => x.kind === 'shallow-here')?.tone).toBe('alert')
    expect(navBannerView(here).primary.startsWith('Shallow here')).toBe(true)
  })
})

describe('the ETA at the speed made good (N2)', () => {
  it('works the time at the route speed when there is one, and says so', () => {
    const v = navCardView(input({ speedKn: 20, routeSpeedKn: 10 }))
    // 0.5 NM to C, then 1 NM to D, at 10 kn: 9 min.
    expect(v.timeToGo).toBe('9 min')
    expect(v.speedNote).toBe('at 10.0 kn made good along the route')
    expect(navCardView(input({ speedKn: 20 })).speedNote).toBe('at 20.0 kn')
  })
})

describe('narrow screens (UI-1)', () => {
  it('keeps each number with its unit, so a cell breaks between them', () => {
    expect(keepUnitsTogether('10 h 16 min')).toBe('10\u00a0h 16\u00a0min')
    expect(keepUnitsTogether('1 d 3 h')).toBe('1\u00a0d 3\u00a0h')
    expect(keepUnitsTogether('under a minute')).toBe('under a minute')
  })
})

describe('the map’s turn points (UI-3, UI-7)', () => {
  it('never folds waypoint 1 into the start, which has no number', () => {
    const marks = routeMarks([A, B, B, C], null)
    const xy = (m: { idx: number }) => ({ x: [0, 8, 14, 200][m.idx], y: 0 })
    const kept = declutterMarks(marks, xy)
    expect(kept.map((k) => k.mark.idx)).toEqual([0, 1, 3])
    expect(kept[1].hidden).toEqual([2])
  })

  it('folds a group whose label would lie across another group’s label', () => {
    // 5–9 at x = 100; 10–11 just left of it and a little above — their
    // "5–9" and "10–11" labels were drawn across each other.
    const pts = Array.from({ length: 14 }, () => A)
    const marks = routeMarks(pts, null)
    const pos: Record<number, [number, number]> = {
      0: [-300, 0], 1: [-200, 0], 2: [-150, 0], 3: [-100, 0], 4: [-50, 0],
      5: [100, 0], 6: [102, 0], 7: [104, 0], 8: [106, 0], 9: [108, 0],
      10: [80, -4], 11: [82, -4], 12: [300, 0], 13: [400, 0],
    }
    const xy = (m: { idx: number }) => ({ x: pos[m.idx][0], y: pos[m.idx][1] })
    const kept = declutterMarks(marks, xy)
    const g5 = kept.find((k) => k.mark.idx === 5)!
    expect(kept.some((k) => k.mark.idx === 10)).toBe(false)
    expect(g5.hidden).toEqual([6, 7, 8, 9, 10, 11])
    // And no two group labels left overlap.
    const boxes = kept
      .filter((k) => k.hidden.length > 0)
      .map((k) => groupLabelBox(k.mark, xy(k.mark), k.hidden))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false)
      }
    }
  })
})

describe('the tab the app opens on (UI-5)', () => {
  it('is the Chart tab while a passage is steered, Home otherwise', () => {
    expect(initialTab('navigating')).toBe('chart')
    expect(initialTab('arrived')).toBe('chart')
    expect(initialTab('preview')).toBe('home')
    expect(initialTab('idle')).toBe('home')
  })
})

describe('the card off the line, and on a poor fix (F3, F4)', () => {
  it('leads with the course back onto the line, and still shows the point’s bearing and distance', () => {
    // 45 ft (14 m) south — right — of the eastbound leg B→C, half-way along.
    const fix = { ...go(go(B, 90, 0.5), 180, 14 / 1852), timestamp: NOW - 1000, accuracy: 3, heading: 90 }
    const v = navCardView(input({ fix }))
    expect(v.pointBearing).toMatch(/^0(8|9)\d°T$/)
    expect(v.bearing).not.toBe(v.pointBearing)
    // Back onto the line means steering left of the point (north of east).
    expect(Number(v.bearing!.slice(0, 3))).toBeLessThan(Number(v.pointBearing!.slice(0, 3)))
    expect(v.xteFt).toBeCloseTo(46, -1)
    expect(v.backOnLine).toMatch(/^Steer \d+° left to get back on the line · 4\d ft off track$/)
    // The turn cue answers the course to steer, not the bearing to the point.
    expect(v.turn?.kind === 'turn' && v.turn.side).toBe('left')
  })

  it('says nothing about the line when the boat is on it', () => {
    const v = navCardView(input())
    expect(v.backOnLine).toBeNull()
    expect(v.bearing).toBe(v.pointBearing)
  })

  it('goes red — "Slow down" — when the store says the GPS is too poor for what lies ahead', () => {
    const fix = { ...go(B, 90, 0.5), timestamp: NOW - 1000, accuracy: 18, heading: 90 }
    const v = navCardView(input({ fix, gpsSlow: true, safetyMarginM: 5 }))
    expect(v.slowDown).toBe(true)
    const n = v.notices.find((x) => x.kind === 'gps-slow')!
    expect(n.tone).toBe('alert')
    expect(n.text).toMatch(/^Slow down — GPS not accurate enough here/)
    // It replaces the amber margin notice rather than repeating it.
    expect(v.notices.some((x) => x.kind === 'gps-margin')).toBe(false)
    const b = navBannerView(v)
    expect(b.tone).toBe('alert')
    expect(b.primary.startsWith('Slow down')).toBe(true)
    // Not on a stale fix, and not without the store's say-so.
    expect(navCardView(input({ fix, gpsSlow: false, safetyMarginM: 5 })).slowDown).toBe(false)
    expect(navCardView(input({ fix: { ...fix, timestamp: NOW - 60_000 }, gpsSlow: true })).slowDown).toBe(false)
  })
})
