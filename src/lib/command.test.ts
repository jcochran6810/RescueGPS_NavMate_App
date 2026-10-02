import { describe, it, expect } from 'vitest'
import {
  parsePolygon,
  parseCoordinateList,
  canMoveTo,
  isMine,
  sortAssignments,
  messageAudience,
  inbox,
  replyFields,
  pendingEmergency,
  activeHazards,
  latestLkp,
  commandLkp,
  messageRecipient,
  applyTrackRow,
  buildIncidentLayer,
  assignmentLabel,
  type FieldAssignment,
  type FieldMessage,
  type IncidentHazard,
  type UnitPosition,
} from './command'

const SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [-94.8, 29.5],
      [-94.7, 29.5],
      [-94.7, 29.6],
      [-94.8, 29.6],
      [-94.8, 29.5],
    ],
  ],
}

function assignment(over: Partial<FieldAssignment> = {}): FieldAssignment {
  return {
    id: 'a1',
    incident_id: 'inc',
    asset_id: null,
    assigned_user_id: null,
    created_by: 'ic',
    title: 'Segment A',
    instructions: null,
    segment_geom: SQUARE,
    pattern_type: 'parallel_track',
    track_spacing_m: 200,
    target_speed_kts: 6,
    priority: 'normal',
    status: 'assigned',
    created_at: '2026-09-24T10:00:00+00:00',
    updated_at: '2026-09-24T10:00:00+00:00',
    ...over,
  }
}

function message(over: Partial<FieldMessage> = {}): FieldMessage {
  return {
    id: 'm1',
    client_id: null,
    incident_id: 'inc',
    sender_id: 'ic',
    recipient_id: null,
    recipient_asset_id: null,
    body: 'hello',
    priority: 'normal',
    thread_id: null,
    in_reply_to: null,
    delivered_at: null,
    read_at: null,
    created_at: '2026-09-24T10:00:00+00:00',
    ...over,
  }
}

function hazard(over: Partial<IncidentHazard> = {}): IncidentHazard {
  return {
    id: 'h1',
    incident_id: 'inc',
    reported_by: 'u1',
    hazard_type: 'debris',
    severity: 'high',
    label: null,
    description: null,
    lat: 29.5,
    lng: -94.8,
    radius_m: 50,
    geom_geojson: null,
    active: true,
    expires_at: null,
    created_at: '2026-09-24T10:00:00+00:00',
    ...over,
  }
}

