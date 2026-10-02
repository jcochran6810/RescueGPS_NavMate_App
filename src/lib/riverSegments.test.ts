import { describe, expect, it } from 'vitest'
import {
  buildIncidentLayer,
  liveSearchAreas,
  riverSegmentPatch,
  riverSegments,
  type SearchArea,
} from './command'

const ring = [
  { lat: 30, lng: -90 },
  { lat: 30.01, lng: -90 },
  { lat: 30.01, lng: -89.99 },
  { lat: 30, lng: -90 },
]
const area = (over: Partial<SearchArea>): SearchArea => ({
  id: 'a',
  incident_id: 'i',
  name: 'R1 · 0.00–0.50 mi down',
  area_type: 'primary',
  polygon: null,
  coordinates: ring,
  status: 'pending',
  priority: 1,
  ...over,
})

describe('river segments from command (NW4)', () => {
  it('lists only live narrow-water segments, upstream first', () => {
    const list = riverSegments([
      area({ id: 'r2', segment_number: 2, along_start_m: 805, along_end_m: 1609, source: 'narrow_water' }),
      area({ id: 'rm1', segment_number: -1, along_start_m: -805, along_end_m: 0, source: 'narrow_water' }),
      area({ id: 'old', segment_number: 1, along_start_m: 0, source: 'narrow_water', deleted_at: '2026-10-02T00:00:00Z' }),
      area({ id: 'drawn', source: null }),
    ])
    expect(list.map((a) => a.id)).toEqual(['rm1', 'r2'])
  })

  it('a crew mark is status, who and when — nothing else', () => {
    expect(riverSegmentPatch('in_progress', 'u', 't')).toEqual({ status: 'in_progress' })
    expect(riverSegmentPatch('negative', 'u', 't')).toEqual({ status: 'negative', searched_at: 't', searched_by: 'u' })
    expect(riverSegmentPatch('completed', null, 't')).toEqual({ status: 'completed', searched_at: 't' })
  })

  it('the map leaves out a re-cut segment and labels the status', () => {
    const layer = buildIncidentLayer({
      assignments: [],
      areas: [
        area({ id: 'x', source: 'narrow_water', segment_number: 1, status: 'negative' }),
        area({ id: 'y', deleted_at: '2026-10-02T00:00:00Z' }),
      ],
      hazards: [],
      lkp: null,
      userId: null,
      unitId: null,
      nowMs: 0,
    })
    expect(layer.areas).toHaveLength(1)
    expect(layer.areas[0].label).toBe('R1 · 0.00–0.50 mi down · Negative')
    expect(liveSearchAreas([area({ deleted_at: 'x' })])).toEqual([])
  })
})
