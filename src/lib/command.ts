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

/*
 * EWKB — how PostGIS hands over a `geography` column.
 *
 * `search_areas.polygon` and `field_assignments.segment_geom` are geography,
 * and geography has no JSON cast: PostgREST, Realtime and `to_json` all send it
 * as a hex string of Extended Well-Known Binary. (A `geometry` column would
 * come back as GeoJSON — that is the difference, and it is why every search
 * area command drew had been arriving here unreadable and left off the chart.)
 *
 * Layout: a byte-order flag (1 = little-endian), a uint32 type whose low bits
 * are the geometry type and whose high bits flag Z, M and an embedded SRID,
 * the SRID if flagged, then the body. Only what this app draws is read —
 * Polygon (3) and MultiPolygon (6), outer ring of the first polygon — and
 * anything else, or anything that runs off the end of the buffer, is refused
 * rather than guessed at.
 */
const EWKB_Z = 0x80000000
const EWKB_M = 0x40000000
const EWKB_SRID = 0x20000000

class WkbReader {
  private pos = 0
  private readonly view: DataView
  constructor(view: DataView) {
    this.view = view
  }

  private need(n: number): void {
    if (this.pos + n > this.view.byteLength) throw new RangeError('EWKB truncated')
  }
  byte(): number {
    this.need(1)
    return this.view.getUint8(this.pos++)
  }
  uint32(little: boolean): number {
    this.need(4)
    const v = this.view.getUint32(this.pos, little)
    this.pos += 4
    return v
  }
  double(little: boolean): number {
    this.need(8)
    const v = this.view.getFloat64(this.pos, little)
    this.pos += 8
    return v
  }
}

/** One geometry header: byte order, base type and coordinate width. */
function wkbHeader(r: WkbReader): { little: boolean; type: number; dims: number } {
  const order = r.byte()
  if (order !== 0 && order !== 1) throw new RangeError('EWKB byte order')
  const little = order === 1
  const raw = r.uint32(little)
  if (raw & EWKB_SRID) r.uint32(little) // the SRID; geography is always 4326
  // ISO WKB says Z/M in the thousands (1003, 2003, 3003); EWKB in the flags.
  const iso = (raw & 0x0fffffff) % 1000
  const isoDims = Math.floor((raw & 0x0fffffff) / 1000)
  const z = (raw & EWKB_Z) !== 0 || isoDims === 1 || isoDims === 3
  const m = (raw & EWKB_M) !== 0 || isoDims === 2 || isoDims === 3
  return { little, type: iso, dims: 2 + (z ? 1 : 0) + (m ? 1 : 0) }
}

/** The rings of a polygon body (after its header), outer ring first. */
function wkbPolygonRings(r: WkbReader, little: boolean, dims: number): LatLon[][] {
  const rings: LatLon[][] = []
  const nRings = r.uint32(little)
  if (nRings > 10_000) throw new RangeError('EWKB ring count')
  for (let i = 0; i < nRings; i++) {
    const n = r.uint32(little)
    if (n > 1_000_000) throw new RangeError('EWKB point count')
    const ring: LatLon[] = []
    for (let k = 0; k < n; k++) {
      const x = r.double(little)
      const y = r.double(little)
      for (let d = 2; d < dims; d++) r.double(little)
      const p = validPoint(y, x)
      if (!p) throw new RangeError('EWKB point out of range')
      ring.push(p)
    }
    rings.push(ring)
  }
  return rings
}

/**
 * The outer ring of an EWKB/WKB hex polygon (or the first polygon of a
 * multipolygon), or null when the string is not one.
 */
