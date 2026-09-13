/** Export and import of waypoint sets: JSON, GPX and CSV. */

import { parseCoord, type Axis } from './coords'
import type { NewWaypoint, Waypoint } from './types'

/** What an import produced — including how many rows were left behind, so
 *  "Imported 40" is never silently said about a 100-row file. */
export interface ImportResult {
  waypoints: NewWaypoint[]
  /** Rows that carried no usable coordinate. */
  skipped: number
}

export type ExportFormat = 'json' | 'gpx' | 'csv'

/** The subset of a GPS fix a track needs. */
export interface TrackPoint {
  lat: number
  lon: number
  altitude?: number | null
  timestamp: number
}

function escapeXml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[c] as string,
  )
}

function csvCell(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`
}

export function toGPX(waypoints: Waypoint[]): string {
  const pts = waypoints
    .map((w) => {
      const desc = w.note
        ? `\n    <desc>${escapeXml(w.note)}</desc>`
        : ''
      return (
        `  <wpt lat="${w.lat}" lon="${w.lon}">\n` +
        `    <name>${escapeXml(w.name)}</name>${desc}\n` +
        `    <time>${new Date(w.created_at).toISOString()}</time>\n` +
        `  </wpt>`
      )
    })
    .join('\n')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="NavMate" ` +
    `xmlns="http://www.topografix.com/GPX/1/1">\n${pts}\n</gpx>\n`
  )
}

/**
 * A recorded track as a GPX `<trk>`, so a session's breadcrumb can be handed to
 * mapping software or attached to an incident report.
 */
export function trackToGPX(points: TrackPoint[], name = 'NavMate track'): string {
  const segment = points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat}" lon="${p.lon}">` +
        (p.altitude != null ? `<ele>${p.altitude}</ele>` : '') +
        `<time>${new Date(p.timestamp).toISOString()}</time>` +
        `</trkpt>`,
    )
    .join('\n')

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="NavMate" ` +
    `xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <trk>\n    <name>${escapeXml(name)}</name>\n    <trkseg>\n` +
    `${segment}${segment ? '\n' : ''}` +
    `    </trkseg>\n  </trk>\n</gpx>\n`
  )
}

export function toCSV(waypoints: Waypoint[]): string {
  const head = 'name,latitude,longitude,note,created_at,photos\n'
  const rows = waypoints
    .map((w) =>
      [
        w.name,
        w.lat,
        w.lon,
        (w.note || '').replace(/\r?\n/g, ' '),
        w.created_at,
        (w.photos ?? []).length,
      ]
        .map(csvCell)
        .join(','),
    )
    .join('\n')
  return head + rows + (rows ? '\n' : '')
}

export function serialize(waypoints: Waypoint[], format: ExportFormat): {
  filename: string
  mime: string
  body: string
} {
  const stamp = new Date().toISOString().slice(0, 10)
  switch (format) {
    case 'gpx':
      return {
        filename: `navmate-waypoints-${stamp}.gpx`,
        mime: 'application/gpx+xml',
        body: toGPX(waypoints),
      }
    case 'csv':
      return {
        filename: `navmate-waypoints-${stamp}.csv`,
        mime: 'text/csv',
        body: toCSV(waypoints),
      }
    case 'json':
    default:
      return {
        filename: `navmate-waypoints-${stamp}.json`,
        mime: 'application/json',
        body: JSON.stringify(
          { version: 2, exported_at: new Date().toISOString(), waypoints },
          null,
          2,
        ),
      }
  }
}

export function download(filename: string, body: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Number(), minus the coercions that would invent a coordinate: `''`, `null`,
 * `[]` and whitespace all become 0 otherwise, which reads as a real position
 * off the west coast of Africa instead of as missing data.
 */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v !== 'string') return Number.NaN
  const s = v.trim()
  return s === '' ? Number.NaN : Number(s)
}

/**
 * A coordinate cell from an import: a plain number, or any text the strict
 * coordinate parser accepts — so a file carrying `27° 59' 16.3" N` imports
 * instead of being dropped row by row.
 */
function toCoord(v: unknown, axis: Axis): number {
  const n = toNumber(v)
  if (Number.isFinite(n)) return n
  return typeof v === 'string' ? parseCoord(v, axis) : Number.NaN
}

function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  )
}