describe('parsePolygon', () => {
  it('reads a GeoJSON polygon as lat/lon, dropping the closing point', () => {
    const ring = parsePolygon(SQUARE)!
    expect(ring).toHaveLength(4)
    // GeoJSON is [lng, lat]; the swap is the whole risk.
    expect(ring[0]).toEqual({ lat: 29.5, lon: -94.8 })
  })

  it('reads GeoJSON handed over as a string, a Feature, or a MultiPolygon', () => {
    expect(parsePolygon(JSON.stringify(SQUARE))).toHaveLength(4)
    expect(parsePolygon({ type: 'Feature', geometry: SQUARE })).toHaveLength(4)
    expect(
      parsePolygon({ type: 'MultiPolygon', coordinates: [SQUARE.coordinates] }),
    ).toHaveLength(4)
  })

  /*
   * The vectors below are what the live database (PostGIS, project
   * ekhvfypxuxskjglwwoqh) returned for `to_json(<geography>)` — which is what
   * PostgREST and Realtime send for `search_areas.polygon` and
   * `field_assignments.segment_geom`. A geography column has no JSON cast, so
   * it never arrives as GeoJSON.
   */
  const POLY_GEOG =
    '0103000020E610000001000000050000009A99999999B957C00000000000803D403333333333B357C00000000000803D403333333333B357C09A99999999993D409A99999999B957C09A99999999993D409A99999999B957C00000000000803D40'

  it('reads a geography polygon as PostgREST sends it (EWKB hex), lat and lon the right way round', () => {
    const ring = parsePolygon(POLY_GEOG)!
    expect(ring).toHaveLength(4)
    expect(ring[0].lat).toBeCloseTo(29.5, 9)
    expect(ring[0].lon).toBeCloseTo(-94.9, 9)
    expect(ring[2].lat).toBeCloseTo(29.6, 9)
    expect(ring[2].lon).toBeCloseTo(-94.8, 9)
    // Lower case, as some clients re-encode it.
    expect(parsePolygon(POLY_GEOG.toLowerCase())).toHaveLength(4)
  })

  it('reads a multipolygon (first polygon), a Z polygon, big-endian WKB, and keeps only the outer ring', () => {
    const multi = parsePolygon(
      '0106000020E610000002000000010300000001000000040000009A99999999B957C00000000000803D403333333333B357C00000000000803D403333333333B357C09A99999999993D409A99999999B957C00000000000803D40010300000001000000040000000000000000C057C00000000000003D40CDCCCCCCCCBC57C00000000000003D40CDCCCCCCCCBC57C0CDCCCCCCCC0C3D400000000000C057C00000000000003D40',
    )!
    expect(multi).toHaveLength(3)
    expect(multi[0].lon).toBeCloseTo(-94.9, 9)
    const z = parsePolygon(
      '01030000A0E610000001000000040000009A99999999B957C00000000000803D40000000000000F03F3333333333B357C00000000000803D40000000000000F03F3333333333B357C09A99999999993D40000000000000F03F9A99999999B957C00000000000803D40000000000000F03F',
    )!
    expect(z).toHaveLength(3)
    expect(z[1].lat).toBeCloseTo(29.5, 9)
    expect(z[1].lon).toBeCloseTo(-94.8, 9)
    const xdr = parsePolygon(
      '0020000003000010e60000000100000004c057b9999999999a403d800000000000c057b33333333333403d800000000000c057b33333333333403d99999999999ac057b9999999999a403d800000000000',
    )!
    expect(xdr).toHaveLength(3)
    expect(xdr[2].lat).toBeCloseTo(29.6, 9)
    const holed = parsePolygon(
      '0103000020E610000002000000040000009A99999999B957C00000000000803D403333333333B357C00000000000803D403333333333B357C09A99999999993D409A99999999B957C00000000000803D4004000000B81E85EB51B857C085EB51B81E853D406666666666B657C085EB51B81E853D406666666666B657C0CDCCCCCCCC8C3D40B81E85EB51B857C085EB51B81E853D40',
    )!
    expect(holed).toHaveLength(3)
    expect(Math.min(...holed.map((p) => p.lat))).toBeCloseTo(29.5, 9)
  })

  it('leaves a truncated or non-polygon EWKB undrawn rather than crashing or guessing', () => {
    expect(parsePolygon('0103000020E6100000010000000500000000')).toBeNull()
    expect(parsePolygon(POLY_GEOG.slice(0, -16))).toBeNull()
    // A point is not an area.
    expect(parsePolygon('0101000020E61000009A99999999B957C00000000000803D40')).toBeNull()
    expect(parsePolygon('not hex at all')).toBeNull()
    expect(parsePolygon('{not json')).toBeNull()
    expect(parsePolygon(null)).toBeNull()
    expect(parsePolygon(42)).toBeNull()
  })

  it('refuses an out-of-range point and a degenerate ring', () => {
    expect(
      parsePolygon({ type: 'Polygon', coordinates: [[[0, 95], [1, 1], [2, 2], [0, 95]]] }),
    ).toBeNull()
    expect(
      parsePolygon({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] }),
    ).toBeNull()
  })
})

describe('parseCoordinateList', () => {
  it('accepts named points in lng or lon', () => {
    const ring = parseCoordinateList([
      { lat: 29.5, lng: -94.8 },
      { lat: 29.5, lon: -94.7 },
      { lat: 29.6, lng: -94.7 },
    ])
    expect(ring).toEqual([
      { lat: 29.5, lon: -94.8 },
      { lat: 29.5, lon: -94.7 },
      { lat: 29.6, lon: -94.7 },
    ])
  })

  it('refuses bare pairs, whose axis order nothing states', () => {
    expect(parseCoordinateList([[29.5, -94.8], [29.5, -94.7], [29.6, -94.7]])).toBeNull()
  })
})

describe('assignment status', () => {
  it('allows only the three field steps, never out of complete or cancelled', () => {
    expect(canMoveTo('assigned', 'en_route')).toBe(true)
    expect(canMoveTo('en_route', 'searching')).toBe(true)
    expect(canMoveTo('searching', 'complete')).toBe(true)
    expect(canMoveTo('searching', 'searching')).toBe(false)
    expect(canMoveTo('complete', 'searching')).toBe(false)
    expect(canMoveTo('cancelled', 'en_route')).toBe(false)
    expect(canMoveTo('assigned', 'cancelled')).toBe(false)
    expect(canMoveTo('en_route', 'assigned')).toBe(false)
  })

  it('is mine when tasked to me or to my unit', () => {
    expect(isMine(assignment({ assigned_user_id: 'u1' }), 'u1', null)).toBe(true)
    expect(isMine(assignment({ asset_id: 'unit1' }), 'u1', 'unit1')).toBe(true)
    expect(isMine(assignment({ asset_id: 'unit2' }), 'u1', 'unit1')).toBe(false)
    // No unit known yet must not match a null asset_id.
    expect(isMine(assignment(), 'u1', null)).toBe(false)
  })

  it('sorts mine first, then by priority, and drops cancelled', () => {
    const list = [
      assignment({ id: 'other-urgent', priority: 'urgent' }),
      assignment({ id: 'mine-low', priority: 'low', assigned_user_id: 'u1' }),
      assignment({ id: 'cancelled', status: 'cancelled', assigned_user_id: 'u1' }),
      assignment({ id: 'mine-high', priority: 'high', asset_id: 'unit1' }),
    ]
    expect(sortAssignments(list, 'u1', 'unit1').map((a) => a.id)).toEqual([
      'mine-high',
      'mine-low',
      'other-urgent',
    ])
  })

  it('labels a segment with how to search it', () => {
    expect(assignmentLabel(assignment())).toBe('Segment A · parallel track · S 200 m · 6 kn')
    expect(
      assignmentLabel(
        assignment({ title: null, pattern_type: null, track_spacing_m: null, target_speed_kts: null }),
      ),
    ).toBe('Assignment')
  })
})

