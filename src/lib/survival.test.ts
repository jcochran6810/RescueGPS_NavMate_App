import { describe, it, expect } from 'vitest'
import { survivalEstimate, formatSurvivalMinutes, cToF, fToC } from './survival'

describe('survivalEstimate', () => {
  it('reads the USCG baseline: 50–60 °F water gives 1–6 h survival', () => {
    // 13 °C ≈ 55.4 °F → the ≤60 row: survival 60–360 min.
    const r = survivalEstimate({ waterTempC: 13, elapsedMinutes: 0, pfd: 'unknown' })
    expect(r.survivalMin).toBe(60)
    expect(r.survivalMax).toBe(360)
    expect(r.estimateMinutes).toBe(210)
  })

  it('a PFD stretches survival, no PFD halves it and cuts functional time', () => {
    const yes = survivalEstimate({ waterTempC: 13, elapsedMinutes: 0, pfd: 'yes' })
    const no = survivalEstimate({ waterTempC: 13, elapsedMinutes: 0, pfd: 'no' })
    expect(yes.survivalMax).toBe(Math.round(360 * 1.2))
    expect(no.survivalMax).toBe(180)
    expect(no.functionalMax).toBe(Math.round(120 * 0.55))
  })

  it('walks the immersion phases: cold shock, swim failure, hypothermia', () => {
    const at = (m: number) =>
      survivalEstimate({ waterTempC: 10, elapsedMinutes: m, pfd: 'yes' }).phase
    expect(at(1)).toBe('cold_shock')
    expect(at(10)).toBe('swim_failure')
    expect(at(60)).toBe('hypothermia')
  })

  it('warm water skips cold shock and reads as exposure, not hypothermia', () => {
    // 28 °C = 82.4 °F: above the 77 °F cold-shock threshold and the 80 °F
    // exposure line.
    const r = survivalEstimate({ waterTempC: 28, elapsedMinutes: 1, pfd: 'unknown' })
    expect(r.coldWater).toBe(false)
    expect(r.phase).toBe('hypothermia')
    expect(r.primaryThreat).toBe('exposure')
    expect(Number.isFinite(r.estimateMinutes)).toBe(false)
  })

  it('drowning outranks hypothermia early and whenever there is no PFD in cold water', () => {
    const early = survivalEstimate({ waterTempC: 10, elapsedMinutes: 2, pfd: 'yes' })
    expect(early.primaryThreat).toBe('drowning')
    const noPfd = survivalEstimate({ waterTempC: 10, elapsedMinutes: 90, pfd: 'no' })
    expect(noPfd.primaryThreat).toBe('drowning')
    const late = survivalEstimate({ waterTempC: 10, elapsedMinutes: 90, pfd: 'yes' })
    expect(late.primaryThreat).toBe('hypothermia')
  })

  it('past the estimate it says so rather than counting below zero', () => {
    const r = survivalEstimate({ waterTempC: 2, elapsedMinutes: 600, pfd: 'unknown' })
    expect(r.phase).toBe('beyond_estimate')
    expect(r.remainingMinutes).toBeLessThanOrEqual(0)
  })
})

describe('formatSurvivalMinutes', () => {
  it('renders minutes, hours and the unbounded case', () => {
    expect(formatSurvivalMinutes(45)).toBe('45 min')
    expect(formatSurvivalMinutes(150)).toBe('2.5 h')
    expect(formatSurvivalMinutes(600)).toBe('10 h')
    expect(formatSurvivalMinutes(Number.POSITIVE_INFINITY)).toBe('no practical limit')
  })
})

describe('the screen speaks Fahrenheit, the record stays Celsius', () => {
  it('converts both ways against known fixed points', () => {
    expect(cToF(0)).toBe(32)
    expect(cToF(100)).toBe(212)
    expect(cToF(-40)).toBe(-40)
    expect(fToC(32)).toBe(0)
    expect(fToC(212)).toBe(100)
    expect(fToC(-40)).toBe(-40)
  })

  it('round-trips a typed Fahrenheit value through the stored Celsius', () => {
    // What the Datum tab does: the crew types °F, `water_temp_c` is written in
    // Celsius, and the box is seeded back from that column next time.
    for (const typedF of [32, 55, 70, 84, 98]) {
      const stored = fToC(typedF)
      expect(Math.round(cToF(stored))).toBe(typedF)
    }
  })

  it('does not relabel a stored Celsius value as Fahrenheit', () => {
    // The dangerous direction, and the reason the read path converts at all.
    // 21 °C is shirtsleeves; 21 °F is a survival window measured in minutes,
    // and showing the raw stored number under an °F label says the second.
    const storedC = 21
    expect(Math.round(cToF(storedC))).toBe(70)

    const asIfMislabelled = survivalEstimate({
      waterTempC: fToC(21),
      elapsedMinutes: 0,
      pfd: 'unknown',
    })
    const correct = survivalEstimate({
      waterTempC: storedC,
      elapsedMinutes: 0,
      pfd: 'unknown',
    })
    // Not a cosmetic difference: one is a bounded window, the other is not.
    expect(asIfMislabelled.survivalMax).toBeLessThan(correct.survivalMax)
  })

  it('still reads the USCG table correctly when driven from Fahrenheit', () => {
    // 55 °F sits in the ≤60 row — the same row the Celsius test above asserts.
    const r = survivalEstimate({
      waterTempC: fToC(55),
      elapsedMinutes: 0,
      pfd: 'unknown',
    })
    expect(r.survivalMin).toBe(60)
    expect(r.survivalMax).toBe(360)
  })
})
