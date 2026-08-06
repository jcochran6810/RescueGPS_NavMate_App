import { describe, it, expect } from 'vitest'
import {
  newIncidentNumber,
  incidentHandoff,
  INCIDENT_TYPES,
  CLOSE_STATUSES,
} from './incident'
import type { Incident, SarRecord } from './types'

const INCIDENT: Incident = {
  id: 'a0000000-0000-4000-8000-000000000001',
  client_id: 'a0000000-0000-4000-8000-000000000001',
  team_id: null,
  incident_number: 'INC-260806-ABCDE',
  incident_type: 'piw',
  incident_name: 'Test PIW',
  urgency_level: 'high',
  status: 'active',
  lkp_lat: 29.5,
  lkp_lng: -94.8,
  lkp_time: '2026-08-06T12:00:00.000Z',
  lkp_source: 'field_gps',
  incident_time: '2026-08-06T12:00:00.000Z',
  summary: '',
  created_by: 'u1',
  created_at: '2026-08-06T12:05:00.000Z',
  updated_at: '2026-08-06T12:05:00.000Z',
}

function record(over: Partial<SarRecord>): SarRecord {
  return {
    id: crypto.randomUUID(),
    client_id: crypto.randomUUID(),
    user_id: 'u1',
    team_id: null,
    incident_id: INCIDENT.id,
    kind: 'clue',
    lat: null,
    lon: null,
    recorded_at: '2026-08-06T13:00:00.000Z',
    payload: { clue_type: 'debris' },
    note: '',
    created_at: '2026-08-06T13:00:00.000Z',
    updated_at: '2026-08-06T13:00:00.000Z',
    ...over,
  }
}

describe('newIncidentNumber', () => {
  it('is the RescueGPS field format with a five-character tail', () => {
    const n = newIncidentNumber(new Date('2026-08-06T12:00:00Z'))
    expect(n).toMatch(/^INC-\d{6}-[2-9A-HJKMNP-Z]{5}$/)
  })

  it('is deterministic from the incident uuid, so retries agree', () => {
    const d = new Date('2026-08-06T12:00:00Z')
    const seed = 'a0000000-0000-4000-8000-000000000001'
    expect(newIncidentNumber(d, seed)).toBe(newIncidentNumber(d, seed))
  })
})

describe('incidentHandoff', () => {
  it('emits the RescueGPS table shapes: lng not lon, their exact columns', () => {
    const records: SarRecord[] = [
      record({
        kind: 'lkp',
        lat: 29.5,
        lon: -94.8,
        recorded_at: '2026-08-06T12:00:00.000Z',
        payload: { source: 'gps', object_type: 'person_in_water', position_error_nm: 0.1 },
      }),
      record({
        kind: 'drift_marker',
        lat: 29.5,
        lon: -94.8,
        payload: {
          marker_type: 'orange',
          deploy: { lat: 29.5, lon: -94.8, time: '2026-08-06T12:10:00.000Z' },
          retrieve: { lat: 29.51, lon: -94.79, time: '2026-08-06T13:10:00.000Z' },
          set_deg: 41,
          drift_kts: 1.2,
          distance_nm: 1.2,
          hours: 1,
        },
      }),
      record({ kind: 'clue', lat: 29.52, lon: -94.78, note: 'life jacket' }),
      record({
        kind: 'environment',
        payload: {
          wind_from_deg: 180,
          wind_kts: 12,
          current_toward_deg: 45,
          current_kts: 1.5,
          water_temp_c: 21,
        },
      }),
    ]
    const out = JSON.parse(incidentHandoff({ incident: INCIDENT, records }))

    expect(out.format).toBe('rescuegps-navmate/incident-handoff')
    expect(out.incident).toMatchObject({
      incident_number: 'INC-260806-ABCDE',
      incident_type: 'piw',
      lkp_lat: 29.5,
      lkp_lng: -94.8,
      lkp_source: 'field_gps',
    })
    expect(out.incident).not.toHaveProperty('lkp_lon')

    // lkp_history rows in their column names.
    expect(out.lkp_history).toHaveLength(1)
    expect(out.lkp_history[0]).toMatchObject({ lat: 29.5, lng: -94.8, source: 'gps' })

    // field_drift_data: the measured drift card, km + knots as they store it.
    expect(out.field_drift_data).toHaveLength(1)
    expect(out.field_drift_data[0]).toMatchObject({
      marker_type: 'orange',
      deploy_lat: 29.5,
      deploy_lng: -94.8,
      retrieve_lat: 29.51,
      bearing: 41,
      speed_knots: 1.2,
    })
    expect(out.field_drift_data[0].distance_km).toBeCloseTo(1.2 * 1.852, 3)

    // Clues as field_events.
    expect(out.field_events[0]).toMatchObject({
      event_type: 'clue_found',
      severity: 'info',
      description: 'debris: life jacket',
      lat: 29.52,
      lng: -94.78,
    })

    // The drift engine parameter object, canonical leeway_type.
    expect(out.simulate_drift_params).toMatchObject({
      lat: 29.5,
      lng: -94.8,
      wind_speed_kts: 12,
      wind_direction_deg: 180,
      current_speed_kts: 1.5,
      current_direction_deg: 45,
      leeway_type: 'person_in_water',
    })
  })

  it('ignores records from other incidents and unretrieved markers', () => {
    const records: SarRecord[] = [
      record({ incident_id: 'other' }),
      record({
        kind: 'drift_marker',
        payload: {
          marker_type: 'dye',
          deploy: { lat: 29.5, lon: -94.8, time: '2026-08-06T12:10:00.000Z' },
        },
      }),
    ]
    const out = JSON.parse(incidentHandoff({ incident: INCIDENT, records }))
    expect(out.field_events).toHaveLength(0)
    expect(out.field_drift_data).toHaveLength(0)
  })

  it('maps an old-key object type to its canonical code', () => {
    const records: SarRecord[] = [
      record({
        kind: 'lkp',
        lat: 29.5,
        lon: -94.8,
        payload: { source: 'witness', object_type: 'kayak', position_error_nm: 1 },
      }),
    ]
    const out = JSON.parse(incidentHandoff({ incident: INCIDENT, records }))
    expect(out.simulate_drift_params.leeway_type).toBe('kayak_sea')
  })
})

describe('choice lists', () => {
  it('incident types are all valid against the RescueGPS CHECK constraint', () => {
    const allowed = new Set([
      'piw', 'kayak', 'jetski', 'swimmer', 'diver', 'missing_vessel',
      'capsized_vessel', 'debris_field', 'life_raft', 'found_watercraft',
      'vessel_overdue', 'vessel_in_distress', 'missing_person', 'medical',
      'fire', 'hazmat', 'other', 'missing_person_piw', 'debris_found',
      'medical_emergency', 'missing_person_land', 'mass_rescue',
    ])
    for (const t of INCIDENT_TYPES) expect(allowed.has(t.value)).toBe(true)
    for (const s of CLOSE_STATUSES) {
      expect([
        'found_alive', 'found_deceased', 'not_found', 'false_alarm', 'cancelled',
      ]).toContain(s.value)
    }
  })
})