describe('messages', () => {
  it('knows who a message was for', () => {
    expect(messageAudience(message(), 'u1', 'unit1')).toBe('all')
    expect(messageAudience(message({ recipient_id: 'u1' }), 'u1', 'unit1')).toBe('me')
    expect(messageAudience(message({ recipient_asset_id: 'unit1' }), 'u1', 'unit1')).toBe('unit')
    expect(messageAudience(message({ recipient_id: 'u2' }), 'u1', 'unit1')).toBeNull()
    expect(messageAudience(message({ recipient_asset_id: 'unit9' }), 'u1', null)).toBeNull()
  })

  it('keeps the inbox to this crew and what they sent, newest first', () => {
    const list = [
      message({ id: 'old', created_at: '2026-09-24T09:00:00+00:00' }),
      message({ id: 'other', recipient_id: 'u2' }),
      message({ id: 'mine', sender_id: 'u1', created_at: '2026-09-24T11:00:00Z' }),
      message({ id: 'unit', recipient_asset_id: 'unit1', created_at: '2026-09-24T10:30:00Z' }),
    ]
    expect(inbox(list, 'u1', 'unit1').map((m) => m.id)).toEqual(['mine', 'unit', 'old'])
  })

  it('replies in the thread of the message answered', () => {
    expect(replyFields(message({ id: 'm1' }))).toEqual({ in_reply_to: 'm1', thread_id: 'm1' })
    expect(replyFields(message({ id: 'm2', thread_id: 't' }))).toEqual({
      in_reply_to: 'm2',
      thread_id: 't',
    })
  })

  it('raises the oldest unread emergency addressed to this crew', () => {
    const list = [
      message({ id: 'e2', priority: 'emergency', created_at: '2026-09-24T10:05:00Z' }),
      message({ id: 'e1', priority: 'emergency', created_at: '2026-09-24T10:01:00Z' }),
      message({ id: 'read', priority: 'emergency', read_at: '2026-09-24T10:00:00Z' }),
      message({ id: 'mine', priority: 'emergency', sender_id: 'u1' }),
      message({ id: 'notus', priority: 'emergency', recipient_id: 'u2' }),
    ]
    expect(pendingEmergency(list, 'u1', null)?.id).toBe('e1')
    expect(pendingEmergency([list[2], list[3], list[4]], 'u1', null)).toBeNull()
  })
})

describe('hazards', () => {
  it('keeps active, unexpired hazards with a position', () => {
    const now = Date.parse('2026-09-24T12:00:00Z')
    const list = [
      hazard({ id: 'ok' }),
      hazard({ id: 'inactive', active: false }),
      hazard({ id: 'expired', expires_at: '2026-09-24T11:59:00Z' }),
      hazard({ id: 'future', expires_at: '2026-09-24T13:00:00+00:00' }),
      hazard({ id: 'nopos', lat: null }),
    ]
    expect(activeHazards(list, now).map((h) => h.id)).toEqual(['ok', 'future'])
  })
})

describe('latestLkp', () => {
  it('takes the newest non-deleted row and reads lng as lon', () => {
    const lkp = latestLkp([
      { incident_id: 'inc', lat: 29.5, lng: -94.8, time: '2026-09-24T10:00:00Z', source: 'a', confidence: null },
      { incident_id: 'inc', lat: 29.6, lng: -94.7, time: '2026-09-24T11:00:00+00:00', source: 'b', confidence: null },
      {
        incident_id: 'inc', lat: 29.9, lng: -94.9, time: '2026-09-24T12:00:00Z',
        source: 'deleted', confidence: null, deleted_at: '2026-09-24T12:01:00Z',
      },
    ])
    expect(lkp).toEqual({ lat: 29.6, lon: -94.7, time: '2026-09-24T11:00:00+00:00', source: 'b' })
    expect(latestLkp([])).toBeNull()
  })
})

