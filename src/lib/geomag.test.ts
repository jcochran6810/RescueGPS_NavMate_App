import { describe, it, expect } from 'vitest'
import {
  declinationAt,
  decimalYear,
  magneticField,
  modelValidity,
  formatDeclination,
  trueFromMagnetic,
  magneticFromTrue,
  WMM_EPOCH,
} from './geomag'

/**
 * NOAA's own WMM2025 test values, all 100 of them.
 *
 * Published with the model as `WMM2025_TEST_VALUES.txt`, spanning the whole
 * five-year window and a spread of altitudes, so the secular-variation carry
 * and the geodetic-to-geocentric conversion are both exercised rather than
 * only the epoch at sea level. A compass that has to be right in a rescue is
 * checked against the source of truth, not against itself.
 *
 * `[decimal year, altitude km, lat, lon, declination, inclination, H nT, F nT]`
 */
const OFFICIAL: [number, number, number, number, number, number, number, number][] = [
  [2025.0, 28, 89, -121, -99.77, 88.47, 1504.3, 56214.4],
  [2025.0, 48, 80, -96, -29.91, 87.77, 2164.3, 55665.1],
  [2025.0, 54, 82, 87, 54.89, 87.68, 2302.4, 56787.5],
  [2025.0, 65, 43, 93, 0.50, 64.10, 24300.8, 55626.6],
  [2025.0, 51, -33, 109, -5.49, -67.50, 21838.0, 57054.8],
  [2025.0, 39, -59, -8, -15.75, -58.55, 14918.1, 28589.8],
  [2025.0, 3, -50, -103, 27.96, -54.89, 22106.0, 38431.7],
  [2025.0, 94, -29, -110, 15.74, -38.25, 24182.0, 30792.7],
  [2025.0, 66, 14, 143, -0.19, 12.82, 35003.6, 35898.7],
  [2025.0, 18, 0, 21, 1.29, -26.06, 29282.2, 32594.8],
  [2025.5, 6, -36, -137, 20.28, -52.11, 25353.2, 41280.5],
  [2025.5, 63, 26, 81, 0.51, 41.07, 34804.0, 46166.6],
  [2025.5, 69, 38, -144, 12.93, 56.97, 23096.3, 42373.8],
  [2025.5, 50, -70, -133, 57.21, -71.94, 16656.7, 53731.8],
  [2025.5, 8, -52, -75, 14.91, -49.63, 20005.5, 30887.0],
  [2025.5, 8, -66, 17, -33.14, -59.55, 18154.9, 35822.4],
  [2025.5, 22, -37, 140, 9.28, -68.62, 21688.8, 59492.0],
  [2025.5, 40, -12, -129, 10.76, -15.46, 29105.9, 30199.2],
  [2025.5, 44, 33, -118, 11.10, 57.89, 23678.7, 44542.8],
  [2025.5, 50, -81, -67, 28.13, -67.61, 18292.8, 48032.1],
  [2026.0, 74, -57, 3, -22.51, -58.65, 14362.2, 27606.2],
  [2026.0, 46, -24, -122, 14.01, -34.17, 26638.5, 32194.9],
  [2026.0, 69, 23, 63, 1.17, 35.92, 34565.9, 42684.5],
  [2026.0, 33, -3, -147, 9.71, -2.12, 30957.7, 30978.9],
  [2026.0, 47, -72, -22, -6.32, -61.16, 18392.5, 38127.1],
  [2026.0, 62, -14, 99, -1.43, -44.70, 33448.3, 47058.0],
  [2026.0, 83, 86, -46, -30.61, 86.84, 3000.3, 54362.2],
  [2026.0, 82, -64, 87, -81.74, -75.40, 13974.2, 55453.2],
  [2026.0, 34, -19, 43, -14.98, -52.33, 20212.4, 33077.0],
  [2026.0, 56, -81, 40, -59.77, -68.45, 17877.8, 48670.3],
  [2026.5, 14, 0, 80, -3.10, -17.15, 39489.1, 41327.4],
  [2026.5, 12, -82, -68, 29.79, -68.07, 18497.5, 49524.3],
  [2026.5, 44, -46, -42, -11.36, -54.39, 14140.3, 24285.5],
  [2026.5, 43, 17, 52, 1.19, 23.95, 36002.7, 39394.2],
  [2026.5, 64, 10, 78, -1.53, 7.53, 39441.7, 39784.9],
  [2026.5, 12, 33, -145, 11.96, 52.51, 24672.3, 40536.1],
  [2026.5, 12, -79, 115, -137.58, -77.37, 13023.5, 59546.0],
  [2026.5, 14, -33, -114, 18.12, -44.10, 24613.2, 34275.9],
  [2026.5, 19, 29, 66, 2.24, 46.04, 32750.0, 47177.7],
  [2026.5, 86, -11, 167, 10.24, -31.60, 33105.3, 38869.3],
  [2027.0, 37, -66, -5, -17.22, -59.04, 17159.8, 33360.0],
  [2027.0, 67, 72, -115, 13.73, 84.84, 5026.9, 55916.0],
  [2027.0, 44, 22, 174, 6.46, 31.89, 28867.5, 33999.1],
  [2027.0, 54, 54, 178, 0.63, 65.46, 20617.1, 49634.2],
  [2027.0, 57, -43, 50, -48.27, -63.13, 16833.4, 37242.8],
  [2027.0, 44, -43, -111, 24.31, -52.57, 22462.5, 36957.3],
  [2027.0, 12, -63, 178, 57.87, -79.14, 11720.7, 62190.2],
  [2027.0, 38, 27, -169, 8.48, 42.66, 26106.8, 35501.7],
  [2027.0, 61, 59, -77, -16.48, 78.68, 10884.8, 55476.0],
  [2027.0, 67, -47, -32, -13.52, -57.98, 12805.8, 24150.1],
  [2027.5, 8, 62, 53, 19.39, 76.67, 12997.8, 56368.8],
  [2027.5, 77, -68, -7, -16.19, -59.82, 17262.8, 34335.6],
  [2027.5, 98, -5, 159, 7.79, -23.22, 33857.5, 36841.9],
  [2027.5, 34, -29, -107, 15.64, -37.45, 24446.1, 30792.3],
  [2027.5, 60, 27, 65, 1.85, 42.83, 33079.4, 45108.1],
  [2027.5, 73, -72, 95, -102.64, -76.49, 13306.7, 56974.9],
  [2027.5, 96, -46, -85, 17.93, -47.37, 19914.5, 29402.5],
  [2027.5, 0, -13, -59, -17.49, -15.26, 22401.5, 23220.4],
  [2027.5, 16, 66, -178, 0.37, 75.67, 13821.6, 55830.6],
  [2027.5, 72, -87, 38, -65.44, -70.97, 16661.7, 51088.9],
  [2028.0, 49, 20, 167, 5.10, 26.82, 30251.3, 33898.3],
  [2028.0, 71, 5, -13, -6.47, -17.66, 28323.2, 29724.2],
  [2028.0, 95, 14, 65, -0.51, 17.44, 36933.9, 38713.1],
  [2028.0, 86, -85, -79, 41.09, -70.25, 16867.5, 49924.0],
  [2028.0, 30, -36, -64, -4.65, -40.08, 17398.7, 22738.6],
  [2028.0, 75, 79, 125, -18.59, 87.42, 2582.3, 57366.9],
  [2028.0, 21, 6, -32, -14.34, -8.70, 28453.1, 28784.0],
  [2028.0, 1, -76, -75, 29.87, -65.23, 19597.6, 46782.5],
  [2028.0, 45, -46, -41, -11.68, -54.96, 13897.6, 24203.8],
  [2028.0, 11, -22, -21, -23.24, -57.67, 13528.3, 25295.4],
  [2028.5, 28, 54, -120, 15.43, 73.74, 15286.1, 54578.0],
  [2028.5, 68, -58, 156, 41.57, -81.52, 9282.9, 62952.6],
  [2028.5, 39, -65, -88, 29.45, -60.20, 20609.3, 41467.0],
  [2028.5, 27, -23, 81, -13.27, -58.58, 25625.3, 49156.4],
  [2028.5, 11, 34, 0, 1.57, 46.77, 29089.2, 42471.3],
  [2028.5, 72, -62, 65, -67.87, -68.50, 17434.8, 47577.0],
  [2028.5, 55, 86, 70, 67.64, 87.57, 2370.4, 55976.4],
  [2028.5, 59, 32, 163, 0.15, 43.10, 28217.2, 38645.6],
  [2028.5, 65, 48, 148, -9.55, 61.79, 23693.5, 50130.2],
  [2028.5, 95, 30, 28, 4.56, 44.27, 29786.4, 41599.8],
  [2029.0, 95, -60, -59, 8.58, -55.17, 18095.6, 31687.0],
  [2029.0, 95, -70, 42, -55.06, -64.54, 18202.7, 42348.7],
  [2029.0, 50, 87, -154, -73.48, 89.07, 906.9, 55999.7],
  [2029.0, 58, 32, 19, 4.11, 46.03, 29435.0, 42393.2],
  [2029.0, 57, 34, -13, -1.89, 45.74, 28257.3, 40488.6],
  [2029.0, 38, -76, 49, -64.28, -67.36, 18412.6, 47836.8],
  [2029.0, 49, -50, -179, 32.11, -71.33, 18080.6, 56494.1],
  [2029.0, 90, -55, -171, 38.65, -72.79, 16416.5, 55479.6],
  [2029.0, 41, 42, -19, -4.13, 56.44, 24503.5, 44319.7],
  [2029.0, 19, 46, -22, -5.65, 60.89, 22632.0, 46527.1],
  [2029.5, 31, 13, -132, 9.04, 31.41, 28145.0, 32978.3],
  [2029.5, 93, -2, 158, 7.09, -17.84, 34067.3, 35788.3],
  [2029.5, 51, -76, 40, -56.34, -66.22, 18517.4, 45917.9],
  [2029.5, 64, 22, -132, 10.23, 43.76, 26014.8, 36020.8],
  [2029.5, 26, -65, 55, -63.48, -65.71, 18695.7, 45454.4],
  [2029.5, 66, -21, 32, -14.63, -56.68, 16100.3, 29312.4],
  [2029.5, 18, 9, -172, 9.24, 15.85, 30922.5, 32144.7],
  [2029.5, 63, 88, 26, 36.52, 87.37, 2539.9, 55344.9],
  [2029.5, 33, 17, 5, 0.89, 13.77, 34026.1, 35033.6],
  [2029.5, 77, -18, 138, 4.45, -47.55, 31847.6, 47186.0],]

