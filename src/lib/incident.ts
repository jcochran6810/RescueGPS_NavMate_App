/**
 * Incident identity and the command handoff — the seam between NavMate (the
 * unit in the field) and RescueGPS (the incident command system).
 *
 * A unit on scene opens the incident; everything the team collects hangs off
 * it; and when an incident commander stands up RescueGPS, the handoff report
 * carries the whole picture across in that system's own table shapes and
 * field names, ready to be inserted rather than translated.
 */

import type { Incident, SarRecord, CluePayload, DriftMarkerPayload, EnvironmentPayload, LkpPayload } from './types'
import { canonicalObjectKey, driftStartsAt } from './sar'
import { NM_TO_KM } from './geo'

/**
 * The incident types a field unit picks between — RescueGPS's own field
 * shortcut list (its field-activation screen), all valid against its
 * incidents CHECK constraint.
 */
export const INCIDENT_TYPES: { value: string; label: string }[] = [
  { value: 'piw', label: 'Person in water' },
  { value: 'swimmer', label: 'Swimmer in trouble' },
  { value: 'kayak', label: 'Kayaker missing / overdue' },
  { value: 'jumper', label: 'Jumper / long fall' },
  { value: 'missing_vessel', label: 'Missing / overdue vessel' },
  { value: 'capsized_vessel', label: 'Capsized vessel' },
  { value: 'vessel_in_distress', label: 'Vessel in distress' },
  { value: 'missing_person', label: 'Missing person' },
  { value: 'diver', label: 'Diver missing / overdue' },
  { value: 'life_raft', label: 'Life raft sighted' },
  { value: 'debris_field', label: 'Debris field found' },
  { value: 'medical', label: 'Medical emergency' },
  { value: 'other', label: 'Other' },
]

/**
 * Codes no longer offered, but still readable.
 *
 * A type is removed from the picker, never from this map. The code lives on in
 * every incident already opened with it — in this database and in the command
 * system's — and dropping the label would turn a closed search's type into the
 * raw string `jetski` on screen. Retiring a choice is a decision about what to
 * offer next time, not about what happened last time.
 */
const RETIRED_TYPE_LABELS: Record<string, string> = {
  jetski: 'Jet ski missing / overdue',
}

export function incidentTypeLabel(value: string): string {
  return (
    INCIDENT_TYPES.find((t) => t.value === value)?.label ??
    RETIRED_TYPE_LABELS[value] ??
    value
  )
}

/** Statuses a crew closes an incident with (the rest are lifecycle). */
export const CLOSE_STATUSES: { value: Incident['status']; label: string }[] = [
  { value: 'found_alive', label: 'Found alive' },
  { value: 'found_deceased', label: 'Found deceased' },
  { value: 'not_found', label: 'Search ended — not found' },
  { value: 'false_alarm', label: 'False alarm' },
  { value: 'cancelled', label: 'Cancelled' },
]

/**
 * INC-YYMMDD-XXXXX — RescueGPS's field-activation format, with the random
 * tail widened from four digits to five base-32 characters because their
 * four digits can collide and the column upstream is UNIQUE. Two units
 * opening incidents offline cannot check uniqueness, so the number has to
 * carry it.
 */
