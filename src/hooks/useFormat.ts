import { useMemo } from 'react'
import { useUnits } from '@/store/useUnits'
import {
  formatAltitude,
  formatDepth,
  formatDepthBoth,
  formatKnots,
  formatLength,
  formatSpeedIn,
  formatTemp,
  type DepthUnit,
  type DistanceUnit,
  type SpeedUnit,
  type TempUnit,
} from '@/lib/units'

/**
 * The crew's own units, already bound.
 *
 * Every screen used to name its unit at the call site — `formatDistance(nm,
 * 'nm')`, a `.toFixed(1)` and a hardcoded "kn", a conversion to feet written
 * out inline — which is why there was no way to change them: the choice was
 * spread across thirty-odd places, in four different spellings.
 *
 * A hook rather than a set of plain functions because the units are a store
 * and a screen has to re-render when they change. The functions underneath
 * stay pure and tested; this only carries the setting to them.
 */
export interface Formatters {
  /** A distance held in nautical miles. */
  length: (nm: number) => string
  /** A depth or draft held in metres. */
  depth: (metres: number | null) => string
  /** The same, with metres in brackets — for setting a boat up. */
  depthBoth: (metres: number | null) => string
  /** A speed held in metres per second, as the receiver reports it. */
  speed: (mps: number | null | undefined) => string
  /** A speed already in knots, as most of the SAR maths holds it. */
  knots: (kn: number | null | undefined) => string
  /** A temperature held in Celsius, as the record stores it. */
  temp: (celsius: number | null) => string
  /** A height held in metres. */
  altitude: (metres: number | null | undefined) => string
  /** The raw settings, for a label or an input's suffix. */
  units: {
    distance: DistanceUnit
    depth: DepthUnit
    speed: SpeedUnit
    temp: TempUnit
  }
}

export function useFormat(): Formatters {
  const distance = useUnits((s) => s.distance)
  const depth = useUnits((s) => s.depth)
  const speed = useUnits((s) => s.speed)
  const temp = useUnits((s) => s.temp)
  const altitude = useUnits((s) => s.altitude)

  return useMemo(
    () => ({
      length: (nm: number) => formatLength(nm, distance),
      depth: (m: number | null) => formatDepth(m, depth),
      depthBoth: (m: number | null) => formatDepthBoth(m, depth),
      speed: (mps: number | null | undefined) => formatSpeedIn(mps, speed),
      knots: (kn: number | null | undefined) => formatKnots(kn, speed),
      temp: (c: number | null) => formatTemp(c, temp),
      altitude: (m: number | null | undefined) => formatAltitude(m, altitude),
      units: { distance, depth, speed, temp },
    }),
    [distance, depth, speed, temp, altitude],
  )
}
