import { describe, it, expect } from 'vitest'
import {
  SEARCH_OBJECT_TYPES,
  searchObjectType,
  leewayKts,
  projectPosition,
  observedDrift,
  computeDatum,
  datumReport,
  LKP_ERROR_NM,
  NAV_ERROR_NM,
  type DatumInput,
  driftStartsAt,
  lastMarkerPoint,
  driftLegIsMeaningful,
  describeDriftLeg,
  MAX_PLAUSIBLE_DRIFT_KTS,
  DRIFT_SAMPLE_SECONDS,
} from './sar'
import { haversineNM, bearingDeg } from './geo'

const H = 3_600_000

const baseInput = (over: Partial<DatumInput> = {}): DatumInput => ({
  lkp: { lat: 29.5, lon: -94.8, time: 0 },
  at: 3 * H,
  objectType: searchObjectType('person_in_water'),
  windFromDeg: null,
  windKts: null,
  currentTowardDeg: null,
  currentKts: null,
  lkpErrorNM: LKP_ERROR_NM.gps,
  ...over,
})

describe('search object types', () => {
  it('keys are unique and snake_case (the RescueGPS leeway_type convention)', () => {
    const keys = SEARCH_OBJECT_TYPES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]+$/)
  })

  it('falls back to person in water for an unknown key', () => {
    expect(searchObjectType('flying_carpet').key).toBe('person_in_water')
  })

  it('resolves the pre-canonical NavMate keys to Allen & Plourde codes', () => {
    // Records saved before the ontology alignment carry these.
    expect(searchObjectType('kayak').key).toBe('kayak_sea')
    expect(searchObjectType('life_raft_4_person').key).toBe('life_raft_shallow')
    expect(searchObjectType('medium_vessel').key).toBe('powerboat_cabin')
    expect(searchObjectType('wood_debris').key).toBe('wooden_plank')
  })

  it('leeway follows slope × wind + offset, zero for calm or missing wind', () => {
    // person_in_water: 0.011 × 10 + 0.07 = 0.18 kn (Allen & Plourde 1999).
    const piw = searchObjectType('person_in_water')
    expect(leewayKts(10, piw)).toBeCloseTo(0.18, 5)
    expect(leewayKts(0, piw)).toBe(0)
    expect(leewayKts(Number.NaN, piw)).toBe(0)
  })
})

describe('projectPosition', () => {
  it('lands the projected distance and bearing away', () => {
    const p = projectPosition(29.5, -94.8, 45, 10)
    expect(haversineNM(29.5, -94.8, p.lat, p.lon)).toBeCloseTo(10, 2)
    expect(bearingDeg(29.5, -94.8, p.lat, p.lon)).toBeCloseTo(45, 0)
  })

  it('going east then west returns close to home', () => {
    // Great-circle legs, not rhumb lines, so the return is not exact — but
    // over the distances a datum worksheet handles it must be within metres.
    const out = projectPosition(29.5, -94.8, 90, 5)
    const back = projectPosition(out.lat, out.lon, 270, 5)
    expect(haversineNM(29.5, -94.8, back.lat, back.lon)).toBeLessThan(0.01)
  })
})

describe('observedDrift', () => {
  it('recovers set and drift from a deploy/retrieve pair', () => {
    const deploy = { lat: 29.5, lon: -94.8, time: 0 }
    const end = projectPosition(29.5, -94.8, 120, 3)
    const obs = observedDrift(deploy, { ...end, time: 2 * H })
    expect(obs).not.toBeNull()
    expect(obs!.distanceNM).toBeCloseTo(3, 2)
    expect(obs!.hours).toBeCloseTo(2, 5)
    expect(obs!.driftKts).toBeCloseTo(1.5, 2)
    expect(obs!.setDeg).toBeCloseTo(120, 0)
  })

  it('refuses a retrieve at or before the deploy time', () => {
    const p = { lat: 29.5, lon: -94.8, time: H }
    expect(observedDrift(p, { lat: 29.6, lon: -94.8, time: H })).toBeNull()
    expect(observedDrift(p, { lat: 29.6, lon: -94.8, time: 0 })).toBeNull()
  })
})