export function newIncidentNumber(now = new Date(), seed?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O/1/I/L
  let tail = ''
  if (seed) {
    // Deterministic from the incident's uuid, so retries agree.
    const hex = seed.replace(/[^0-9a-f]/gi, '')
    for (let i = 0; i < 5; i++) {
      const n = parseInt(hex.slice(i * 6, i * 6 + 6) || '0', 16)
      tail += alphabet[n % alphabet.length]
    }
  } else {
    for (let i = 0; i < 5; i++) {
      tail += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
  }
  return `INC-${date}-${tail}`
}

/* -------------------------------------------------------------------------
 * The handoff report
 * ---------------------------------------------------------------------- */

export interface HandoffInput {
  incident: Incident
  records: SarRecord[]
  /**
   * Who is being looked for, already in `victims` column names. Optional
   * because the handoff has always worked without it and an export that
   * refuses to run for a missing description is worse than one that says
   * nothing about it.
   */
  victim?: Record<string, unknown> | null
}

/**
 * Everything RescueGPS needs to adopt this search, keyed by its own tables:
 * the `incidents` insert payload (the exact shape its field-activation
 * screen sends, `lkp_source: 'field_gps'` included), `lkp_history` rows,
 * `field_drift_data` rows (its cleanest drift-seeding channel — a measured
 * drift card beats every forecast), clues as `field_events`, conditions in
 * its API naming, and `simulate_drift_params` for its drift engine with a
 * canonical leeway_type.
 */
export function incidentHandoff(input: HandoffInput): string {
  const { incident, records } = input
  const inIncident = records.filter((r) => r.incident_id === incident.id)

  const lkps = inIncident.filter((r) => r.kind === 'lkp')
  const latestLkp = lkps[0] ?? null
  const lkpPayload = latestLkp?.payload as LkpPayload | undefined
  const environment = inIncident.find((r) => r.kind === 'environment')
  const env = environment?.payload as EnvironmentPayload | undefined
  const markers = inIncident.filter((r) => r.kind === 'drift_marker')
  const clues = inIncident.filter((r) => r.kind === 'clue')

  const lkpTime = incident.lkp_time ?? latestLkp?.recorded_at ?? null
  // The same rule the worksheet uses: drift runs from whichever is LATER, the
  // LKP or the time in the water. `incident_time ?? lkpTime` took the entry
  // time whenever it existed, which double-counts the drift an LKP taken
  // later already contains — inflating the hours handed to command.
  const startMs = lkpTime
    ? driftStartsAt(
        new Date(lkpTime).getTime(),
        incident.incident_time ? new Date(incident.incident_time).getTime() : null,
      )
    : incident.incident_time
      ? new Date(incident.incident_time).getTime()
      : null
  const hoursAdrift =
    startMs != null ? Math.max(0, (Date.now() - startMs) / 3_600_000) : null

  return JSON.stringify(
    {
      format: 'rescuegps-navmate/incident-handoff',
      version: 1,
      generated_at: new Date().toISOString(),
      incident: {
        client_id: incident.client_id,
        incident_number: incident.incident_number,
        incident_type: incident.incident_type,
        incident_name: incident.incident_name,
        urgency_level: incident.urgency_level,
        status: incident.status,
        lkp_lat: incident.lkp_lat,
        lkp_lng: incident.lkp_lng,
        lkp_time: lkpTime,
        lkp_source: incident.lkp_source ?? 'field_gps',
        incident_time: incident.incident_time,
        time_last_alive: incident.time_last_alive,
        summary: incident.summary,
      },
      // Their table name, their column names — an insert, not a translation.
      victims: input.victim ? [input.victim] : [],
      lkp_history: lkps.map((r) => ({
        lat: r.lat,
        lng: r.lon,
        time: r.recorded_at,
        source: (r.payload as LkpPayload).source,
        notes: r.note,
      })),
      field_drift_data: markers
        .map((m) => m.payload as DriftMarkerPayload)
        .filter((p) => p.retrieve != null)
        .map((p) => ({
          marker_type: p.marker_type,
          deploy_lat: p.deploy.lat,
          deploy_lng: p.deploy.lon,
          deploy_time: p.deploy.time,
          retrieve_lat: p.retrieve!.lat,
          retrieve_lng: p.retrieve!.lon,
          retrieve_time: p.retrieve!.time,
          distance_km:
            p.distance_nm != null
              ? Math.round(p.distance_nm * NM_TO_KM * 1000) / 1000
              : null,
          bearing: p.set_deg != null ? Math.round(p.set_deg) : null,
          speed_knots:
            p.drift_kts != null ? Math.round(p.drift_kts * 100) / 100 : null,
        })),
      field_events: clues.map((c) => ({
        event_type: 'clue_found',
        severity: 'info',
        description:
          `${(c.payload as CluePayload).clue_type}${c.note ? `: ${c.note}` : ''}`,
        lat: c.lat,
        lng: c.lon,
        recorded_at: c.recorded_at,
      })),
      environmental: {
        wind_speed_kts: env?.wind_kts ?? null,
        wind_direction_deg: env?.wind_from_deg ?? null,
        current_speed_kts: env?.current_kts ?? null,
        current_direction_deg: env?.current_toward_deg ?? null,
        water_temp_c: env?.water_temp_c ?? null,
      },
      simulate_drift_params:
        incident.lkp_lat != null && incident.lkp_lng != null
          ? {
              lat: incident.lkp_lat,
              lng: incident.lkp_lng,
              wind_speed_kts: env?.wind_kts ?? 0,
              wind_direction_deg: env?.wind_from_deg ?? 0,
              current_speed_kts: env?.current_kts ?? 0,
              current_direction_deg: env?.current_toward_deg ?? 0,
              leeway_type: canonicalObjectKey(
                lkpPayload?.object_type ?? 'person_in_water',
              ),
              duration_hrs:
                hoursAdrift != null
                  ? Math.max(1, Math.ceil(hoursAdrift) + 6)
                  : 24,
            }
          : null,
    },
    null,
    2,
  )
}

/**
 * The records that belong to the search being run right now.
 *
 * Team scope alone is not enough, and the gap was a real one: the datum
 * worksheet filtered by team and nothing else, so the LKP, the conditions, the
 * drift markers and their countdowns from the *previous* search kept feeding
 * it after a new incident was opened. A crew would open a fresh incident and
 * find a datum already computed, running off a set of numbers from a search
 * that had finished.
 *
 * With an incident open, the answer is that incident's records. Untagged ones
 * are included only while there is **no** incident — that is the LKP-first
 * case this app is built around, where the position is stamped before anyone
 * has opened anything, and `IncidentCard` adopts those records the moment one
 * is opened. Once an incident exists, an untagged record is by definition from
 * before it and has already had its chance to be adopted.
 *
 * Closing an incident therefore clears the worksheet, which is the intent: the
 * search is over, and the next one starts from nothing.
 */
export function recordsForSearch<
  T extends { team_id: string | null; incident_id: string | null },
>(records: T[], teamId: string | null, incidentId: string | null): T[] {
  return records.filter((r) => {
    const inScope = teamId ? r.team_id === teamId : r.team_id === null
    if (!inScope) return false
    return incidentId ? r.incident_id === incidentId : r.incident_id === null
  })
}
