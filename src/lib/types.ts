export interface Profile {
  id: string
  email: string | null
  full_name: string
  callsign: string
  created_at: string
  updated_at: string
}

export interface Team {
  id: string
  name: string
  join_code: string
  created_by: string
  created_at: string
}

export type TeamRole = 'owner' | 'admin' | 'member'

export interface TeamMember {
  team_id: string
  user_id: string
  role: TeamRole
  joined_at: string
  profile?: Profile | null
}

export interface Waypoint {
  id: string
  user_id: string
  /** null = private to this account; otherwise shared with that team. */
  team_id: string | null
  name: string
  lat: number
  lon: number
  note: string
  /** Storage object paths in the `waypoint-photos` bucket. */
  photos: string[]
  created_at: string
  updated_at: string
}

/** Fields the client supplies when creating a waypoint. */
export type NewWaypoint = Pick<Waypoint, 'name' | 'lat' | 'lon' | 'note'> & {
  team_id?: string | null
}

/* -------------------------------------------------------------------------
 * SAR datum records — what a single unit collects while searching.
 * Kind-specific detail lives in `payload`, shaped so each kind projects
 * cleanly onto the matching RescueGPS table when the databases merge
 * (lkp_history, field_drift_data, field_events, weather_snapshots).
 * ---------------------------------------------------------------------- */

export type SarKind = 'lkp' | 'clue' | 'drift_marker' | 'environment'

export interface LkpPayload {
  source: 'gps' | 'witness' | 'estimated'
  /** RescueGPS leeway_type key. */
  object_type: string
  position_error_nm: number
}

export interface CluePayload {
  clue_type:
    | 'debris'
    | 'clothing'
    | 'vessel'
    | 'life_jacket'
    | 'personal_item'
    | 'fuel_sheen'
    | 'other'
}

export interface DriftMarkerPayload {
  marker_type: 'orange' | 'smoke' | 'dye' | 'debris' | 'custom'
  deploy: { lat: number; lon: number; time: string }
  retrieve?: { lat: number; lon: number; time: string }
  /** Derived at retrieve time. Direction of movement, degrees true. */
  set_deg?: number
  drift_kts?: number
  distance_nm?: number
  hours?: number
}

export interface EnvironmentPayload {
  /** Where the wind blows FROM, degrees true (meteorological convention). */
  wind_from_deg?: number | null
  wind_kts?: number | null
  /** Where the current flows TOWARD, degrees true (oceanographic). */
  current_toward_deg?: number | null
  current_kts?: number | null
  water_temp_c?: number | null
}

export type SarPayload =
  | LkpPayload
  | CluePayload
  | DriftMarkerPayload
  | EnvironmentPayload

export interface SarRecord {
  id: string
  /** Offline-sync idempotency key (RescueGPS contract). Equals id here. */
  client_id: string
  user_id: string
  /** null = private to this account; otherwise shared with that team. */
  team_id: string | null
  /** The search this record was collected under, when one was open. */
  incident_id: string | null
  kind: SarKind
  lat: number | null
  lon: number | null
  /** When the thing was observed (device time), not when the row was made. */
  recorded_at: string
  payload: SarPayload
  note: string
  created_at: string
  updated_at: string
}

/** Fields the client supplies when logging a record. */
export type NewSarRecord = Pick<
  SarRecord,
  'kind' | 'lat' | 'lon' | 'recorded_at' | 'payload' | 'note'
> & { team_id?: string | null; incident_id?: string | null }

/* -------------------------------------------------------------------------
 * Incidents — the container a search runs in. Column names, type codes and
 * status values mirror the RescueGPS `incidents` table so a field-opened
 * incident can be adopted by command as an insert, not a translation.
 * Note lkp_lng: RescueGPS says lng, never lon, and this row is theirs.
 * ---------------------------------------------------------------------- */

export type IncidentStatus =
  | 'active'
  | 'suspended'
  | 'completed'
  | 'cancelled'
  | 'found_alive'
  | 'found_deceased'
  | 'not_found'
  | 'false_alarm'
  | 'closed'

export type UrgencyLevel = 'critical' | 'high' | 'medium' | 'low'

export interface Incident {
  id: string
  /** Offline-sync idempotency key. Equals id here. */
  client_id: string
  /** null = private to this account; otherwise the whole team's search. */
  team_id: string | null
  incident_number: string
  incident_type: string
  incident_name: string
  urgency_level: UrgencyLevel
  status: IncidentStatus
  lkp_lat: number | null
  lkp_lng: number | null
  lkp_time: string | null
  lkp_source: string | null
  /** When the person went into the water — drift time starts here. */
  incident_time: string | null
  summary: string
  created_by: string
  created_at: string
  updated_at: string
}

/** Fields the client supplies when opening an incident. */
export type NewIncident = Pick<Incident, 'incident_type' | 'incident_name'> & {
  team_id?: string | null
}

/* -------------------------------------------------------------------------
 * Platform admin
 * ---------------------------------------------------------------------- */

export type RequestKind = 'help' | 'account' | 'team' | 'data' | 'bug' | 'other'
export type RequestStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed'

export interface SupportRequest {
  id: string
  user_id: string
  kind: RequestKind
  subject: string
  body: string
  status: RequestStatus
  admin_notes: string
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

/** What admin_metrics() returns. */
export interface AdminMetrics {
  users_total: number
  users_new_7d: number
  users_new_30d: number
  users_active_7d: number
  teams_total: number
  team_members_total: number
  waypoints_total: number
  waypoints_7d: number
  photos_total: number
  sar_records_total: number
  sar_records_7d: number
  sar_by_kind: Record<string, number>
  requests_open: number
  requests_in_progress: number
  requests_total: number
  errors_24h: number
  errors_7d: number
  storage_bytes: number
  generated_at: string
}

/** One row of admin_list_users(). */
export interface AdminUser {
  user_id: string
  email: string
  full_name: string
  callsign: string
  created_at: string
  last_sign_in_at: string | null
  team_count: number
  waypoint_count: number
  sar_record_count: number
  open_requests: number
  is_admin: boolean
}

export interface AdminAction {
  id: string
  admin_user_id: string | null
  action: string
  target_kind: string | null
  target_id: string | null
  payload: Record<string, unknown>
  created_at: string
}

export interface Fix {
  lat: number
  lon: number
  /** Metres per second, or null when the device does not report it. */
  speed: number | null
  /** Degrees true, or null. */
  heading: number | null
  /** Metres. */
  accuracy: number | null
  /** Metres above the WGS-84 ellipsoid, or null. */
  altitude: number | null
  timestamp: number
}
