/**
 * What the command system sends to the field, and the rules for reading it.
 *
 * RescueGPS (incident command) writes search assignments, messages, hazards,
 * search areas and LKP revisions into its own tables on the shared database.
 * This file is the pure half of reading them: shapes, geometry parsing, who a
 * message is for, which hazards still apply. No network, no store — the
 * stores in `src/store/` do the fetching and hand the rows through here.
 *
 * Command tables say `lng`, NavMate says `lon`. The conversion happens here,
 * once, so nothing downstream has to remember which table a point came from.
 */

export interface LatLon {
  lat: number
  lon: number
}

/**
 * A timestamp as milliseconds. Compared as numbers, never as strings: the
 * server writes `+00:00` and the phone writes `Z`, and the two do not sort
 * against each other as text.
 */
function ms(t: string | null | undefined): number {
  const n = t ? new Date(t).getTime() : Number.NaN
  return Number.isFinite(n) ? n : 0
}

/* -------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------- */

function validPoint(lat: unknown, lon: unknown): LatLon | null {
  const la = typeof lat === 'number' ? lat : Number.NaN
  const lo = typeof lon === 'number' ? lon : Number.NaN
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null
  return { lat: la, lon: lo }
}

/** A GeoJSON ring (`[lng, lat]` pairs) to points, or null if any is bad. */
function ringFromGeoJson(ring: unknown): LatLon[] | null {
  if (!Array.isArray(ring)) return null
  const out: LatLon[] = []
  for (const pair of ring) {
    if (!Array.isArray(pair) || pair.length < 2) return null
    const p = validPoint(pair[1], pair[0])
    if (!p) return null
    out.push(p)
  }
  return closedRing(out)
}

/** Drop the closing duplicate; a polygon needs three distinct corners. */
function closedRing(points: LatLon[]): LatLon[] | null {
  const pts = [...points]
  if (pts.length > 1) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (a.lat === b.lat && a.lon === b.lon) pts.pop()
  }
  return pts.length >= 3 ? pts : null
}

/**
 * The outer ring of a polygon column, as PostgREST hands it over.
 *
 * PostGIS geography comes back as GeoJSON from a plain select — but depending
 * on how it was selected it can also arrive as EWKB hex. Hex is not decoded
 * here: a polygon that cannot be read is left undrawn, and an undrawn search
 * segment is far better than a crash or a guessed one. Holes are ignored —
 * the outer boundary is what a crew steers by.
 */
export function parsePolygon(geom: unknown): LatLon[] | null {
  if (geom == null) return null
  if (typeof geom === 'string') {
    const s = geom.trim()
    if (!s.startsWith('{')) return null // EWKB hex, or anything else
    try {
      return parsePolygon(JSON.parse(s))
    } catch {
      return null
    }
  }
  if (typeof geom !== 'object') return null
  const g = geom as { type?: unknown; coordinates?: unknown; geometry?: unknown }
  if (g.type === 'Feature') return parsePolygon(g.geometry)
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    return ringFromGeoJson(g.coordinates[0])
  }
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    const first = g.coordinates[0]
    return Array.isArray(first) ? ringFromGeoJson(first[0]) : null
  }
  return null
}

/**
 * The `coordinates` jsonb some search areas carry instead of (or as well as)
 * a polygon.
 *
 * Only named points are accepted — `{lat, lng}` or `{lat, lon}`. A bare
 * `[a, b]` pair is refused, because nothing in it says which number is the
 * latitude, and a search area drawn with its axes swapped lands in the wrong
 * ocean while looking perfectly plausible.
 */
export function parseCoordinateList(value: unknown): LatLon[] | null {
  if (!Array.isArray(value)) return null
  const out: LatLon[] = []
  for (const v of value) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const o = v as { lat?: unknown; lng?: unknown; lon?: unknown }
    const p = validPoint(o.lat, o.lng ?? o.lon)
    if (!p) return null
    out.push(p)
  }
  return closedRing(out)
}

/* -------------------------------------------------------------------------
 * Search assignments (field_assignments)
 * ---------------------------------------------------------------------- */

export type AssignmentStatus =
  | 'assigned'
  | 'en_route'
  | 'searching'
  | 'complete'
  | 'cancelled'

export type AssignmentPriority = 'low' | 'normal' | 'high' | 'urgent'

