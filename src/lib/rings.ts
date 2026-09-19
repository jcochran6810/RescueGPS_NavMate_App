import { NM_TO_METERS } from './geo'
import type { DistanceUnit } from './units'
import { distanceIn, DISTANCE_SUFFIX, FEET_TO_M } from './units'

/**
 * Range rings: how far away things are, read straight off the screen.
 *
 * A scale bar answers "how long is this line"; a crew on a compass bearing is
 * asking the other question — "how far is that". Rings answer it without
 * measuring anything, which is the whole point of drawing them.
 *
 * Two rules decide the spacing, and both exist because a ring a crew has to
 * do arithmetic on is worse than no ring:
 *
 * **The steps are numbers people say out loud** — a quarter, a half, one, two
 * — in the unit the crew has chosen, rather than whatever fell out of the
 * zoom level. "Half a mile" is a distance; "0.37 NM" is a calculation.
 *
 * **There are never more than three.** Rings are drawn over a chart somebody
 * is trying to read, and a screen of concentric circles hides the thing they
 * were looking at. Three is enough to interpolate between.
 */

/**
 * How small a ring may be and still be a ring.
 *
 * The doc comment above says a ring a crew cannot see is not a ring, and this
 * is what makes that true: zoomed far enough out, every step fits — as a
 * circle a fraction of a pixel across, drawn on top of the boat. The test for
 * "draws nothing rather than inventing a spacing" is what found this; the
 * first version only refused when the rings were too *large*, which is the
 * easier half of the problem and not the one that happens in practice.
 */
const MIN_RING_PX = 16

/**
 * The ladder of spacings, shortest first.
 *
 * It starts in **feet or metres** and only then moves to the crew's big unit,
 * for the reason the browser found: a compass map is usually zoomed in close,
 * and the smallest whole-unit step — a twentieth of a nautical mile, 93 m —
 * needs 278 m of screen for three rings. At compass zoom there is room for
 * about 140. So the first version drew no rings at all on the one screen they
 * were asked for.
 *
 * Feet for the crews who read NM and miles, metres for the ones who read
 * kilometres: at a hundred yards nobody says "0.05 nautical miles", and the
 * whole point of a ring is that its label is something you would say.
 */
function ladder(unit: DistanceUnit): { meters: number; value: number; suffix: string }[] {
  if (unit === 'km') {
    const m = [25, 50, 100, 250, 500].map((v) => ({ meters: v, value: v, suffix: 'm' }))
    const km = [1, 2, 5, 10, 25, 50, 100, 250, 500].map((v) => ({
      meters: v * 1000,
      value: v,
      suffix: 'km',
    }))
    return [...m, ...km]
  }
  const ft = [50, 100, 250, 500, 1000].map((v) => ({
    meters: v * FEET_TO_M,
    value: v,
    suffix: 'ft',
  }))
  const big = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500].map((v) => ({
    meters: v * unitInMeters(unit),
    value: v,
    suffix: DISTANCE_SUFFIX[unit],
  }))
  return [...ft, ...big]
}

/** Metres in one of whatever the crew reads distances in. */
export function unitInMeters(unit: DistanceUnit): number {
  if (unit === 'km') return 1000
  if (unit === 'mi') return 1609.344
  return NM_TO_METERS
}

export interface RangeRing {
  /** Radius in metres — what the map draws with. */
  meters: number
  /** Radius on screen, in pixels. */
  px: number
  /** What to write on it: "500 ft", "0.5 NM". */
  label: string
}

/**
 * How many graduations a ruler may carry before it stops being readable.
 *
 * The scale runs to the edge of the screen, so the question is no longer "do
 * three fit" but "how finely can it be divided and still be read at arm's
 * length on a moving boat". Six is the ceiling; past that the labels start
 * touching.
 */
const MAX_MARKS = 6