describe('computeDatum', () => {
  it('with nothing but an LKP the datum is the LKP and the radius is the position errors', () => {
    const r = computeDatum(baseInput())
    expect(r.datum.lat).toBeCloseTo(29.5, 6)
    expect(r.datum.lon).toBeCloseTo(-94.8, 6)
    expect(r.driftDistanceNM).toBe(0)
    expect(r.totalErrorNM).toBeCloseTo(
      Math.hypot(LKP_ERROR_NM.gps, NAV_ERROR_NM),
      5,
    )
    expect(r.searchRadiusNM).toBeCloseTo(1.1 * r.totalErrorNM, 5)
  })

  it('current alone carries the datum down-current', () => {
    const r = computeDatum(
      baseInput({ currentTowardDeg: 90, currentKts: 2, at: 3 * H }),
    )
    expect(r.driftDistanceNM).toBeCloseTo(6, 5)
    expect(r.driftBearingDeg).toBeCloseTo(90, 5)
    expect(
      haversineNM(29.5, -94.8, r.datum.lat, r.datum.lon),
    ).toBeCloseTo(6, 2)
    expect(bearingDeg(29.5, -94.8, r.datum.lat, r.datum.lon)).toBeCloseTo(90, 0)
    // Drift error 0.3 × 6 = 1.8 dominates the RSS.
    expect(r.totalErrorNM).toBeCloseTo(Math.hypot(0.1, 0.1, 1.8), 4)
  })

  it('wind alone moves the object downwind at the leeway rate, with crosswind divergence', () => {
    // Northerly wind (FROM 0) pushes the object south (toward 180).
    // person_in_water at 10 kn: downwind 0.18 kn, crosswind 0.07 kn.
    const r = computeDatum(
      baseInput({ windFromDeg: 0, windKts: 10, at: 10 * H }),
    )
    expect(r.leewayKts).toBeCloseTo(0.18, 5)
    expect(r.crosswindLeewayKts).toBeCloseTo(0.07, 5)
    expect(r.driftBearingDeg).toBeCloseTo(180, 5)
    expect(r.driftDistanceNM).toBeCloseTo(1.8, 5)
    // The crosswind component swings the side datums atan(0.07/0.18) ≈ 21°
    // off downwind: left toward ~159°, right toward ~201°.
    const div = (Math.atan2(0.07, 0.18) * 180) / Math.PI
    const leftBrg = bearingDeg(29.5, -94.8, r.datumLeft.lat, r.datumLeft.lon)
    const rightBrg = bearingDeg(29.5, -94.8, r.datumRight.lat, r.datumRight.lon)
    expect(leftBrg).toBeCloseTo(180 - div, 0)
    expect(rightBrg).toBeCloseTo(180 + div, 0)
  })

  it('wind and current add as vectors', () => {
    // Current 1 kt toward 000, wind FROM 270 → leeway toward 090 at 0.18 kt.
    const r = computeDatum(
      baseInput({
        currentTowardDeg: 0,
        currentKts: 1,
        windFromDeg: 270,
        windKts: 10,
        at: 1 * H,
      }),
    )
    expect(r.driftKts).toBeCloseTo(Math.hypot(1, 0.18), 4)
    expect(r.driftBearingDeg).toBeCloseTo(
      (Math.atan2(0.18, 1) * 180) / Math.PI,
      1,
    )
  })

  it('a future LKP time clamps to zero hours instead of drifting backwards', () => {
    const r = computeDatum(
      baseInput({
        lkp: { lat: 29.5, lon: -94.8, time: 10 * H },
        at: 0,
        currentTowardDeg: 90,
        currentKts: 2,
      }),
    )
    expect(r.hoursAdrift).toBe(0)
    expect(r.driftDistanceNM).toBe(0)
  })
})

