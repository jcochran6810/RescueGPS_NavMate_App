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
  photos?: string[]
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
