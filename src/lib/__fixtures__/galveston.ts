import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ChartFeatures, Ring } from '../routing'

/*
 * The trimmed Galveston ENC fixture (galveston-enc.json) as chart features —
 * shared by every test that needs the real chart. See routing.test.ts
 * ("Real chart data — Galveston") for what it is and where it came from.
 */

interface Fixture {
  origin: [number, number]
  scale: number
  depth: [number, number, number[][]][]
  land: [number, number[][]][]
  channels: [string, number[][]][]
}

export function loadGalveston(): ChartFeatures {
  const path = fileURLToPath(new URL('./galveston-enc.json', import.meta.url))
  const fx = JSON.parse(readFileSync(path, 'utf8')) as Fixture
  const ring = (d: number[]): Ring => {
    const out: Ring = []
    let x = 0
    let y = 0
    for (let i = 0; i < d.length; i += 2) {
      x += d[i]
      y += d[i + 1]
      out.push([fx.origin[0] + x / fx.scale, fx.origin[1] + y / fx.scale])
    }
    out.push(out[0])
    return out
  }
  return {
    depthAreas: fx.depth.map(([level, minDepthM, rings]) => ({ level, minDepthM, rings: rings.map(ring) })),
    land: fx.land.map(([level, rings]) => ({ level, rings: rings.map(ring) })),
    channels: fx.channels.map(([k, rings]) => ({
      kind: k === 'd' ? ('dredged' as const) : ('fairway' as const),
      rings: rings.map(ring),
    })),
    hazards: [],
    lines: [],
    coverage: 'full',
  }
}