export function polygonFromEwkbHex(hex: string): LatLon[] | null {
  const s = hex.trim()
  if (s.length < 18 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null
  const bytes = new Uint8Array(s.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  }
  try {
    const r = new WkbReader(new DataView(bytes.buffer))
    const head = wkbHeader(r)
    if (head.type === 3) {
      const rings = wkbPolygonRings(r, head.little, head.dims)
      return rings.length > 0 ? closedRing(rings[0]) : null
    }
    if (head.type === 6) {
      const n = r.uint32(head.little)
      if (n < 1) return null
      const inner = wkbHeader(r)
      if (inner.type !== 3) return null
      const rings = wkbPolygonRings(r, inner.little, inner.dims)
      return rings.length > 0 ? closedRing(rings[0]) : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * The outer ring of a polygon column, as PostgREST hands it over.
 *
 * A `geometry` column arrives as GeoJSON; a `geography` column — which is
 * what command's `search_areas.polygon` and `field_assignments.segment_geom`
 * are — arrives as EWKB hex, from a select and over Realtime alike. Both are
 * read. A polygon that cannot be read is left undrawn: an undrawn search
 * segment is far better than a crash or a guessed one. Holes are ignored —
 * the outer boundary is what a crew steers by.
 */
export function parsePolygon(geom: unknown): LatLon[] | null {
  if (geom == null) return null
  if (typeof geom === 'string') {
    const s = geom.trim()
    if (!s.startsWith('{')) return polygonFromEwkbHex(s)
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
  /** geography: EWKB hex from PostgREST and Realtime. Read with `parsePolygon`. */
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

/** Who a new field message is for: command, or everyone on the search. */
export type MessageTarget = 'command' | 'everyone'

/**
 * The `recipient_id` of a message sent from the field.
 *
 * A reply goes to whoever sent the original. A new message "to command" goes
 * to the incident's current IC: the RescueGPS dashboard counts a message as
 * unread — on its Comms tab and in the conversation — only when it is
 * addressed to the person looking, and only the addressee may mark it read,
 * so a message to "everyone" raised no badge on the IC's screen and could
 * never come back as read. "Everyone" still goes to the whole incident (other
 * crews included), and so does a message to command when no IC is known yet
 * or this crew member is the IC.
 */
export function messageRecipient(input: {
  replyTo: Pick<FieldMessage, 'sender_id'> | null
  to: MessageTarget
  icId: string | null
  userId: string
}): string | null {
  if (input.replyTo) return input.replyTo.sender_id
  if (input.to === 'command' && input.icId && input.icId !== input.userId) return input.icId
  return null
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
  // River segments (RescueGPS Narrow Water Search NW4,
  // database/integration/nw4_river_segments.sql there). Absent on a
  // database without those columns.
  segment_number?: number | null
  along_start_m?: number | null
  along_end_m?: number | null
  poc?: number | null
  pod?: number | null
  source?: string | null
  searched_at?: string | null
  searched_by?: string | null
  deleted_at?: string | null
}

/** A row command soft-deleted (a re-cut of the river) is not shown. */
export function liveSearchAreas(areas: SearchArea[]): SearchArea[] {
  return areas.filter((a) => !a.deleted_at)
}

/* -------------------------------------------------------------------------
 * Catch points (command's Narrow Water Search, NW5; table catch_points)
 * ---------------------------------------------------------------------- */

export type CatchPointKind =
  | 'strainer' | 'log_jam' | 'eddy' | 'low_head_dam' | 'dam' | 'bridge' | 'confluence' | 'bend' | 'snag' | 'other'

export interface CatchPoint {
  id: string
  incident_id: string
  kind: CatchPointKind
  label: string | null
  notes: string | null
  source: 'field' | 'command'
  lat: number
  lng: number
  reported_by: string | null
  created_at: string
  deleted_at: string | null
}

/** What a crew can report (the database lists the same). */
export const CATCH_POINT_KINDS: { value: CatchPointKind; label: string }[] = [
  { value: 'strainer', label: 'Strainer' },
  { value: 'log_jam', label: 'Log jam' },
  { value: 'eddy', label: 'Eddy' },
  { value: 'low_head_dam', label: 'Low-head dam' },
  { value: 'snag', label: 'Snag' },
  { value: 'other', label: 'Other' },
]

export const CATCH_POINT_LABEL: Record<string, string> = {
  strainer: 'Strainer', log_jam: 'Log jam', eddy: 'Eddy', low_head_dam: 'Low-head dam',
  dam: 'Dam', bridge: 'Bridge', confluence: 'Tributary joins', bend: 'Sharp bend', snag: 'Snag', other: 'Catch point',
}

export const CATCH_POINT_COLOR = '#f97316'

/* -------------------------------------------------------------------------
 * River segments (command's Narrow Water Search, NW4)
 * ---------------------------------------------------------------------- */

export const RIVER_SEGMENT_SOURCE = 'narrow_water'

export type RiverSegmentStatus = 'pending' | 'in_progress' | 'completed' | 'negative' | 'suspended'

export const RIVER_SEGMENT_STATUS_LABEL: Record<string, string> = {
  pending: 'Not searched',
  in_progress: 'Searching',
  completed: 'Searched',
  negative: 'Negative',
  suspended: 'Suspended',
}

/** The three marks a crew may make (the database refuses anything else). */
export const RIVER_SEGMENT_FIELD_STEPS: { value: RiverSegmentStatus; label: string; hint: string }[] = [
  { value: 'in_progress', label: 'Searching', hint: 'We are on this segment now' },
  { value: 'completed', label: 'Searched', hint: 'Searched — command decides what it counts for' },
  { value: 'negative', label: 'Negative', hint: 'Searched, not found — command applies it with the POD' },
]

/** Command's river segments, upstream first. */
export function riverSegments(areas: SearchArea[]): SearchArea[] {
  return liveSearchAreas(areas)
    .filter((a) => a.source === RIVER_SEGMENT_SOURCE && Number.isFinite(a.segment_number as number))
    .sort((a, b) => (a.along_start_m ?? 0) - (b.along_start_m ?? 0))
}

/** The row change a crew sends for a mark: status, who and when only. */
export function riverSegmentPatch(
  status: RiverSegmentStatus,
  userId: string | null,
  nowIso: string,
): Partial<SearchArea> {
  return status === 'in_progress'
    ? { status }
    : { status, searched_at: nowIso, ...(userId ? { searched_by: userId } : {}) }
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

/** The newest non-deleted `lkp_history` row, in `lon`. */
export function latestLkp(
  rows: LkpHistoryRow[],
): (LatLon & { time: string; source: string | null }) | null {
  const best = rows
    .filter((r) => !r.deleted_at && validPoint(r.lat, r.lng))
    .sort((a, b) => ms(b.time) - ms(a.time))[0]
  return best ? { lat: best.lat, lon: best.lng, time: best.time, source: best.source } : null
}

/** The LKP columns of the incident row. Postgres `numeric` may arrive as text. */
export interface IncidentLkpRow {
  lkp_lat: number | string | null
  lkp_lng: number | string | null
  lkp_time: string | null
  lkp_source: string | null
  updated_at?: string | null
}

function asNumber(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The LKP command is working to.
 *
 * That is the incident's own `lkp_lat`/`lkp_lng` — what the RescueGPS
 * dashboard shows, and what its IC moves when the picture changes.
 * `lkp_history` is only the fallback for an incident whose row has no LKP:
 * on this database nothing but NavMate's own fan-out writes it (measured
 * 2026-10-02: every row `source = 'navmate'`), so reading it alone showed a
 * crew their own LKP labelled as command's, and never the one command moved.
 */
export function commandLkp(
  incident: IncidentLkpRow | null,
  history: LkpHistoryRow[],
): (LatLon & { time: string; source: string | null }) | null {
  if (incident) {
    const p = validPoint(asNumber(incident.lkp_lat), asNumber(incident.lkp_lng))
    if (p) {
      return {
        ...p,
        time: incident.lkp_time ?? incident.updated_at ?? '',
        source: incident.lkp_source,
      }
    }
  }
  return latestLkp(history)
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
  /** Catch points (NW5): crews' and command's, drawn as diamonds. */
  catchPoints?: { id: string; lat: number; lon: number; label: string }[]
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
  catchPoints?: CatchPoint[]
}): MapIncidentLayer {
  const areas: MapIncidentLayer['areas'] = []
  for (const a of liveSearchAreas(input.areas)) {
    const ring = searchAreaRing(a)
    if (ring) {
      areas.push({
        id: `area:${a.id}`,
        ring,
        kind: 'search_area',
        mine: false,
        label:
          (a.name?.trim() || 'Search area') +
          (a.source === RIVER_SEGMENT_SOURCE && a.status && a.status !== 'pending'
            ? ` · ${RIVER_SEGMENT_STATUS_LABEL[a.status] ?? a.status}`
            : ''),
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
    catchPoints: (input.catchPoints ?? [])
      .filter((p) => !p.deleted_at && validPoint(p.lat, p.lng))
      .map((p) => ({
        id: p.id,
        lat: p.lat,
        lon: p.lng,
        label: p.label?.trim() || CATCH_POINT_LABEL[p.kind] || 'Catch point',
      })),
  }
}