/**
 * Split CSV text into rows of cells, RFC 4180 style: doubled quotes escape a
 * quote, and a quoted cell may contain commas and newlines.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  // Strip a UTF-8 BOM — spreadsheet apps add one and it corrupts the first header.
  const s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  // Drop trailing blank lines.
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

const HEADER_ALIASES: Record<'name' | 'lat' | 'lon' | 'note', string[]> = {
  name: ['name', 'title', 'waypoint', 'label'],
  lat: ['lat', 'latitude', 'y'],
  lon: ['lon', 'lng', 'long', 'longitude', 'x'],
  note: ['note', 'notes', 'desc', 'description', 'comment'],
}

/**
 * Read a CSV export back in. The header row names the columns, so a file from
 * another tool works as long as it labels its latitude and longitude.
 */
export function parseCSV(text: string): ImportResult {
  const rows = parseCsvRows(text)
  if (rows.length < 2) return { waypoints: [], skipped: 0 }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const indexOf = (key: keyof typeof HEADER_ALIASES) =>
    header.findIndex((h) => HEADER_ALIASES[key].includes(h))

  const iLat = indexOf('lat')
  const iLon = indexOf('lon')
  if (iLat === -1 || iLon === -1) {
    throw new Error('That CSV has no latitude and longitude columns')
  }
  const iName = indexOf('name')
  const iNote = indexOf('note')

  const parsed = rows.slice(1).map((r) => ({
    name: (iName === -1 ? '' : (r[iName] ?? '')).trim().slice(0, 200) || 'Imported',
    lat: toCoord(r[iLat], 'lat'),
    lon: toCoord(r[iLon], 'lon'),
    note: (iNote === -1 ? '' : (r[iNote] ?? '')).trim(),
  }))
  const waypoints = parsed.filter((w) => isValidLatLon(w.lat, w.lon))
  return { waypoints, skipped: parsed.length - waypoints.length }
}

function hasCsvHeader(text: string): boolean {
  const first = parseCsvRows(text.split('\n', 1)[0] ?? '')[0]
  if (!first) return false
  const cells = first.map((h) => h.trim().toLowerCase())
  return (
    cells.some((h) => HEADER_ALIASES.lat.includes(h)) &&
    cells.some((h) => HEADER_ALIASES.lon.includes(h))
  )
}

/**
 * Read a JSON, GPX or CSV backup into waypoints ready to be inserted.
 * Photos are not carried across — they live in Storage, and a file from
 * another account could not be read anyway.
 */
export function parseImport(text: string, filename = ''): ImportResult {
  const lower = filename.toLowerCase()
  const looksXml = lower.endsWith('.gpx') || text.trim().startsWith('<')

  if (looksXml) {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('That file is not valid GPX')
    }
    const parsed = Array.from(doc.getElementsByTagName('wpt')).map((n) => ({
      name: n.getElementsByTagName('name')[0]?.textContent?.trim() || 'Imported',
      lat: toCoord(n.getAttribute('lat'), 'lat'),
      lon: toCoord(n.getAttribute('lon'), 'lon'),
      note: n.getElementsByTagName('desc')[0]?.textContent?.trim() || '',
    }))
    const waypoints = parsed.filter((w) => isValidLatLon(w.lat, w.lon))
    return { waypoints, skipped: parsed.length - waypoints.length }
  }

  // A .csv name is taken at its word; otherwise the first line has to look like
  // a header naming latitude and longitude, so genuinely unreadable input still
  // fails loudly instead of importing nothing.
  const trimmed = text.trim()
  const notJsonShaped = !trimmed.startsWith('{') && !trimmed.startsWith('[')
  if (lower.endsWith('.csv') || (notJsonShaped && hasCsvHeader(trimmed))) {
    return parseCSV(text)
  }

  const data: unknown = JSON.parse(text)
  const list: unknown = Array.isArray(data)
    ? data
    : ((data as { waypoints?: unknown })?.waypoints ?? [])

  if (!Array.isArray(list)) throw new Error('No waypoints found in that file')

  const parsed = list.map((raw) => {
    const w = raw as Record<string, unknown>
    return {
      name: String(w.name ?? 'Imported').slice(0, 200),
      lat: toCoord(w.lat, 'lat'),
      lon: toCoord(w.lon, 'lon'),
      note: String(w.note ?? ''),
    }
  })
  const waypoints = parsed.filter((w) => isValidLatLon(w.lat, w.lon))
  return { waypoints, skipped: parsed.length - waypoints.length }
}
