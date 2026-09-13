/**
 * Magnetic declination from the World Magnetic Model, on the device.
 *
 * A magnetometer measures the direction of the Earth's field, which is not
 * north. The difference — declination — is around 20° W on the coast of Maine
 * and 10° E in Washington State, and it is the single largest error in any
 * phone compass. NavMate's own bearings are all true (`geo.ts` works them from
 * coordinates), so a magnetic dial sitting next to a true bearings table is two
 * numbers that disagree with no way to tell which is which. This file removes
 * the disagreement instead of printing a warning about it.
 *
 * WMM2025 is the current model, produced by NOAA NCEI and the British
 * Geological Survey and released as public-domain data. It is valid from
 * 2025.0 to 2030.0; past that, the secular-variation extrapolation drifts and
 * the model has to be replaced (see `modelValidity`, and the note the compass
 * card shows when it goes stale).
 *
 * Everything here runs offline from the compiled-in coefficients. A crew out
 * of coverage is exactly the crew that needs a bearing.
 *
 * The maths is the standard spherical-harmonic expansion of the WMM technical
 * report: geodetic to geocentric, Schmidt semi-normalised associated Legendre
 * functions, and the field components rotated back to the geodetic frame. It is
 * checked against NOAA's own published test values in `geomag.test.ts` — 100 of
 * them, spanning the model's whole five-year life.
 */

/** Degrees to radians. */
const RAD = Math.PI / 180

/** Highest degree in the model. */
const N_MAX = 12

/** Geomagnetic reference radius, km — a defined constant of the model. */
const EARTH_R = 6371.2

/* WGS-84, which is what a GPS receiver reports its position on. */
const WGS84_A = 6378.137
const WGS84_F = 1 / 298.257223563
const WGS84_E2 = WGS84_F * (2 - WGS84_F)

export const WMM_NAME = 'WMM2025'
/** Decimal year the coefficients are referenced to. */
export const WMM_EPOCH = 2025.0
export const WMM_VALID_FROM = 2025.0
export const WMM_VALID_TO = 2030.0

/**
 * Main-field and secular-variation coefficients, nT and nT/year.
 *
 * Indexed `n * (n + 1) / 2 + m`, which is why each row below is one degree `n`
 * running `m = 0..n`. Degree 1 first; the `n = 0` slot is unused and is not
 * stored.
 */
/** Main field, g(n,m), nT. */
const G = [
  0,
  -29351.8, -1410.8,
  -2556.6, 2951.1, 1649.3,
  1361, -2404.1, 1243.8, 453.6,
  895, 799.5, 55.7, -281.1, 12.1,
  -233.2, 368.9, 187.2, -138.7, -142, 20.9,
  64.4, 63.8, 76.9, -115.7, -40.9, 14.9, -60.7,
  79.5, -77, -8.8, 59.3, 15.8, 2.5, -11.1, 14.2,
  23.2, 10.8, -17.5, 2, -21.7, 16.9, 15, -16.8, 0.9,
  4.6, 7.8, 3, -0.2, -2.5, -13.1, 2.4, 8.6, -8.7, -12.9,
  -1.3, -6.4, 0.2, 2, -1, -0.6, -0.9, 1.5, 0.9, -2.7, -3.9,
  2.9, -1.5, -2.5, 2.4, -0.6, -0.1, -0.6, -0.1, 1.1, -1, -0.2, 2.6,
  -2, -0.2, 0.3, 1.2, -1.3, 0.6, 0.6, 0.5, -0.1, -0.4, -0.2, -1.3, -0.7,
]

/** Main field, h(n,m), nT. */
const H = [
  0,
  0, 4545.4,
  0, -3133.6, -815.1,
  0, -56.6, 237.5, -549.5,
  0, 278.6, -133.9, 212, -375.6,
  0, 45.4, 220.2, -122.9, 43, 106.1,
  0, -18.4, 16.8, 48.8, -59.8, 10.9, 72.7,
  0, -48.9, -14.4, -1, 23.4, -7.4, -25.1, -2.3,
  0, 7.1, -12.6, 11.4, -9.7, 12.7, 0.7, -5.2, 3.9,
  0, -24.8, 12.2, 8.3, -3.3, -5.2, 7.2, -0.6, 0.8, 10,
  0, 3.3, 0, 2.4, 5.3, -9.1, 0.4, -4.2, -3.8, 0.9, -9.1,
  0, 0, 2.9, -0.6, 0.2, 0.5, -0.3, -1.2, -1.7, -2.9, -1.8, -2.3,
  0, -1.3, 0.7, 1, -1.4, 0, 0.6, -0.1, 0.8, 0.1, -1, 0.1, 0.2,
]