describe('datumReport', () => {
  it('speaks RescueGPS: lng not lon, and drift-engine parameter names', () => {
    const input = baseInput({
      currentTowardDeg: 90,
      currentKts: 2,
      windFromDeg: 0,
      windKts: 10,
      at: 3 * H,
    })
    const result = computeDatum(input)
    const report = JSON.parse(
      datumReport({
        lkp: {
          lat: input.lkp.lat,
          lon: input.lkp.lon,
          time: input.lkp.time,
          source: 'gps',
          errorNM: LKP_ERROR_NM.gps,
        },
        objectTypeKey: 'person_in_water',
        windFromDeg: 0,
        windKts: 10,
        currentTowardDeg: 90,
        currentKts: 2,
        result,
      }),
    )

    expect(report.format).toBe('rescuegps-navmate/datum-report')
    expect(report.lkp.lng).toBeCloseTo(-94.8, 6)
    expect(report.lkp).not.toHaveProperty('lon')
    expect(report.datum.search_radius_nm).toBeCloseTo(result.searchRadiusNM, 6)
    // The exact parameter object of RescueGPS simulateDrift().
    expect(report.simulate_drift_params).toMatchObject({
      lat: 29.5,
      lng: -94.8,
      wind_speed_kts: 10,
      wind_direction_deg: 0,
      current_speed_kts: 2,
      current_direction_deg: 90,
      leeway_type: 'person_in_water',
    })
    expect(report.simulate_drift_params.duration_hrs).toBeGreaterThanOrEqual(9)
  })
})

describe('when the drift clock starts', () => {
  const t = (iso: string) => new Date(iso).getTime()

  it('runs from the LKP when the object went in BEFORE it was seen there', () => {
    // Entered at 12:00, a witness saw them at 13:00 further down. The 13:00
    // position already contains the first hour of drift; starting the clock at
    // 12:00 would count it twice, pushing the datum past the object.
    expect(driftStartsAt(t('2026-09-14T13:00:00Z'), t('2026-09-14T12:00:00Z')))
      .toBe(t('2026-09-14T13:00:00Z'))
  })

  it('runs from the water when the object went in AFTER the last position', () => {
    // A vessel's last known position at 12:00; it sank at 13:00. Nothing was
    // drifting in between, so an hour of drift charged to it is an hour of
    // search area invented.
    expect(driftStartsAt(t('2026-09-14T12:00:00Z'), t('2026-09-14T13:00:00Z')))
      .toBe(t('2026-09-14T13:00:00Z'))
  })

  it('is a no-op in the usual case, seen going in', () => {
    const same = t('2026-09-14T12:00:00Z')
    expect(driftStartsAt(same, same)).toBe(same)
  })

  it('falls back to the LKP when no time in water was given', () => {
    const lkp = t('2026-09-14T12:00:00Z')
    expect(driftStartsAt(lkp, null)).toBe(lkp)
    expect(driftStartsAt(lkp, undefined)).toBe(lkp)
    expect(driftStartsAt(lkp, Number.NaN)).toBe(lkp)
  })

  it('changes the datum computeDatum produces, and only in the right direction', () => {
    const base = {
      lkp: { lat: 29.5, lon: -94.8, time: t('2026-09-14T12:00:00Z') },
      at: t('2026-09-14T14:00:00Z'),
      objectType: searchObjectType('person_in_water'),
      windFromDeg: 180,
      windKts: 15,
      currentTowardDeg: 90,
      currentKts: 1,
      lkpErrorNM: 0.1,
    }
    const plain = computeDatum(base)
    // Entered the water an hour AFTER the LKP: one hour of drift, not two.
    const later = computeDatum({ ...base, timeInWater: t('2026-09-14T13:00:00Z') })
    expect(later.hoursAdrift).toBeCloseTo(1, 6)
    expect(plain.hoursAdrift).toBeCloseTo(2, 6)
    expect(later.driftDistanceNM).toBeLessThan(plain.driftDistanceNM)
    // A smaller drift is also a smaller uncertainty, so the first search
    // radius tightens with it rather than staying at the inflated value.
    expect(later.searchRadiusNM).toBeLessThan(plain.searchRadiusNM)

    // Entered BEFORE the LKP: the LKP is the newer fact, nothing changes.
    const earlier = computeDatum({ ...base, timeInWater: t('2026-09-14T09:00:00Z') })
    expect(earlier.hoursAdrift).toBeCloseTo(plain.hoursAdrift, 6)
    expect(earlier.datum).toEqual(plain.datum)
  })
})