/** A Date for a decimal year, which is how the table is indexed. */
function dateOf(year: number): Date {
  const whole = Math.floor(year)
  const start = Date.UTC(whole, 0, 1)
  const end = Date.UTC(whole + 1, 0, 1)
  return new Date(start + (year - whole) * (end - start))
}

describe('WMM2025 against NOAA published test values', () => {
  it('round-trips the decimal year the table is indexed by', () => {
    expect(decimalYear(dateOf(2026.5))).toBeCloseTo(2026.5, 6)
    expect(decimalYear(new Date(Date.UTC(2025, 0, 1)))).toBeCloseTo(2025, 9)
  })

  it.each(OFFICIAL)(
    '%f, %f km, %f/%f',
    (year, altKm, lat, lon, decl, incl, h, f) => {
      const got = magneticField(lat, lon, altKm, dateOf(year))
      // NOAA publishes declination and inclination to two decimals, so half a
      // hundredth of a degree is agreement to the last digit they print.
      expect(got.declination).toBeCloseTo(decl, 1)
      expect(Math.abs(got.declination - decl)).toBeLessThan(0.006)
      expect(Math.abs(got.inclination - incl)).toBeLessThan(0.006)
      // Intensities are tens of thousands of nT; a tenth is the printed digit.
      expect(Math.abs(got.horizontal - h)).toBeLessThan(0.15)
      expect(Math.abs(got.total - f)).toBeLessThan(0.15)
    },
  )
})

