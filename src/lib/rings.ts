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
 * Up to three rings that fit inside `maxRadiusPx`.
 *
 * The largest spacing whose outermost ring still fits, so the rings use the
 * space there is. Returns nothing at all when nothing fits, or when the
 * innermost would be too small to see — the same refusal the rest of this app
 * makes about a number it cannot stand behind.
 */
export function pickRings(
  metersPerPx: number,
  maxRadiusPx: number,
  unit: DistanceUnit,
  count = 3,
): RangeRing[] {
  if (!(metersPerPx > 0) || !(maxRadiusPx > 0) || count < 1) return []

  const step = [...ladder(unit)]
    .reverse()
    .find((s) => (s.meters * count) / metersPerPx <= maxRadiusPx)
  if (!step) return []
  // The innermost ring is the one at risk of vanishing, so it is the one
  // checked.
  if (step.meters / metersPerPx < MIN_RING_PX) return []

  const rings: RangeRing[] = []
  for (let i = 1; i <= count; i++) {
    const meters = step.meters * i
    rings.push({
      meters,
      px: meters / metersPerPx,
      label: `${trim(step.value * i)} ${step.suffix}`,
    })
  }
  return rings
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