/** Secular variation, dg/dt, nT per year. */
const GDOT = [
  0,
  12, 9.7,
  -11.6, -5.2, -8,
  -1.3, -4.2, 0.4, -15.6,
  -1.6, -2.4, -6, 5.6, -7,
  0.6, 1.4, 0, 0.6, 2.2, 0.9,
  -0.2, -0.4, 0.9, 1.2, -0.9, 0.3, 0.9,
  0, -0.1, -0.1, 0.5, -0.1, -0.8, -0.8, 0.8,
  -0.1, 0.2, 0, 0.5, -0.1, 0.3, 0.2, 0, 0.2,
  0, -0.1, 0.1, 0.3, -0.3, 0, 0.3, -0.1, 0.1, -0.1,
  0.1, 0, 0.1, 0.1, 0, -0.3, 0, -0.1, -0.1, 0, 0,
  0, 0, 0, 0, 0, -0.1, 0, 0, -0.1, -0.1, -0.1, -0.1,
  0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, -0.1, 0, -0.1,
]

/** Secular variation, dh/dt, nT per year. */
const HDOT = [
  0,
  0, -21.5,
  0, -27.7, -12.1,
  0, 4, -0.3, -4.1,
  0, -1.1, 4.1, 1.6, -4.4,
  0, -0.5, 2.2, 0.4, 1.7, 1.9,
  0, 0.3, -1.6, -0.4, 0.9, 0.7, 0.9,
  0, 0.6, 0.5, -0.8, 0, -1, 0.6, -0.2,
  0, -0.2, 0.5, -0.4, 0.4, -0.5, -0.6, 0.3, 0.2,
  0, -0.3, 0.3, -0.3, 0.3, 0.2, -0.1, -0.2, 0.4, 0.1,
  0, 0, 0, -0.2, 0.1, -0.1, 0.1, 0, -0.1, 0.2, 0,
  0, 0, 0.1, 0, 0.1, 0, 0, 0.1, 0, 0, 0, 0,
  0, 0, 0, -0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, -0.1,
]

export interface MagneticField {
  /** Degrees from true north to magnetic north, east positive. */
  declination: number
  /** Dip angle in degrees, positive downward. */
  inclination: number
  /** Horizontal intensity, nT. */
  horizontal: number
  /** Total intensity, nT. */
  total: number
  /** North, east and downward components, nT. */
  north: number
  east: number
  down: number
}

/**
 * Fractional year in UTC, which is how the model measures time.
 *
 * Leap years are counted properly rather than dividing by 365 — a day out is
 * nothing to declination, but this is also the number the validity check reads
 * and rounding it would shift the expiry date around.
 */
export function decimalYear(at: Date): number {
  const year = at.getUTCFullYear()
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  return year + (at.getTime() - start) / (end - start)
}

export type ModelValidity = 'valid' | 'expired' | 'early'

/**
 * Whether the model may be trusted at this date.
 *
 * Outside its window the secular-variation terms are an extrapolation that
 * grows worse every year, so the answer is still returned — a five-year-stale
 * declination beats none — but the compass says so rather than presenting it
 * as current.
 */
export function modelValidity(at: Date = new Date()): ModelValidity {
  const t = decimalYear(at)
  if (t < WMM_VALID_FROM) return 'early'
  if (t >= WMM_VALID_TO) return 'expired'
  return 'valid'
}

/**
 * Schmidt semi-normalised associated Legendre functions and their derivatives
 * with respect to colatitude, for x = sin(geocentric latitude).
 *
 * Both arrays are indexed `n * (n + 1) / 2 + m`, as the coefficients are.
 */
function legendre(x: number): { p: Float64Array; dp: Float64Array } {
  const size = ((N_MAX + 1) * (N_MAX + 2)) / 2
  const p = new Float64Array(size)
  const dp = new Float64Array(size)
  const z = Math.sqrt((1 - x) * (1 + x))

  p[0] = 1
  dp[0] = 0

  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      const i = (n * (n + 1)) / 2 + m
      if (n === m) {
        const j = ((n - 1) * n) / 2 + m - 1
        p[i] = z * p[j]
        dp[i] = z * dp[j] + x * p[j]
      } else if (n === 1) {
        const j = ((n - 1) * n) / 2 + m
        p[i] = x * p[j]
        dp[i] = x * dp[j] - z * p[j]
      } else if (m > n - 2) {
        const j = ((n - 1) * n) / 2 + m
        p[i] = x * p[j]
        dp[i] = x * dp[j] - z * p[j]
      } else {
        const k =
          ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3))
        const j1 = ((n - 2) * (n - 1)) / 2 + m
        const j2 = ((n - 1) * n) / 2 + m
        p[i] = x * p[j2] - k * p[j1]
        dp[i] = x * dp[j2] - z * p[j2] - k * dp[j1]
      }
    }
  }

  // Convert from the unnormalised recursion above to the Schmidt
  // semi-normalised form the coefficients are published in.
  const norm = new Float64Array(size)
  norm[0] = 1
  for (let n = 1; n <= N_MAX; n++) {
    const i = (n * (n + 1)) / 2
    norm[i] = (norm[((n - 1) * n) / 2] * (2 * n - 1)) / n
    for (let m = 1; m <= n; m++) {
      const j = (n * (n + 1)) / 2 + m
      norm[j] =
        norm[j - 1] *
        Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m))
    }
  }
  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      const i = (n * (n + 1)) / 2 + m
      p[i] *= norm[i]
      // The recursion differentiates with respect to x; the summation wants
      // the derivative with respect to colatitude, which is the other way up.
      dp[i] *= -norm[i]
    }
  }

  return { p, dp }
}