describe('declination where a crew actually is', () => {
  // Spot values a navigator would recognise, computed from the same model —
  // these guard the wrapper rather than the expansion, which the table above
  // covers. The signs are the point: east on the west coast, west on the east.
  it('is west on the US east coast and east on the west coast', () => {
    const boston = declinationAt(42.36, -71.06, 0, new Date('2026-06-01T00:00:00Z'))
    const seattle = declinationAt(47.61, -122.33, 0, new Date('2026-06-01T00:00:00Z'))
    expect(boston).toBeLessThan(-10)
    expect(boston).toBeGreaterThan(-18)
    expect(seattle).toBeGreaterThan(10)
    expect(seattle).toBeLessThan(18)
  })

  it('is small in the Gulf, where the agonic line runs', () => {
    const galveston = declinationAt(29.3, -94.8, 0, new Date('2026-06-01T00:00:00Z'))
    expect(Math.abs(galveston)).toBeLessThan(6)
  })

  it('takes altitude in metres, not kilometres', () => {
    const at = new Date('2026-06-01T00:00:00Z')
    // 10 km up is a real difference; passing metres as km would make this the
    // same as 10 000 km up, which is a different planet.
    const sea = declinationAt(29.3, -94.8, 0, at)
    const high = declinationAt(29.3, -94.8, 10000, at)
    expect(Math.abs(high - sea)).toBeLessThan(0.5)
    expect(high).not.toBe(sea)
  })

  it('refuses a position it cannot use', () => {
    expect(Number.isNaN(declinationAt(Number.NaN, -94.8))).toBe(true)
  })

  it('survives the poles rather than dividing by zero', () => {
    expect(Number.isFinite(declinationAt(90, 0))).toBe(true)
    expect(Number.isFinite(declinationAt(-90, 0))).toBe(true)
  })
})

