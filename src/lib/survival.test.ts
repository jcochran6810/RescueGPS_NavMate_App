import { describe, it, expect } from 'vitest'
import { survivalEstimate, formatSurvivalMinutes } from './survival'

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