/**
 * The full field at a position and time.
 *
 * `altKm` is height above the WGS-84 ellipsoid — the altitude a GPS receiver
 * reports. Sea level is a good enough default: 100 km of altitude moves
 * declination by a fraction of a degree, so a boat's is immaterial.
 */
export function magneticField(
  latDeg: number,
  lonDeg: number,
  altKm = 0,
  at: Date = new Date(),
): MagneticField {
  // Every meridian meets at the pole, so declination there is not a quantity a
  // crew can steer by and the summation divides by a vanishing cosine. Step off
  // the singularity by a metre rather than carry a second summation that no
  // boat will ever reach.
  const lat = Math.min(89.99999, Math.max(-89.99999, latDeg))
  const lon = lonDeg
  const dt = decimalYear(at) - WMM_EPOCH

  /* Geodetic to geocentric spherical. */
  const latRad = lat * RAD
  const sinLat = Math.sin(latRad)
  const cosLat = Math.cos(latRad)
  const rc = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  const px = (rc + altKm) * cosLat
  const pz = (rc * (1 - WGS84_E2) + altKm) * sinLat
  const r = Math.hypot(px, pz)
  const sinPhi = pz / r
  const cosPhi = px / r
  const phiGeocentric = Math.asin(sinPhi)

  const { p, dp } = legendre(sinPhi)

  /* sin/cos of m·longitude by recursion — 12 multiplications rather than 12
     trigonometric calls per position. */
  const lonRad = lon * RAD
  const sinM = new Float64Array(N_MAX + 1)
  const cosM = new Float64Array(N_MAX + 1)
  cosM[0] = 1
  sinM[0] = 0
  if (N_MAX >= 1) {
    cosM[1] = Math.cos(lonRad)
    sinM[1] = Math.sin(lonRad)
  }
  for (let m = 2; m <= N_MAX; m++) {
    cosM[m] = cosM[m - 1] * cosM[1] - sinM[m - 1] * sinM[1]
    sinM[m] = sinM[m - 1] * cosM[1] + cosM[m - 1] * sinM[1]
  }

  let bx = 0
  let by = 0
  let bz = 0
  const ratio = EARTH_R / r

  for (let n = 1; n <= N_MAX; n++) {
    const rr = Math.pow(ratio, n + 2)
    for (let m = 0; m <= n; m++) {
      const i = (n * (n + 1)) / 2 + m
      // Coefficients carried forward from the epoch by their secular variation.
      const g = G[i] + dt * GDOT[i]
      const h = H[i] + dt * HDOT[i]
      const gc = g * cosM[m] + h * sinM[m]
      bz -= rr * gc * (n + 1) * p[i]
      by += rr * (g * sinM[m] - h * cosM[m]) * m * p[i]
      bx -= rr * gc * dp[i]
    }
  }
  by /= cosPhi

  /* Rotate from the geocentric frame back to the geodetic one the crew's
     horizon is in. The two differ by up to 0.19° of latitude. */
  const psi = phiGeocentric - latRad
  const north = bx * Math.cos(psi) - bz * Math.sin(psi)
  const down = bx * Math.sin(psi) + bz * Math.cos(psi)
  const east = by

  const horizontal = Math.hypot(north, east)
  return {
    declination: Math.atan2(east, north) / RAD,
    inclination: Math.atan2(down, horizontal) / RAD,
    horizontal,
    total: Math.hypot(horizontal, down),
    north,
    east,
    down,
  }
}

/**
 * Declination in degrees, east positive — the number you add to a magnetic
 * bearing to get a true one.
 *
 * `altM` is metres, because that is what the rest of the app carries.
 */
export function declinationAt(
  lat: number,
  lon: number,
  altM: number | null = 0,
  at: Date = new Date(),
): number {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return Number.NaN
  const km = altM != null && Number.isFinite(altM) ? altM / 1000 : 0
  return magneticField(lat, lon, km, at).declination
}

/** A magnetic bearing as a true one. East declination adds. */
export function trueFromMagnetic(magneticDeg: number, declination: number): number {
  return ((((magneticDeg + declination) % 360) + 360) % 360)
}

/** A true bearing as a magnetic one — what to steer by the device's own dial. */
export function magneticFromTrue(trueDeg: number, declination: number): number {
  return ((((trueDeg - declination) % 360) + 360) % 360)
}

/** Declination as `6.4° E`, the form it is written on a chart's compass rose. */
export function formatDeclination(declination: number): string {
  if (!Number.isFinite(declination)) return '—'
  const mag = Math.abs(declination)
  if (mag < 0.05) return '0°'
  return `${mag.toFixed(1)}° ${declination > 0 ? 'E' : 'W'}`
}