describe('converting a bearing', () => {
  it('adds east declination to a magnetic bearing', () => {
    // "East is least" applies going the other way: from a true bearing you
    // subtract east declination to get what to steer.
    expect(trueFromMagnetic(90, 6)).toBeCloseTo(96)
    expect(magneticFromTrue(96, 6)).toBeCloseTo(90)
  })

  it('subtracts west declination', () => {
    expect(trueFromMagnetic(90, -14)).toBeCloseTo(76)
    expect(magneticFromTrue(76, -14)).toBeCloseTo(90)
  })

  it('wraps through north instead of going negative', () => {
    expect(trueFromMagnetic(2, -14)).toBeCloseTo(348)
    expect(magneticFromTrue(355, 14)).toBeCloseTo(341)
    expect(trueFromMagnetic(355, 14)).toBeCloseTo(9)
  })

  it('writes declination the way a chart does', () => {
    expect(formatDeclination(6.42)).toBe('6.4° E')
    expect(formatDeclination(-14.07)).toBe('14.1° W')
    expect(formatDeclination(0.01)).toBe('0°')
    expect(formatDeclination(Number.NaN)).toBe('—')
  })
})

describe('model validity', () => {
  it('knows its own window', () => {
    expect(WMM_EPOCH).toBe(2025)
    expect(modelValidity(new Date('2024-06-01T00:00:00Z'))).toBe('early')
    expect(modelValidity(new Date('2026-06-01T00:00:00Z'))).toBe('valid')
    expect(modelValidity(new Date('2031-06-01T00:00:00Z'))).toBe('expired')
  })
})
