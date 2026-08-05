/**
 * Tide predictions from NOAA CO-OPS, for the station nearest a position.
 *
 * Two calls sit behind this: a one-off download of the tide-prediction station
 * list, which is near-static and gets cached so nearest-station lookups work
 * with no signal afterwards, and a per-station request for high and low water
 * predictions.
 *
 * Everything is requested in GMT and converted for display. The API will
 * happily return station-local times with no offset attached, which is fine
 * until the crew's phone is in a different zone from the station — a two-hour
 * error in a tide time is the kind of thing that strands a boat.
 *
 * Coverage is US waters and territories only; that is the whole extent of the
 * service, and `nearestStations` returning something 800 NM away is a real
 * answer to "nothing near me", not a bug.
 */

import { haversineNM, bearingDeg as bearingTo } from './geo'

const MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json'
const DATAGETTER = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'

export interface TideStation {
  id: string
  name: string
  /** Two-letter state or territory code, blank when the feed omits it. */
  state: string
  lat: number
  lon: number
}

export interface TideStationDistance extends TideStation {
  distanceNM: number
  bearingDeg: number
}

export interface TideExtreme {
  at: Date
  /** Height above the datum, in feet. */
  heightFt: number
  type: 'H' | 'L'
}

export type TideTrend = 'rising' | 'falling' | 'unknown'

export interface TideNow {
  trend: TideTrend
  /** The extreme just passed, if it is within the predictions we hold. */
  previous: TideExtreme | null
  next: TideExtreme | null
  nextHigh: TideExtreme | null
  nextLow: TideExtreme | null
}

/* -------------------------------------------------------------------------
 * Parsing
 * ---------------------------------------------------------------------- */

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Read the station list.
 *
 * The feed names longitude `lng`; older and neighbouring CO-OPS endpoints use
 * `lon`. Both are accepted rather than silently producing a station on the
 * prime meridian. A station missing either coordinate is dropped — a tide
 * station at a wrong position would be picked as "nearest" from anywhere.
 */
export function parseStationList(payload: unknown): TideStation[] {
  const stations = (payload as { stations?: unknown })?.stations
  if (!Array.isArray(stations)) {
    throw new Error('Unexpected station list from NOAA')
  }

  const out: TideStation[] = []
  for (const raw of stations) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as Record<string, unknown>
    const lat = finiteNumber(s.lat)
    const lon = finiteNumber(s.lng ?? s.lon ?? s.longitude)
    const id = typeof s.id === 'string' ? s.id : String(s.id ?? '')
    if (lat === null || lon === null || !id) continue
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue

    out.push({
      id,
      name: typeof s.name === 'string' ? s.name : id,
      state: typeof s.state === 'string' ? s.state : '',
      lat,
      lon,
    })
  }

  if (out.length === 0) throw new Error('NOAA returned no usable tide stations')
  return out
}

/**
 * A CO-OPS timestamp, `YYYY-MM-DD HH:MM`, read as GMT.
 *
 * The string carries no offset, so this only holds because every request this
 * module makes sets `time_zone=gmt`.
 */
export function parseNoaaTime(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text.trim())
  if (!m) return null
  const at = new Date(
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]),
  )
  return Number.isNaN(at.getTime()) ? null : at
}