export interface FieldAssignment {
  id: string
  incident_id: string
  asset_id: string | null
  assigned_user_id: string | null
  created_by: string | null
  title: string | null
  instructions: string | null
  /** GeoJSON from PostgREST; possibly EWKB hex. Read with `parsePolygon`. */
  segment_geom: unknown
  pattern_type: string | null
  track_spacing_m: number | null
  target_speed_kts: number | null
  priority: AssignmentPriority
  status: AssignmentStatus
  created_at: string
  updated_at: string
}

/** The only statuses a field unit may write — the server refuses the rest. */
export const FIELD_STATUS_STEPS: { value: AssignmentStatus; label: string }[] = [
  { value: 'en_route', label: 'En route' },
  { value: 'searching', label: 'Searching' },
  { value: 'complete', label: 'Complete' },
]

export const ASSIGNMENT_STATUS_LABEL: Record<AssignmentStatus, string> = {
  assigned: 'Assigned',
  en_route: 'En route',
  searching: 'Searching',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

const PRIORITY_RANK: Record<AssignmentPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

/**
 * Whether a crew can move an assignment to `to`.
 *
 * Only the three field steps, never to where it already is, and never out of
 * complete or cancelled: a segment command has cancelled is not this crew's
 * to restart, and one they have reported complete is re-tasked by command,
 * not reopened by a mis-tap.
 */
export function canMoveTo(from: AssignmentStatus, to: AssignmentStatus): boolean {
  if (from === to) return false
  if (from === 'complete' || from === 'cancelled') return false
  return FIELD_STATUS_STEPS.some((s) => s.value === to)
}

/** Tasked to this crew member directly, or to the unit they are crewing. */
export function isMine(
  a: Pick<FieldAssignment, 'assigned_user_id' | 'asset_id'>,
  userId: string | null,
  unitId: string | null,
): boolean {
  if (userId && a.assigned_user_id === userId) return true
  return !!unitId && a.asset_id === unitId
}

/**
 * The assignments worth showing, in the order worth reading them: this crew's
 * first, then by priority, newest first within a priority. Cancelled ones are
 * dropped — a cancelled segment on the map is a segment somebody searches.
 */
export function sortAssignments(
  list: FieldAssignment[],
  userId: string | null,
  unitId: string | null,
): FieldAssignment[] {
  return list
    .filter((a) => a.status !== 'cancelled')
    .sort((a, b) => {
      const ma = isMine(a, userId, unitId) ? 0 : 1
      const mb = isMine(b, userId, unitId) ? 0 : 1
      if (ma !== mb) return ma - mb
      const pa = PRIORITY_RANK[a.priority] ?? 2
      const pb = PRIORITY_RANK[b.priority] ?? 2
      if (pa !== pb) return pa - pb
      return ms(b.created_at) - ms(a.created_at)
    })
}

/* -------------------------------------------------------------------------
 * Messages (field_messages)
 * ---------------------------------------------------------------------- */

export type MessagePriority = 'normal' | 'urgent' | 'emergency'

export interface FieldMessage {
  id: string
  client_id: string | null
  incident_id: string
  sender_id: string
  recipient_id: string | null
  recipient_asset_id: string | null
  body: string
  priority: MessagePriority
  thread_id: string | null
  in_reply_to: string | null
  delivered_at: string | null
  read_at: string | null
  created_at: string
}

/** Who a message was addressed to, from this crew's side, or null if not us. */
export function messageAudience(
  m: Pick<FieldMessage, 'recipient_id' | 'recipient_asset_id'>,
  userId: string | null,
  unitId: string | null,
): 'me' | 'unit' | 'all' | null {
  if (m.recipient_id == null && m.recipient_asset_id == null) return 'all'
  if (userId && m.recipient_id === userId) return 'me'
  if (unitId && m.recipient_asset_id === unitId) return 'unit'
  return null
}

/** Addressed to this crew (by any of the three routes), and not sent by them. */
export function isIncoming(
  m: FieldMessage,
  userId: string | null,
  unitId: string | null,
): boolean {
  return m.sender_id !== userId && messageAudience(m, userId, unitId) !== null
}

/** The inbox and this crew's own sent messages, newest first. */
export function inbox(
  list: FieldMessage[],
  userId: string | null,
  unitId: string | null,
): FieldMessage[] {
  return list
    .filter((m) => m.sender_id === userId || isIncoming(m, userId, unitId))
    .sort((a, b) => ms(b.created_at) - ms(a.created_at))
}

/** A reply's threading fields: answer this one, stay in its thread. */
export function replyFields(
  m: Pick<FieldMessage, 'id' | 'thread_id'>,
): { in_reply_to: string; thread_id: string } {
  return { in_reply_to: m.id, thread_id: m.thread_id ?? m.id }
}

/**
 * The emergency message the crew has not yet acknowledged, if any — the one
 * the full-screen alert is for. Oldest first: two emergencies are read in the
 * order they were sent.
 */
export function pendingEmergency(
  list: FieldMessage[],
  userId: string | null,
  unitId: string | null,
): FieldMessage | null {
  return (
    list
      .filter(
        (m) =>
          m.priority === 'emergency' &&
          !m.read_at &&
          isIncoming(m, userId, unitId),
      )
      .sort((a, b) => ms(a.created_at) - ms(b.created_at))[0] ?? null
  )
}

/* -------------------------------------------------------------------------
 * Hazards (incident_hazards)
 * ---------------------------------------------------------------------- */

export type HazardType =
  | 'fuel_spill'
  | 'debris'
  | 'electrical'
  | 'shallow_water'
  | 'strong_current'
  | 'fire'
  | 'chemical'
  | 'submerged_object'
  | 'restricted_airspace'
  | 'other'

export type HazardSeverity = 'low' | 'medium' | 'high' | 'critical'

/** The incident_hazards CHECK list, in the order a crew would look for them. */
export const HAZARD_TYPES: { value: HazardType; label: string }[] = [
  { value: 'debris', label: 'Debris' },
  { value: 'submerged_object', label: 'Submerged object' },
  { value: 'shallow_water', label: 'Shallow water' },
  { value: 'strong_current', label: 'Strong current' },
  { value: 'fuel_spill', label: 'Fuel spill' },
  { value: 'chemical', label: 'Chemical' },
  { value: 'fire', label: 'Fire' },
  { value: 'electrical', label: 'Electrical' },
  { value: 'restricted_airspace', label: 'Restricted airspace' },
  { value: 'other', label: 'Other' },
]

export const HAZARD_SEVERITIES: { value: HazardSeverity; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
]

/** SVG colours per severity — drawn on imagery, so they carry their own. */
export const SEVERITY_COLOR: Record<HazardSeverity, string> = {
  low: '#facc15',
  medium: '#fb923c',
  high: '#f87171',
  critical: '#dc2626',
}

export function hazardTypeLabel(value: string): string {
  return HAZARD_TYPES.find((t) => t.value === value)?.label ?? value
}

export interface IncidentHazard {
  id: string
  incident_id: string
  reported_by: string | null
  hazard_type: HazardType
  severity: HazardSeverity
  label: string | null
  description: string | null
  lat: number | null
  lng: number | null
  radius_m: number | null
  geom_geojson: unknown
  active: boolean
  expires_at: string | null
  created_at: string
}

/** Hazards that still apply at `nowMs`: active, not expired, with a position. */
export function activeHazards(
  list: IncidentHazard[],
  nowMs: number,
): IncidentHazard[] {
  return list.filter((h) => {
    if (h.active === false) return false
    if (h.expires_at && ms(h.expires_at) <= nowMs) return false
    return validPoint(h.lat, h.lng) !== null
  })
}

/* -------------------------------------------------------------------------
 * Search areas and the command LKP
 * ---------------------------------------------------------------------- */

export interface SearchArea {
  id: string
  incident_id: string
  name: string | null
  area_type: string | null
  polygon: unknown
  coordinates: unknown
  status: string | null
  priority: string | number | null
}

/** A search area's outline: the polygon column first, the jsonb as fallback. */
export function searchAreaRing(a: Pick<SearchArea, 'polygon' | 'coordinates'>): LatLon[] | null {
  return parsePolygon(a.polygon) ?? parseCoordinateList(a.coordinates)
}

export interface LkpHistoryRow {
  incident_id: string
  lat: number
  lng: number
  time: string
  source: string | null
  confidence: number | string | null
  deleted_at?: string | null
}

/** The current LKP as command holds it: newest non-deleted row, in `lon`. */
export function latestLkp(
  rows: LkpHistoryRow[],
): (LatLon & { time: string; source: string | null }) | null {
  const best = rows
    .filter((r) => !r.deleted_at && validPoint(r.lat, r.lng))
    .sort((a, b) => ms(b.time) - ms(a.time))[0]
  return best ? { lat: best.lat, lon: best.lng, time: best.time, source: best.source } : null
}

/* -------------------------------------------------------------------------
 * Other units, live from asset_tracks
 * ---------------------------------------------------------------------- */

/** The unit fields a live track row can update. */
export interface UnitPosition {
  user_id: string
  lat: number
  lng: number
  heading_deg: number | null
  speed_mps: number | null
  accuracy_m: number | null
  recorded_at: string
}

/**
 * Fold one live track row into the unit list.
 *
 * Returns the new list, the same list when the row changes nothing (older
 * than what is shown — late uploads arrive out of order, and `recorded_at`
 * decides, never arrival), or null when the row is from a unit not yet on the
 * list: the row carries no name, so the caller asks the server who it is.
 */
export function applyTrackRow<T extends UnitPosition>(
  units: T[],
  row: UnitPosition,
): T[] | null {
  const i = units.findIndex((u) => u.user_id === row.user_id)
  if (i < 0) return null
  if (ms(row.recorded_at) < ms(units[i].recorded_at)) return units
  const next = [...units]
  next[i] = {
    ...units[i],
    lat: row.lat,
    lng: row.lng,
    heading_deg: row.heading_deg,
    speed_mps: row.speed_mps,
    accuracy_m: row.accuracy_m,
    recorded_at: row.recorded_at,
  }
  return next
}

/* -------------------------------------------------------------------------
 * The command picture, ready to draw
 * ---------------------------------------------------------------------- */

/** What a map draws of the command picture. Plain positions, `lon`. */
export interface MapIncidentLayer {
  /** Search segments and search areas, outline only. */
  areas: {
    id: string
    ring: LatLon[]
    kind: 'assignment' | 'search_area'
    /** Tasked to this crew — drawn bright; everyone else's dimmed. */
    mine: boolean
    label: string
  }[]
  hazards: {
    id: string
    lat: number
    lon: number
    radiusM: number | null
    color: string
    label: string
  }[]
  lkp: (LatLon & { label: string }) | null
}

/** A segment's label: title, then how to search it, in the units a crew uses. */
export function assignmentLabel(
  a: Pick<FieldAssignment, 'title' | 'pattern_type' | 'track_spacing_m' | 'target_speed_kts'>,
): string {
  const parts = [a.title?.trim() || 'Assignment']
  if (a.pattern_type) parts.push(a.pattern_type.replace(/_/g, ' '))
  if (a.track_spacing_m != null) parts.push(`S ${Math.round(a.track_spacing_m)} m`)
  if (a.target_speed_kts != null) parts.push(`${a.target_speed_kts} kn`)
  return parts.join(' · ')
}

/**
 * Turn the command rows into shapes. Anything that cannot be drawn honestly
 * — an unreadable polygon, a hazard with no position, one that has expired —
 * is left out rather than guessed at.
 */
export function buildIncidentLayer(input: {
  assignments: FieldAssignment[]
  areas: SearchArea[]
  hazards: IncidentHazard[]
  lkp: (LatLon & { time: string }) | null
  userId: string | null
  unitId: string | null
  nowMs: number
}): MapIncidentLayer {
  const areas: MapIncidentLayer['areas'] = []
  for (const a of input.areas) {
    const ring = searchAreaRing(a)
    if (ring) {
      areas.push({
        id: `area:${a.id}`,
        ring,
        kind: 'search_area',
        mine: false,
        label: a.name?.trim() || 'Search area',
      })
    }
  }
  for (const a of sortAssignments(input.assignments, input.userId, input.unitId)) {
    const ring = parsePolygon(a.segment_geom)
    if (ring) {
      areas.push({
        id: `assignment:${a.id}`,
        ring,
        kind: 'assignment',
        mine: isMine(a, input.userId, input.unitId),
        label: assignmentLabel(a),
      })
    }
  }
  const hazards = activeHazards(input.hazards, input.nowMs).map((h) => ({
    id: h.id,
    lat: h.lat as number,
    lon: h.lng as number,
    radiusM: h.radius_m ?? null,
    color: SEVERITY_COLOR[h.severity] ?? SEVERITY_COLOR.medium,
    label: h.label?.trim() || hazardTypeLabel(h.hazard_type),
  }))
  return {
    areas,
    hazards,
    lkp: input.lkp ? { lat: input.lkp.lat, lon: input.lkp.lon, label: 'LKP (command)' } : null,
  }
}
