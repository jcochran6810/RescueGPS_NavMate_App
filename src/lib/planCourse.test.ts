import { describe, it, expect } from 'vitest'
import { CLOSED, canCreate, endLabel, planCourseReducer as r, routeRequestOf, type PlanCourseState } from './planCourse'

/*
 * "Plan a course": starting point, destination, create route (2026-09-28).
 */

const HERE_OPEN = r(CLOSED, { type: 'open' })
const WP = { lat: 29.62, lon: -94.89, label: 'Three Bird Island' }

describe('Plan a course — the steps', () => {
  it('opens on the starting point, with nothing set and no Create route', () => {
    expect(HERE_OPEN).toMatchObject({ open: true, step: 'start', start: null, dest: null, method: null })
    expect(canCreate(HERE_OPEN)).toBe(false)
  })

  it('my current location → destination step; the start follows the GPS (origin null)', () => {
    const s = r(HERE_OPEN, { type: 'here', hasFix: true })
    expect(s.start).toEqual({ kind: 'here' })
    expect(s.step).toBe('dest')
    expect(endLabel(s.start)).toBe('My location')
    // "Use my current location" is not a way to set a destination.
    expect(r(s, { type: 'method', method: 'here' })).toBe(s)
  })

  it('no fix yet: says so, keeps "my location" (planned when the fix comes) and moves on', () => {
    const s = r(HERE_OPEN, { type: 'here', hasFix: false })
    expect(s.error).toMatch(/No GPS position yet/)
    expect(s.start).toEqual({ kind: 'here' })
    expect(s.step).toBe('dest')
  })

  it('choose on map: a tap shows a pending pin; only Confirm sets it', () => {
    let s = r(HERE_OPEN, { type: 'method', method: 'map' })
    s = r(s, { type: 'tap', lat: 29.7, lon: -95 })
    expect(s.pending).toEqual({ lat: 29.7, lon: -95 })
    expect(s.start).toBeNull()
    s = r(s, { type: 'tap', lat: 29.71, lon: -95.01 })
    expect(s.pending).toEqual({ lat: 29.71, lon: -95.01 })
    s = r(s, { type: 'confirm-pick' })
    expect(s.start).toMatchObject({ kind: 'place', how: 'map', place: { lat: 29.71, lon: -95.01 } })
    expect(s.step).toBe('dest')
    expect(s.method).toBeNull()
    // A tap when not picking does nothing.
    expect(r(s, { type: 'tap', lat: 1, lon: 1 })).toBe(s)
  })

  it('enter coordinates: validated', () => {
    let s = r(HERE_OPEN, { type: 'method', method: 'coords' })
    const bad = r(s, { type: 'coords', lat: 95, lon: 0 })
    expect(bad.error).toMatch(/position the chart can use/)
    expect(bad.start).toBeNull()
    s = r(s, { type: 'coords', lat: 29.698, lon: -94.9985 })
    expect(s.start).toMatchObject({ kind: 'place', how: 'coords' })
  })

  it('both set → review, Create route, and the request it makes', () => {
    let s = r(HERE_OPEN, { type: 'here', hasFix: true })
    s = r(s, { type: 'method', method: 'waypoint' })
    s = r(s, { type: 'waypoint', place: WP })
    expect(s.step).toBe('review')
    expect(canCreate(s)).toBe(true)
    expect(routeRequestOf(s)).toEqual({ dest: WP, origin: null })
    // With a fixed start, the origin is that place.
    const fixed = r(r(s, { type: 'change', end: 'start' }), { type: 'coords', lat: 29.7, lon: -95 })
    expect(fixed.step).toBe('review')
    expect(routeRequestOf(fixed)?.origin).toMatchObject({ lat: 29.7, lon: -95 })
  })

  it('"Change" one end keeps the other; Back walks back; Cancel loses nothing but the flow', () => {
    let s: PlanCourseState = r(HERE_OPEN, { type: 'here', hasFix: true })
    s = r(s, { type: 'waypoint', place: WP })
    s = r(s, { type: 'change', end: 'dest' })
    expect(s.step).toBe('dest')
    expect(s.start).toEqual({ kind: 'here' })
    expect(r(s, { type: 'back' }).step).toBe('start')
    expect(r(s, { type: 'cancel' })).toEqual(CLOSED)
  })

  it('opens pre-filled from the plotter (Change start / Change destination)', () => {
    const s = r(CLOSED, { type: 'open', start: { kind: 'here' }, dest: { place: WP, how: 'waypoint' } })
    expect(s.step).toBe('review')
    expect(r(s, { type: 'change', end: 'start' }).step).toBe('start')
  })
})
