/** Export and import of waypoint sets: JSON, GPX and CSV. */

import type { NewWaypoint, Waypoint } from './types'

export type ExportFormat = 'json' | 'gpx' | 'csv'

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
    `<gpx version="1.1" creator="RescueGPS NavMate" ` +
    `xmlns="http://www.topografix.com/GPX/1/1">\n${pts}\n</gpx>\n`
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

function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  )
}

/**
 * Read a JSON or GPX backup into waypoints ready to be inserted.
 * Photos are not carried across — they live in Storage, and a file from
 * another account could not be read anyway.
 */
export function parseImport(text: string, filename = ''): NewWaypoint[] {
  const looksXml = filename.toLowerCase().endsWith('.gpx') || text.trim().startsWith('<')

  if (looksXml) {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('That file is not valid GPX')
    }
    return Array.from(doc.getElementsByTagName('wpt'))
      .map((n) => ({
        name: n.getElementsByTagName('name')[0]?.textContent?.trim() || 'Imported',
        lat: Number(n.getAttribute('lat')),
        lon: Number(n.getAttribute('lon')),
        note: n.getElementsByTagName('desc')[0]?.textContent?.trim() || '',
      }))
      .filter((w) => isValidLatLon(w.lat, w.lon))
  }

  const data: unknown = JSON.parse(text)
  const list: unknown = Array.isArray(data)
    ? data
    : ((data as { waypoints?: unknown })?.waypoints ?? [])

  if (!Array.isArray(list)) throw new Error('No waypoints found in that file')

  return list
    .map((raw) => {
      const w = raw as Record<string, unknown>
      return {
        name: String(w.name ?? 'Imported').slice(0, 200),
        lat: Number(w.lat),
        lon: Number(w.lon),
        note: String(w.note ?? ''),
      }
    })
    .filter((w) => isValidLatLon(w.lat, w.lon))
}
