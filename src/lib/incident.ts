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
import { canonicalObjectKey } from './sar'
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
  { value: 'jetski', label: 'Jet ski missing / overdue' },
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

export function incidentTypeLabel(value: string): string {
  return INCIDENT_TYPES.find((t) => t.value === value)?.label ?? value
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
  const startTime = incident.incident_time ?? lkpTime
  const hoursAdrift = startTime
    ? Math.max(0, (Date.now() - new Date(startTime).getTime()) / 3_600_000)
    : null

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
        summary: incident.summary,
      },
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
