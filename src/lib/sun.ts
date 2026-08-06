/**
 * Sun event times — dawn, sunrise, solar noon, sunset and dusk — for a
 * position on a date.
 *
 * This is deliberately computed on the device rather than fetched. A crew that
 * has lost signal is exactly the crew that needs to know how much light is
 * left, so a network round trip would fail at the moment the answer matters
 * most.
 *
 * The formulas are the standard low-precision solar position series (mean
 * anomaly -> ecliptic longitude -> declination -> hour angle). Times are good
 * to about a minute, which is far finer than any decision this feeds; nobody
 * plans a search to the second.
 */

const RAD = Math.PI / 180
const MS_PER_DAY = 86_400_000
const J1970 = 2_440_588
const J2000 = 2_451_545
const OBLIQUITY = 23.4397 * RAD

/**
 * Sun altitude counted as sunrise/sunset: the upper limb on the horizon, with
 * the usual allowance for atmospheric refraction.
 */
export const ALTITUDE_SUNRISE = -0.833
/**
 * Civil twilight — bright enough to move and read a chart without a light.
 * This is what "dawn" and "dusk" mean here, and it is what the operational
 * definition of daylight hours normally keys off.
 */
export const ALTITUDE_CIVIL = -6

function toJulian(ms: number): number {
  return ms / MS_PER_DAY - 0.5 + J1970
}

function fromJulian(j: number): Date {
  return new Date(Math.round((j + 0.5 - J1970) * MS_PER_DAY))
}

interface SolarDay {
  /** Julian date of local solar noon. */
  noon: number
  /** Solar declination, radians. */
  dec: number
  /** Sun's mean anomaly, radians. */
  anomaly: number
  /** Sun's ecliptic longitude, radians. */
  eclipticLon: number
  /** Whole days since J2000 for this solar day at this longitude. */
  cycle: number
  /** Longitude west of Greenwich, radians. */
  lw: number
}

/**
 * Solar geometry for the day containing `ms` at longitude `lon`.
 *
 * The cycle number is picked from the instant *and* the longitude, so a
 * position on the far side of the date line still resolves to its own local
 * day rather than to the UTC one.
 */
function solarDay(ms: number, lon: number): SolarDay {
  const lw = -lon * RAD
  const days = toJulian(ms) - J2000
  const cycle = Math.round(days - 0.0009 - lw / (2 * Math.PI))
  const approx = 0.0009 + lw / (2 * Math.PI) + cycle

  const anomaly = (357.5291 + 0.98560028 * approx) * RAD
  const centre =
    (1.9148 * Math.sin(anomaly) +
      0.02 * Math.sin(2 * anomaly) +
      0.0003 * Math.sin(3 * anomaly)) *
    RAD
  // Perihelion of Earth's orbit, then a half turn to go from Earth-as-seen-
  // from-Sun to Sun-as-seen-from-Earth.
  const eclipticLon = anomaly + centre + 102.9372 * RAD + Math.PI

  return {
    noon: transit(approx, anomaly, eclipticLon),
    dec: Math.asin(Math.sin(OBLIQUITY) * Math.sin(eclipticLon)),
    anomaly,
    eclipticLon,
    cycle,
    lw,
  }
}

/** Julian date of solar transit, correcting mean time to apparent time. */
function transit(approx: number, anomaly: number, eclipticLon: number): number {
  return (
    J2000 +
    approx +
    0.0053 * Math.sin(anomaly) -
    0.0069 * Math.sin(2 * eclipticLon)
  )
}

/**
 * Hour angle at which the sun reaches `altitudeDeg`, in radians, or null when
 * it never does — the polar case, where the sun neither rises nor sets.
 */
function hourAngle(altitudeDeg: number, lat: number, dec: number): number | null {
  const cosH =
    (Math.sin(altitudeDeg * RAD) - Math.sin(lat * RAD) * Math.sin(dec)) /
    (Math.cos(lat * RAD) * Math.cos(dec))
  if (!Number.isFinite(cosH) || cosH > 1 || cosH < -1) return null
  return Math.acos(cosH)
}

/** Julian date at which the sun descends past `altitudeDeg`. */
function settingJ(day: SolarDay, altitudeDeg: number, lat: number): number | null {
  const w = hourAngle(altitudeDeg, lat, day.dec)
  if (w === null) return null
  const approx = 0.0009 + (w + day.lw) / (2 * Math.PI) + day.cycle
  return transit(approx, day.anomaly, day.eclipticLon)
}

export interface SunEvents {
  /** Start of civil twilight. Null in polar conditions. */
  dawn: Date | null
  sunrise: Date | null
  /** Always defined — the sun transits the meridian even when it never sets. */
  solarNoon: Date
  sunset: Date | null
  /** End of civil twilight. Null in polar conditions. */
  dusk: Date | null
  /** Sun above the horizon for the whole 24 hours (midnight sun). */
  alwaysUp: boolean
  /** Sun below the horizon for the whole 24 hours (polar night). */
  alwaysDown: boolean
  /** Hours between sunrise and sunset — 24 or 0 in polar conditions. */
  dayLengthH: number
}

