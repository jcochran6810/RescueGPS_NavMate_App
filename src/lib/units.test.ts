import { describe, it, expect } from 'vitest'
import {
  depthIn,
  depthToMetres,
  distanceIn,
  formatAltitude,
  formatDepth,
  formatDepthBoth,
  formatKnots,
  formatLength,
  formatSpeedIn,
  formatTemp,
  speedIn,
  tempIn,
  tempToCelsius,
  DEPTH_UNITS,
  DISTANCE_UNITS,
  SPEED_UNITS,
  TEMP_UNITS,
} from './units'

describe('depth', () => {
  it('converts metres to what the crew reads', () => {
    expect(depthIn(10, 'm')).toBe(10)
    expect(depthIn(10, 'ft')).toBeCloseTo(32.808, 3)
    // Six feet to the fathom.
    expect(depthIn(10, 'fm')).toBeCloseTo(32.808 / 6, 3)
  })

  it('round-trips, so a typed draft means the same as a read one', () => {
    for (const unit of ['ft', 'm', 'fm'] as const) {
      expect(depthToMetres(depthIn(3.7, unit), unit)).toBeCloseTo(3.7, 9)
    }
  })

  it('prints a dash rather than NaN for nothing', () => {
    expect(formatDepth(null, 'ft')).toBe('—')
    expect(formatDepth(Number.NaN, 'ft')).toBe('—')
    expect(formatDepthBoth(null, 'ft')).toBe('—')
  })

  /*
   * A draft is checked against a chart published in metres, so the long form
   * shows both — except when metres is already the setting, where repeating
   * it would be noise.
   */
  it('shows metres alongside, except when metres is the setting', () => {
    expect(formatDepthBoth(1.5, 'ft')).toBe('4.9 ft (1.5 m)')
    expect(formatDepthBoth(1.5, 'm')).toBe('1.5 m')
  })
})

describe('distance', () => {
  it('converts from nautical miles', () => {
    expect(distanceIn(1, 'nm')).toBe(1)
    expect(distanceIn(1, 'mi')).toBeCloseTo(1.15078, 5)
    expect(distanceIn(1, 'km')).toBeCloseTo(1.852, 5)
  })

  /* Two decimals close in, one further out: 12.34 NM is false precision. */
  it('drops a decimal once the number is large enough not to need it', () => {
    expect(formatLength(0.08, 'nm')).toBe('0.08 NM')
    expect(formatLength(12.345, 'nm')).toBe('12.3 NM')
  })
})

describe('speed', () => {
  it('converts metres per second', () => {
    expect(speedIn(1, 'kn')).toBeCloseTo(1.943844, 6)
    expect(speedIn(1, 'mph')).toBeCloseTo(2.236936, 6)
    expect(speedIn(1, 'kmh')).toBeCloseTo(3.6, 6)
  })

  it('takes knots too, since half the app already holds them', () => {
    expect(formatKnots(10, 'kn')).toBe('10.0 kn')
    expect(formatKnots(10, 'mph')).toBe('11.5 mph')
  })

  it('says nothing when the receiver reported nothing', () => {
    expect(formatSpeedIn(null, 'kn')).toBe('—')
    expect(formatKnots(undefined, 'kn')).toBe('—')
  })
})

describe('temperature', () => {
  it('converts in both directions around the stored Celsius', () => {
    expect(tempIn(0, 'f')).toBe(32)
    expect(tempIn(100, 'f')).toBe(212)
    expect(tempToCelsius(32, 'f')).toBe(0)
    expect(tempIn(21, 'c')).toBe(21)
  })

  /*
   * The read path is the one that bites: a record stored at 21 °C shown under
   * an °F label reads as shirtsleeves when it is a survival window of
   * minutes. 21 °C must print as 70 °F, never as 21 °F.
   */
  it('never shows a stored Celsius value under a Fahrenheit label', () => {
    expect(formatTemp(21, 'f')).toBe('70 °F')
    expect(formatTemp(21, 'c')).toBe('21 °C')
  })
})

describe('altitude', () => {
  it('rounds to the whole unit, which is all a GPS altitude is worth', () => {
    expect(formatAltitude(100, 'ft')).toBe('328 ft')
    expect(formatAltitude(100, 'm')).toBe('100 m')
    expect(formatAltitude(null, 'ft')).toBe('—')
  })
})

describe('the choices offered', () => {
  /* Every id offered by the UI has to be one the formatters understand. */
  it('are all understood by the formatters', () => {
    for (const u of DEPTH_UNITS) expect(formatDepth(1, u.id)).not.toBe('—')
    for (const u of DISTANCE_UNITS) expect(formatLength(1, u.id)).toMatch(/\d/)
    for (const u of SPEED_UNITS) expect(formatKnots(1, u.id)).toMatch(/\d/)
    for (const u of TEMP_UNITS) expect(formatTemp(1, u.id)).toMatch(/\d/)
  })
})
