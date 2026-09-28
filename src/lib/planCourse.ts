/**
 * "Plan a course" — the one way to set a start and a destination on the
 * chart plotter, as a small stepper (2026-09-28: "setting the start and end
 * points must be easier").
 *
 *   1. Starting point — choose on the map, enter coordinates, pick a saved
 *      waypoint, or use my current location (the start then keeps following
 *      the GPS: the route is re-planned from the boat at Start).
 *   2. Destination — map, coordinates or a saved waypoint.
 *   3. Create route — only once both are set.
 *
 * Pure: a reducer over plain data, so every step is unit-tested; the store
 * (`usePlanCourse`) holds it and the sheet and the map render it.
 */

export interface PlanPlace {
  lat: number
  lon: number
  label: string
}

/** How an end was (or is being) chosen. */
export type PickMethod = 'map' | 'coords' | 'waypoint' | 'here'

export type PlanStep = 'start' | 'dest' | 'review'

/** The start: my live position, or a fixed place. */
export type StartChoice = { kind: 'here' } | { kind: 'place'; place: PlanPlace; how: Exclude<PickMethod, 'here'> }

export interface PlanCourseState {
  open: boolean
  step: PlanStep
  start: StartChoice | null
  dest: { place: PlanPlace; how: Exclude<PickMethod, 'here'> } | null
  /** The way the end being set is being chosen right now; null = the menu of ways. */
  method: PickMethod | null
  /** A point tapped on the map, waiting for Confirm. */
  pending: { lat: number; lon: number } | null
  /** What is wrong, in plain words (no GPS fix yet, a bad coordinate). */
  error: string | null
}

export const CLOSED: PlanCourseState = {
  open: false,
  step: 'start',
  start: null,
  dest: null,
  method: null,
  pending: null,
  error: null,
}

export type PlanAction =
  | { type: 'open'; start?: StartChoice | null; dest?: PlanCourseState['dest'] }
  | { type: 'cancel' }
  | { type: 'method'; method: PickMethod | null }
  | { type: 'tap'; lat: number; lon: number }
  | { type: 'confirm-pick' }
  | { type: 'coords'; lat: number; lon: number }
  | { type: 'waypoint'; place: PlanPlace }
  | { type: 'here'; hasFix: boolean }
  | { type: 'change'; end: 'start' | 'dest' }
  | { type: 'back' }

function valid(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
}

/** The step after an end is set: the other end if it is still missing, else the review. */
function next(s: PlanCourseState): PlanStep {
  if (!s.start) return 'start'
  if (!s.dest) return 'dest'
  return 'review'
}

/** Set the end being chosen to `place`, then move on. */
function place(s: PlanCourseState, p: PlanPlace, how: Exclude<PickMethod, 'here'>): PlanCourseState {
  const out: PlanCourseState =
    s.step === 'start'
      ? { ...s, start: { kind: 'place', place: p, how } }
      : { ...s, dest: { place: p, how } }
  return { ...out, method: null, pending: null, error: null, step: next(out) }
}

export function planCourseReducer(s: PlanCourseState, a: PlanAction): PlanCourseState {
  switch (a.type) {
    case 'open': {
      const out: PlanCourseState = {
        ...CLOSED,
        open: true,
        start: a.start ?? null,
        dest: a.dest ?? null,
      }
      // Opened with nothing: starting point first. With both (a "Change"
      // from the plotter): the review, from which either can be changed.
      return { ...out, step: next(out) }
    }
    case 'cancel':
      return CLOSED
    case 'method':
      if (!s.open || s.step === 'review') return s
      if (a.method === 'here' && s.step !== 'start') return s
      return { ...s, method: a.method, pending: null, error: null }
    case 'tap':
      if (!s.open || s.method !== 'map') return s
      if (!valid(a.lat, a.lon)) return { ...s, error: 'That point is off the chart. Tap again.' }
      return { ...s, pending: { lat: a.lat, lon: a.lon }, error: null }
    case 'confirm-pick':
      if (!s.open || s.method !== 'map' || !s.pending) return s
      return place(
        s,
        { lat: s.pending.lat, lon: s.pending.lon, label: s.step === 'start' ? 'Start picked on chart' : 'Picked on chart' },
        'map',
      )
    case 'coords':
      if (!s.open || s.step === 'review') return s
      if (!valid(a.lat, a.lon)) return { ...s, error: 'Enter a position the chart can use.' }
      return place(s, { lat: a.lat, lon: a.lon, label: 'Typed position' }, 'coords')
    case 'waypoint':
      if (!s.open || s.step === 'review') return s
      if (!valid(a.place.lat, a.place.lon)) return { ...s, error: 'That waypoint has no usable position.' }
      return place(s, a.place, 'waypoint')
    case 'here': {
      if (!s.open || s.step !== 'start') return s
      if (!a.hasFix) {
        // Still chosen: the route is planned from the fix when it comes.
        // Said plainly, with the other ways still on offer.
        return {
          ...s,
          method: null,
          error: 'No GPS position yet — the route will start from your position once there is a fix. Or choose another way.',
          start: { kind: 'here' },
          step: next({ ...s, start: { kind: 'here' } }),
        }
      }
      const out: PlanCourseState = { ...s, start: { kind: 'here' }, method: null, pending: null, error: null }
      return { ...out, step: next(out) }
    }
    case 'change':
      if (!s.open) return s
      return { ...s, step: a.end, method: null, pending: null, error: null }
    case 'back':
      if (!s.open) return s
      if (s.method) return { ...s, method: null, pending: null, error: null }
      if (s.step === 'dest') return { ...s, step: 'start', error: null }
      if (s.step === 'review') return { ...s, step: 'dest', error: null }
      return s
  }
}

/** Both ends set — the only time "Create route" is offered. */
export function canCreate(s: PlanCourseState): boolean {
  return s.open && s.start != null && s.dest != null
}

/** What "Create route" hands the navigation store: the destination, and the origin (null = my live position). */
export function routeRequestOf(
  s: PlanCourseState,
): { dest: PlanPlace; origin: PlanPlace | null } | null {
  if (!s.start || !s.dest) return null
  return { dest: s.dest.place, origin: s.start.kind === 'here' ? null : s.start.place }
}

/** The chip for a chosen end: "My location" or the place's name. */
export function endLabel(end: StartChoice | PlanCourseState['dest'] | null): string | null {
  if (!end) return null
  if ('kind' in end) return end.kind === 'here' ? 'My location' : end.place.label
  return end.place.label
}