/**
 * Sun events for the calendar date of `date`, as read in the device's own
 * timezone. A phone in the field is set to local time, and "today" means the
 * day on that phone's clock.
 */
export function sunEvents(date: Date, lat: number, lon: number): SunEvents {
  const localNoon = new Date(date)
  localNoon.setHours(12, 0, 0, 0)

  const day = solarDay(localNoon.getTime(), lon)
  const solarNoon = fromJulian(day.noon)

  const setAt = (altitude: number): [Date, Date] | null => {
    const j = settingJ(day, altitude, lat)
    if (j === null) return null
    // Sunrise is sunset mirrored about the transit.
    return [fromJulian(day.noon - (j - day.noon)), fromJulian(j)]
  }

  const rise = setAt(ALTITUDE_SUNRISE)
  const civil = setAt(ALTITUDE_CIVIL)

  // With no rise or set, which side of the horizon we are stuck on is settled
  // by the sun's altitude at transit — its highest point of the day.
  const noonAltitude = 90 - Math.abs(lat - day.dec / RAD)
  const alwaysUp = rise === null && noonAltitude > ALTITUDE_SUNRISE
  const alwaysDown = rise === null && !alwaysUp

  const dayLengthH = rise
    ? (rise[1].getTime() - rise[0].getTime()) / 3_600_000
    : alwaysUp
      ? 24
      : 0

  return {
    dawn: civil?.[0] ?? null,
    sunrise: rise?.[0] ?? null,
    solarNoon,
    sunset: rise?.[1] ?? null,
    dusk: civil?.[1] ?? null,
    alwaysUp,
    alwaysDown,
    dayLengthH,
  }
}

export type SunEventName = 'dawn' | 'sunrise' | 'sunset' | 'dusk'

export const SUN_EVENT_LABELS: Record<SunEventName, string> = {
  dawn: 'Dawn',
  sunrise: 'Sunrise',
  sunset: 'Sunset',
  dusk: 'Dusk',
}

export interface NextSunEvent {
  name: SunEventName
  at: Date
  msUntil: number
}

/** How far ahead to look before giving up. Covers a polar summer or winter. */
const SEARCH_DAYS = 7

/**
 * The next dawn, sunrise, sunset or dusk after `now`.
 *
 * Returns null inside a polar day or night that runs past the search horizon —
 * the honest answer there is "not this week", not a made-up time.
 */
export function nextSunEvent(
  now: Date,
  lat: number,
  lon: number,
): NextSunEvent | null {
  const order: SunEventName[] = ['dawn', 'sunrise', 'sunset', 'dusk']

  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const day = new Date(now)
    day.setDate(day.getDate() + offset)
    const events = sunEvents(day, lat, lon)

    const upcoming = order
      .map((name) => ({ name, at: events[name] }))
      .filter(
        (e): e is { name: SunEventName; at: Date } =>
          e.at !== null && e.at.getTime() > now.getTime(),
      )
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0]

    if (upcoming) {
      return {
        name: upcoming.name,
        at: upcoming.at,
        msUntil: upcoming.at.getTime() - now.getTime(),
      }
    }
  }

  return null
}

/** Milliseconds as `HH:MM:SS`, or `Nd HH:MM:SS` past a day. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const total = Math.floor(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600) % 24
  const d = Math.floor(total / 86_400)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d > 0 ? `${d}d ` : ''}${pad(h)}:${pad(m)}:${pad(s)}`
}

/** A sun event time as a local clock time, or an em dash when it never occurs. */
export function formatSunClock(at: Date | null): string {
  if (!at) return '—'
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The same clock time split into the digits and the AM/PM suffix, so a narrow
 * column can set the suffix smaller and keep the whole time on one line.
 *
 * A 12-hour locale renders `11:19 AM`, which wraps in the daylight tracker's
 * quarter-width tiles and pushed `AM` onto a line of its own. Locales on a
 * 24-hour clock have no suffix and come back with `suffix: null`.
 */
export function sunClockParts(
  at: Date | null,
): { time: string; suffix: string | null } {
  if (!at) return { time: '—', suffix: null }
  const parts = new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at)
  const suffix = parts.find((p) => p.type === 'dayPeriod')?.value ?? null
  const time = parts
    .filter((p) => p.type !== 'dayPeriod')
    .map((p) => p.value)
    .join('')
    .trim()
  return { time, suffix }
}

/** Hours as `13h 42m`, for day length. */
export function formatDayLength(hours: number): string {
  if (!Number.isFinite(hours)) return '—'
  const total = Math.round(hours * 60)
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

/**
 * Whether `at` falls on the day after `now`, in local time — so the UI can say
 * "Tomorrow" the way a crew would.
 */
export function isNextDay(at: Date, now: Date): boolean {
  const a = new Date(at)
  a.setHours(0, 0, 0, 0)
  const b = new Date(now)
  b.setHours(0, 0, 0, 0)
  return a.getTime() > b.getTime()
}
