import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ChartFeatures, LineHazard, PointHazard, Ring } from '../routing'

/*
 * The trimmed upper-Galveston-Bay ENC fixture (upper-bay-enc.json) as chart
 * features: the Houston Ship Channel from Morgan's Point past Atkinson Island,
 * Five Mile Cut Channel and Three Bird Island — the passage of the
 * "shortest route" report (2026-09-28).
 *
 * What NOAA's ENC Direct returned on 2026-09-28 through the live /api/enc
 * relay: the harbour band (level 5; the approach band has no chart here) and
 * the coastal band (level 3, which draws the whole upper bay as one 0–1.8 m
 * depth area), replayed through the app's own `fetchChartArea` parsing,
 * clipped to the box, simplified to ~1.5 m and quantised to 1e-5°.
 *
 * `dropCell: 'US5HOUCH'` leaves out the 109 harbour-band depth areas of ENC
 * cell US5HOUCH (29°33'–29°37.5'N, 94°52.5'–94°57'W, Five Mile Cut's cell),
 * which is what the crew's phone was planning on when it sent them 17.7 NM
 * round by the South Boat Cut instead of 9.8 NM through Five Mile Cut.
 */

interface Fixture {
  origin: [number, number]
  scale: number
  depth: [number, number, number[][], number][]
  land: [number, number, number[][]][]
  channels: [string, number[][], string?][]
  hazards: [PointHazard['kind'], number, number, number][]
  lines: [LineHazard['kind'], number, number, number[]][]
}

let cached: Fixture | null = null

function read(): Fixture {
  if (!cached) {
    const path = fileURLToPath(new URL('./upper-bay-enc.json', import.meta.url))
    cached = JSON.parse(readFileSync(path, 'utf8')) as Fixture
  }
  return cached
}

export function loadUpperBay(opts: { dropCell?: 'US5HOUCH' } = {}): ChartFeatures {
  const fx = read()
  const decode = (d: number[], closed: boolean): Ring => {
    const out: Ring = []
    let x = 0
    let y = 0
    for (let i = 0; i < d.length; i += 2) {
      x += d[i]
      y += d[i + 1]
      out.push([fx.origin[0] + x / fx.scale, fx.origin[1] + y / fx.scale])
    }
    if (closed) out.push(out[0])
    return out
  }
  return {
    depthAreas: fx.depth
      .filter(([, , , cell]) => !(opts.dropCell === 'US5HOUCH' && cell === 1))
      .map(([level, minDepthM, rings]) => ({ level, minDepthM, rings: rings.map((r) => decode(r, true)) })),
    land: fx.land.map(([level, hazard, rings]) => ({
      level,
      ...(hazard ? { hazard: true } : {}),
      rings: rings.map((r) => decode(r, true)),
    })),
    channels: fx.channels.map(([k, rings, name]) => ({
      kind: k === 'd' ? ('dredged' as const) : ('fairway' as const),
      rings: rings.map((r) => decode(r, true)),
      ...(name ? { name } : {}),
    })),
    hazards: fx.hazards.map(([kind, radiusM, x, y]) => ({
      kind,
      radiusM,
      lat: fx.origin[1] + y / fx.scale,
      lon: fx.origin[0] + x / fx.scale,
      label: kind,
    })),
    lines: fx.lines.map(([kind, widthM, level, path]) => ({
      kind,
      widthM,
      level,
      label: kind === 'structure' ? 'jetty, pier or breakwater' : 'obstruction',
      paths: [decode(path, false)],
    })),
    coverage: 'full',
  }
}

/** The screenshot's passage: a start in the Houston Ship Channel off Morgan's Point, and the destination by Three Bird Island. */
export const UPPER_BAY_FROM = { lat: 29.698, lon: -94.9985 }
export const UPPER_BAY_TO = { lat: 29.634, lon: -94.8866 }