/** Read a high/low prediction response, oldest first. */
export function parsePredictions(payload: unknown): TideExtreme[] {
  const body = payload as {
    error?: { message?: string }
    predictions?: unknown
  }
  if (body?.error) {
    throw new Error(body.error.message?.trim() || 'NOAA rejected the request')
  }
  if (!Array.isArray(body?.predictions)) {
    throw new Error('Unexpected tide predictions from NOAA')
  }

  const out: TideExtreme[] = []
  for (const raw of body.predictions) {
    if (!raw || typeof raw !== 'object') continue
    const p = raw as Record<string, unknown>
    const at = typeof p.t === 'string' ? parseNoaaTime(p.t) : null
    const heightFt = finiteNumber(p.v)
    const type = p.type === 'H' || p.type === 'L' ? p.type : null
    if (!at || heightFt === null || !type) continue
    out.push({ at, heightFt, type })
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/* -------------------------------------------------------------------------
 * Selection
 * ---------------------------------------------------------------------- */

/** The `limit` closest stations to a position, nearest first. */
export function nearestStations(
  lat: number,
  lon: number,
  stations: TideStation[],
  limit = 5,
): TideStationDistance[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return []
  return stations
    .map((s) => ({
      ...s,
      distanceNM: haversineNM(lat, lon, s.lat, s.lon),
      bearingDeg: bearingTo(lat, lon, s.lat, s.lon),
    }))
    .sort((a, b) => a.distanceNM - b.distanceNM)
    .slice(0, Math.max(0, limit))
}

/**
 * Where the tide is now, from the surrounding predictions.
 *
 * The trend comes from the bracketing extremes rather than from a water-level
 * reading: predictions cover every station, observations do not, and a crew
 * asking "is it coming in" wants the next hour, not the last six minutes.
 */
export function tideNow(now: Date, extremes: TideExtreme[]): TideNow {
  const t = now.getTime()
  const sorted = [...extremes].sort((a, b) => a.at.getTime() - b.at.getTime())

  const future = sorted.filter((e) => e.at.getTime() > t)
  const past = sorted.filter((e) => e.at.getTime() <= t)
  const previous = past.length ? past[past.length - 1] : null
  const next = future.length ? future[0] : null

  // Heading for a high means the water is rising. With nothing ahead of us,
  // the last extreme still settles it; with nothing at all, say so.
  const trend: TideTrend = next
    ? next.type === 'H'
      ? 'rising'
      : 'falling'
    : previous
      ? previous.type === 'H'
        ? 'falling'
        : 'rising'
      : 'unknown'

  return {
    trend,
    previous,
    next,
    nextHigh: future.find((e) => e.type === 'H') ?? null,
    nextLow: future.find((e) => e.type === 'L') ?? null,
  }
}

/* -------------------------------------------------------------------------
 * Fetching
 * ---------------------------------------------------------------------- */

const REQUEST_TIMEOUT_MS = 15_000

async function getJSON(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: abort.signal })
    if (!res.ok) throw new Error(`NOAA returned ${res.status}`)
    return await res.json()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('NOAA timed out')
    }
    throw err instanceof Error ? err : new Error('NOAA request failed')
  } finally {
    clearTimeout(timer)
  }
}

/** Every station that publishes tide predictions. Roughly 3,000 entries. */
export async function fetchStations(): Promise<TideStation[]> {
  const url = `${MDAPI}?type=tidepredictions&units=english`
  return parseStationList(await getJSON(url, 30_000))
}

/** `YYYYMMDD` for an instant, in GMT. */
function gmtDate(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * High and low water for a station, covering yesterday through two days out.
 *
 * Yesterday is included so the tide just past is known even at 00:30 local,
 * which is what makes the rising/falling call reliable rather than a guess.
 */
export async function fetchPredictions(
  stationId: string,
  now = new Date(),
): Promise<TideExtreme[]> {
  const begin = new Date(now.getTime() - 24 * 3_600_000)
  const end = new Date(now.getTime() + 48 * 3_600_000)

  const params = new URLSearchParams({
    station: stationId,
    product: 'predictions',
    interval: 'hilo',
    datum: 'MLLW',
    units: 'english',
    time_zone: 'gmt',
    format: 'json',
    application: 'RescueGPS-NavMate',
    begin_date: gmtDate(begin),
    end_date: gmtDate(end),
  })

  return parsePredictions(await getJSON(`${DATAGETTER}?${params}`))
}

/* -------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------- */

export function formatTideHeight(ft: number): string {
  if (!Number.isFinite(ft)) return '—'
  return `${ft >= 0 ? '' : '−'}${Math.abs(ft).toFixed(1)} ft`
}

export function formatTideClock(at: Date | null): string {
  if (!at) return '—'
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