describe('applyTrackRow', () => {
  const unit = (over: Partial<UnitPosition> = {}): UnitPosition => ({
    user_id: 'u2',
    lat: 29.5,
    lng: -94.8,
    heading_deg: null,
    speed_mps: null,
    accuracy_m: null,
    recorded_at: '2026-09-24T10:00:00+00:00',
    ...over,
  })

  it('moves a known unit to a newer position', () => {
    const next = applyTrackRow([unit()], unit({ lat: 29.6, recorded_at: '2026-09-24T10:00:15Z' }))
    expect(next?.[0].lat).toBe(29.6)
  })

  it('ignores a late upload older than what is shown (recorded_at decides)', () => {
    const units = [unit({ recorded_at: '2026-09-24T10:05:00Z' })]
    expect(applyTrackRow(units, unit({ lat: 1, recorded_at: '2026-09-24T10:01:00Z' }))).toBe(units)
  })

  it('asks for a refresh when the unit is new (null)', () => {
    expect(applyTrackRow([unit()], unit({ user_id: 'u3' }))).toBeNull()
  })
})

describe('buildIncidentLayer', () => {
  it('draws readable shapes, marks mine, skips what cannot be drawn', () => {
    const layer = buildIncidentLayer({
      assignments: [
        assignment({ id: 'mine', assigned_user_id: 'u1' }),
        assignment({ id: 'hex', segment_geom: '0103000020E610' }),
        assignment({ id: 'other' }),
      ],
      areas: [
        {
          id: 's1', incident_id: 'inc', name: 'Area 1', area_type: null,
          polygon: SQUARE, coordinates: null, status: null, priority: null,
        },
      ],
      hazards: [hazard(), hazard({ id: 'gone', active: false })],
      lkp: { lat: 29.55, lon: -94.75, time: '2026-09-24T10:00:00Z' },
      userId: 'u1',
      unitId: null,
      nowMs: Date.parse('2026-09-24T12:00:00Z'),
    })
    expect(layer.areas.map((a) => a.id)).toEqual([
      'area:s1',
      'assignment:mine',
      'assignment:other',
    ])
    expect(layer.areas.find((a) => a.id === 'assignment:mine')?.mine).toBe(true)
    expect(layer.hazards.map((h) => h.id)).toEqual(['h1'])
    expect(layer.hazards[0]).toMatchObject({ lat: 29.5, lon: -94.8, radiusM: 50, label: 'Debris' })
    expect(layer.lkp).toMatchObject({ lat: 29.55, lon: -94.75 })
  })
})

describe('commandLkp — the LKP command is working to', () => {
  const history = [
    { incident_id: 'inc', lat: 29.4, lng: -94.7, time: '2026-10-02T09:00:00Z', source: 'navmate', confidence: null },
  ]

  it('is the incident row\'s LKP — what the IC moves — not the field LKP echoed back', () => {
    // Live 2026-10-02: every lkp_history row on the database is NavMate's own
    // fan-out; the command app moves incidents.lkp_lat/lng. Numeric columns
    // may arrive as text.
    const lkp = commandLkp(
      { lkp_lat: '29.5584800', lkp_lng: '-94.9544590', lkp_time: '2026-10-01T21:00:00Z', lkp_source: 'map_pick' },
      history,
    )
    expect(lkp).toMatchObject({ lat: 29.55848, lon: -94.954459, source: 'map_pick' })
  })

  it('falls back to the history only when the incident has no LKP', () => {
    expect(commandLkp({ lkp_lat: null, lkp_lng: null, lkp_time: null, lkp_source: null }, history)).toMatchObject({
      lat: 29.4,
      lon: -94.7,
    })
    expect(commandLkp(null, [])).toBeNull()
    // An impossible row is not an LKP.
    expect(commandLkp({ lkp_lat: 95, lkp_lng: 10, lkp_time: null, lkp_source: null }, [])).toBeNull()
  })
})

describe('messageRecipient — who a field message is for', () => {
  it('a reply goes back to its sender', () => {
    expect(messageRecipient({ replyTo: { sender_id: 'ic-2' }, to: 'everyone', icId: 'ic-1', userId: 'me' })).toBe('ic-2')
  })

  it('to command is to the incident commander, which is what raises their unread badge', () => {
    expect(messageRecipient({ replyTo: null, to: 'command', icId: 'ic-1', userId: 'me' })).toBe('ic-1')
  })

  it('to everyone, no IC known yet, or the sender is the IC: the whole incident', () => {
    expect(messageRecipient({ replyTo: null, to: 'everyone', icId: 'ic-1', userId: 'me' })).toBeNull()
    expect(messageRecipient({ replyTo: null, to: 'command', icId: null, userId: 'me' })).toBeNull()
    expect(messageRecipient({ replyTo: null, to: 'command', icId: 'me', userId: 'me' })).toBeNull()
  })
})