describe('repeated drift readings off a marker in the water', () => {
  const deploy = { lat: 29.5, lon: -94.8, time: '2026-09-14T12:00:00.000Z' }

  it('runs the next leg from the deploy point until a reading exists', () => {
    expect(lastMarkerPoint({ deploy })).toEqual({
      lat: 29.5,
      lon: -94.8,
      time: new Date(deploy.time).getTime(),
    })
  })

  it('runs each later leg from the reading before it, not from deploy', () => {
    // This is what makes a sample "the drift right now". Measuring every leg
    // from deploy would average the tide across the whole soak, and a tide
    // that has turned would be buried rather than shown.
    const samples = [
      { lat: 29.51, lon: -94.79, time: '2026-09-14T12:05:00.000Z' },
      { lat: 29.52, lon: -94.78, time: '2026-09-14T12:10:00.000Z' },
    ]
    expect(lastMarkerPoint({ deploy, samples })).toEqual({
      lat: 29.52,
      lon: -94.78,
      time: new Date('2026-09-14T12:10:00.000Z').getTime(),
    })
  })

  it('refuses a leg shorter than the fixes that measured it', () => {
    // 15 m of movement with ±10 m fixes is not a slow current, it is two
    // noisy positions. The bearing off it is meaningless, and it would reach
    // the datum through "Use as current".
    const fifteenMetresNM = 15 / 1852
    expect(driftLegIsMeaningful(fifteenMetresNM, 10)).toBe(false)

    // 5 minutes at 1 kn is ~154 m — comfortably a measurement.
    const fiveMinutesAtOneKnot = 1 * (DRIFT_SAMPLE_SECONDS / 3600)
    expect(driftLegIsMeaningful(fiveMinutesAtOneKnot, 10)).toBe(true)
  })

  it('scales what it demands to how good the fix actually is', () => {
    const hundredMetresNM = 100 / 1852
    expect(driftLegIsMeaningful(hundredMetresNM, 5)).toBe(true)
    // The same 100 m under a ±50 m fix says nothing at all.
    expect(driftLegIsMeaningful(hundredMetresNM, 50)).toBe(false)
  })

  it('assumes a usable fix rather than waving through an unknown one', () => {
    const tiny = 5 / 1852
    expect(driftLegIsMeaningful(tiny, null)).toBe(false)
  })

  it('samples every five minutes', () => {
    expect(DRIFT_SAMPLE_SECONDS).toBe(300)
  })
})

describe('a drift reading that cannot be believed', () => {
  const good = 1 * (DRIFT_SAMPLE_SECONDS / 3600) // 5 min at 1 kn

  it('accepts an ordinary reading', () => {
    expect(describeDriftLeg(good, 1, 10)).toEqual({ ok: true })
  })

  it('accepts a genuinely fast tide rather than second-guessing the sea', () => {
    // A spring tide through a cut really does run this hard. Refusing it would
    // throw away the truest current reading of the day.
    const r = describeDriftLeg(8 * (DRIFT_SAMPLE_SECONDS / 3600), 8, 10)
    expect(r.ok).toBe(true)
  })

  it('refuses a leg inside the noise floor, and says to wait', () => {
    const r = describeDriftLeg(5 / 1852, 0.03, 10)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.why).toMatch(/Leave it longer/)
  })

  it('refuses a speed no water reaches, and says to fix alongside', () => {
    // Found by driving the app: a fix taken under way produced "drift 180.53
    // kn", and nothing stopped that reaching the datum through "Use as
    // current".
    const r = describeDriftLeg(2, 180.53, 5)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.why).toMatch(/faster than any current/)
  })

  it('puts the ceiling past the sea and short of a bad fix', () => {
    expect(MAX_PLAUSIBLE_DRIFT_KTS).toBe(20)
    expect(describeDriftLeg(good, 19.9, 5).ok).toBe(true)
    expect(describeDriftLeg(good, 20.1, 5).ok).toBe(false)
  })
})