/**
 * The graduations of a ruler `lengthPx` long, from the boat outwards.
 *
 * The **finest** spacing off the ladder that still yields a readable number of
 * marks — not the coarsest that fits three, which is what this did when the
 * scale was three rings and the screen edge was not the limit. A ruler to the
 * edge of the screen divided into three is a ruler nobody can interpolate on.
 *
 * Returns nothing when nothing fits, or when the first graduation would be too
 * small to see — the same refusal the rest of this app makes about a number it
 * cannot stand behind.
 */
export function pickRings(
  metersPerPx: number,
  lengthPx: number,
  unit: DistanceUnit,
  maxMarks = MAX_MARKS,
): RangeRing[] {
  if (!(metersPerPx > 0) || !(lengthPx > 0) || maxMarks < 1) return []

  const fits = (stepMeters: number) => Math.floor(lengthPx / (stepMeters / metersPerPx))

  const step = ladder(unit).find(
    (s) =>
      s.meters / metersPerPx >= MIN_RING_PX &&
      fits(s.meters) >= 1 &&
      fits(s.meters) <= maxMarks,
  )
  // Nothing fine enough is readable and nothing coarse enough divides it: fall
  // back to the coarsest that fits at all, so a scale still appears.
  const chosen =
    step ??
    [...ladder(unit)]
      .reverse()
      .find((s) => s.meters / metersPerPx >= MIN_RING_PX && fits(s.meters) >= 1)
  if (!chosen) return []

  const marks = Math.min(maxMarks, Math.max(1, fits(chosen.meters)))
  const rings: RangeRing[] = []
  for (let i = 1; i <= marks; i++) {
    const meters = chosen.meters * i
    rings.push({
      meters,
      px: meters / metersPerPx,
      label: `${trim(chosen.value * i)} ${chosen.suffix}`,
    })
  }
  return rings
}

/**
 * How far a ruler from `(cx, cy)` can run at `screenDeg` before it leaves a
 * `w` × `h` box.
 *
 * The scale is meant to reach the edge of the screen — a ruler that stops
 * two-thirds of the way up is a ruler that cannot measure the thing at the
 * top of it. `margin` keeps the arrow head and the last label inside.
 */
export function rulerLengthPx(
  cx: number,
  cy: number,
  w: number,
  h: number,
  screenDeg: number,
  margin = 18,
): number {
  const rad = (screenDeg * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  let t = Math.max(w, h) * 2
  if (dx > 1e-9) t = Math.min(t, (w - margin - cx) / dx)
  if (dx < -1e-9) t = Math.min(t, (margin - cx) / dx)
  if (dy > 1e-9) t = Math.min(t, (h - margin - cy) / dy)
  if (dy < -1e-9) t = Math.min(t, (margin - cy) / dy)
  return Math.max(0, t)
}

/** 0.50 → "0.5", 2.00 → "2". A trailing zero on a ring label is noise. */
function trim(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * Where a distance along the forward line lands on screen, in degrees
 * clockwise from straight up.
 *
 * With the map turned to the heading this is always zero — forward is up the
 * screen, which is the entire reason a crew asks for a heading-up map. It is
 * kept as a function because the rings are also drawn on a north-up map,
 * where forward is wherever the boat happens to be pointing.
 */
export function forwardScreenDeg(
  forwardDeg: number | null | undefined,
  rotationDeg: number,
): number | null {
  if (forwardDeg == null || !Number.isFinite(forwardDeg)) return null
  return (((forwardDeg - rotationDeg) % 360) + 360) % 360
}

/** Where to put a label at `px` along that line, as an x/y offset. */
export function alongForward(
  screenDeg: number,
  px: number,
): { dx: number; dy: number } {
  const rad = (screenDeg * Math.PI) / 180
  // Screen y grows downward, so "up the screen" is a negative dy.
  return { dx: Math.sin(rad) * px, dy: -Math.cos(rad) * px }
}

/** A distance in metres, written the way the rings are written. */
export function ringLabel(meters: number, unit: DistanceUnit): string {
  const nm = meters / NM_TO_METERS
  return `${trim(distanceIn(nm, unit))} ${DISTANCE_SUFFIX[unit]}`
}
