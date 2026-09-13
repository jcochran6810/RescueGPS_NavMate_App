import { describe, it, expect } from 'vitest'
import {
  clearsDepth,
  clearsHeight,
  feetToMeters,
  formatDepth,
  formatFeet,
  fuelForHours,
  metersToFeet,
  readVesselField,
  safeDepthM,
  VESSEL_DEFAULTS,
} from './vessel'

describe('safeDepthM', () => {
  it('is the draft plus the margin the coxswain set, and nothing else', () => {
    expect(safeDepthM({ draft_m: 0.9, under_keel_margin_m: 0.6 })).toBeCloseTo(1.5, 9)
  })

  it('treats a missing or negative figure as zero rather than NaN', () => {
    expect(safeDepthM({ draft_m: NaN, under_keel_margin_m: 0.6 })).toBeCloseTo(0.6, 9)
    expect(safeDepthM({ draft_m: -1, under_keel_margin_m: 0.5 })).toBeCloseTo(0.5, 9)
  })

  it('ships a default that is a real boat, not a zero-draft one', () => {
    expect(safeDepthM(VESSEL_DEFAULTS)).toBeGreaterThan(1)
  })
})

describe('clearsDepth', () => {
  it('passes water exactly as deep as the boat needs', () => {
    expect(clearsDepth(1.5, 1.5)).toBe(true)
  })

  it('fails water a handspan short', () => {
    expect(clearsDepth(1.4, 1.5)).toBe(false)
  })

  it('a 3 ft draft with a 2 ft margin clears a 2.0 m area and not a 1.4 m one', () => {
    const boat = { draft_m: feetToMeters(3), under_keel_margin_m: feetToMeters(2) }
    const need = safeDepthM(boat)
    expect(need).toBeCloseTo(1.524, 3)
    expect(clearsDepth(2.0, need)).toBe(true)
    expect(clearsDepth(1.4, need)).toBe(false)
  })

  it('calls unsurveyed water unusable — not shallow, but not known to be deep', () => {
    expect(clearsDepth(null, 1.5)).toBe(false)
    expect(clearsDepth(NaN, 1.5)).toBe(false)
  })
})

describe('clearsHeight', () => {
  it('fits under a bridge taller than the mast', () => {
    expect(clearsHeight(6, { air_draft_m: 3 })).toBe(true)
  })

  it('does not fit under one exactly as tall — equal is not clearance', () => {
    expect(clearsHeight(3, { air_draft_m: 3 })).toBe(false)
  })

  it('treats an uncharted clearance as unknown, never as unlimited', () => {
    expect(clearsHeight(null, { air_draft_m: 3 })).toBe(false)
  })

  it('lets a boat with no recorded air draft through', () => {
    expect(clearsHeight(4, { air_draft_m: 0 })).toBe(true)
  })
})

describe('unit conversion', () => {
  it('uses the exact international foot', () => {
    expect(metersToFeet(1)).toBeCloseTo(3.280839895, 9)
    expect(feetToMeters(1)).toBeCloseTo(0.3048, 9)
  })

  it('round-trips', () => {
    expect(feetToMeters(metersToFeet(1.234))).toBeCloseTo(1.234, 9)
  })

  it('shows feet first, because that is what the crew says aloud', () => {
    expect(formatDepth(0.9)).toBe('3.0 ft (0.9 m)')
    expect(formatFeet(0.9)).toBe('3.0 ft')
    expect(formatDepth(null)).toBe('—')
  })
})

describe('fuelForHours', () => {
  it('multiplies the burn rate by the time to run', () => {
    expect(fuelForHours({ fuel_burn_gph: 12 }, 2.5)).toBeCloseTo(30, 9)
  })

  it('is null when the burn rate was never recorded', () => {
    expect(fuelForHours({ fuel_burn_gph: 0 }, 2)).toBeNull()
  })
})

describe('readVesselField', () => {
  it('accepts a figure inside its limit', () => {
    expect(readVesselField('1.2', 'draft_m')).toBeCloseTo(1.2, 9)
  })

  it('rejects a figure that is a typo rather than a boat', () => {
    expect(readVesselField('120', 'draft_m')).toBeNull()
    expect(readVesselField('0', 'draft_m')).toBeNull()
    expect(readVesselField('', 'draft_m')).toBeNull()
    expect(readVesselField('deep', 'draft_m')).toBeNull()
  })
})
