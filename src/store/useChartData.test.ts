import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ChartArea, ChartBounds, EncBand, LoadedRegion } from '@/lib/chart'
import type { LatLon } from '@/lib/search'

/**
 * The chart service is replaced by a stub that answers from the real request
 * plan (`planChartRegions`), so what the store believes it loaded is exactly
 * what the real `fetchChartArea` would have told it. Each call can be held
 * open, to pin what happens to a request that arrives while another loads.
 */
const calls: {
  bounds: ChartBounds
  detailAround: readonly LatLon[] | undefined
  release: () => void
  fail: (e: unknown) => void
}[] = []
let autoRelease = true
/** Bands the stub pretends could not be read. */
let failing: string[] = []

vi.mock('@/lib/chart', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/chart')>()
  return {
    ...real,
    fetchChartArea: vi.fn(
      (
        bounds: ChartBounds,
        opts: { detailAround?: readonly LatLon[]; bands?: EncBand[] } = {},
      ): Promise<ChartArea> => {
        const plan = real.planChartRegions(bounds, opts)
        const regions: LoadedRegion[] = plan.map((r) => ({
          bounds: r.bounds,
          bands: r.bands.map((b) => b.id).filter((id) => !failing.includes(id)),
        }))
        const asked = [...new Set(plan.flatMap((r) => r.bands.map((b) => b.id)))]
        const failedBands = asked.filter((id) => failing.includes(id))
        const result: ChartArea = {
          depthAreas: [{ minDepthM: 5, rings: [], level: 3 }],
          channels: [],
          land: [],
          hazards: [],
          lines: [],
          coverage: failedBands.length ? 'partial' : 'full',
          failedBands,
          bands: asked.filter((id) => !failing.includes(id)),
          regions,
          // Which request this answer belongs to, so a test can tell answers apart.
          label: `${bounds.minLat.toFixed(4)},${bounds.minLon.toFixed(4)}`,
        } as ChartArea
        return new Promise<ChartArea>((resolve, reject) => {
          const call = {
            bounds,
            detailAround: opts.detailAround,
            release: () => resolve(result),
            fail: (e: unknown) => reject(e),
          }
          calls.push(call)
          if (autoRelease) call.release()
        })
      },
    ),
  }
})

// Imported after the mock so the store sees the stub.
const { useChartData } = await import('./useChartData')
const chart = await import('@/lib/chart')

/** About 55 NM corner to corner: too big for the harbour band as a whole. */
const LONG: ChartBounds = { minLat: 29.0, minLon: -95.2, maxLat: 29.6, maxLon: -94.4 }
const START = { lat: 29.3115, lon: -94.79 }
const END = { lat: 29.55, lon: -94.5 }

/** A harbour hop round a position — small enough that it needs the harbour band. */
function hopAt(p: LatLon, half = 0.01): ChartBounds {
  return { minLat: p.lat - half, minLon: p.lon - half, maxLat: p.lat + half, maxLon: p.lon + half }
}

const label = (f: unknown) => (f as { label?: string }).label

/** Let every pending promise callback run. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  calls.length = 0
  autoRelease = true
  failing = []
  useChartData.getState().clear()
  useChartData.setState({ saved: [] })
})

describe('useChartData.load', () => {
  it('asks for the padded box, with detail round the ends', async () => {
    await useChartData.getState().load(LONG, { detailAround: [START, END] })
    expect(calls).toHaveLength(1)
    expect(calls[0].bounds).toEqual(chart.padBounds(LONG))
    expect(calls[0].detailAround).toEqual([START, END])
    const s = useChartData.getState()
    expect(s.status).toBe('ready')
    expect(s.bounds).toEqual(chart.padBounds(LONG))
    // The whole box, then one detail box per end.
    expect(s.regions).toHaveLength(3)
    expect(s.regions[1].bands).toEqual(['harbour'])
  })

  it('hands the router the features, with failedBands, but not the bookkeeping', async () => {
    failing = ['harbour']
    const f = await useChartData.getState().load(LONG, { detailAround: [START] })
    expect(f.coverage).toBe('partial')
    expect(f.failedBands).toEqual(['harbour'])
    expect(f.lines).toEqual([])
    expect('regions' in f).toBe(false)
    expect('bands' in f).toBe(false)
  })

  it('still takes a bare `force` boolean as the second argument', async () => {
    await useChartData.getState().load(LONG)
    await useChartData.getState().load(LONG)
    expect(calls).toHaveLength(1)
    await useChartData.getState().load(LONG, true)
    expect(calls).toHaveLength(2)
  })
})

describe('useChartData.covers — no reuse of coarser data', () => {
  it('does not reuse a long passage load for a harbour hop away from its ends', async () => {
    // The bug: containment alone. A short route after a long one planned on
    // coastal-only data, which in Galveston marks almost all water 0 m.
    await useChartData.getState().load(LONG, { detailAround: [START, END] })
    const middle = { lat: 29.2, lon: -95.0 }
    expect(useChartData.getState().covers(hopAt(middle))).toBe(false)
    await useChartData.getState().load(hopAt(middle))
    expect(calls).toHaveLength(2)
  })

  it('reuses it for a hop inside the harbour detail box round an end', async () => {
    await useChartData.getState().load(LONG, { detailAround: [START, END] })
    expect(useChartData.getState().covers(hopAt(START))).toBe(true)
    await useChartData.getState().load(hopAt(START), { detailAround: [START] })
    expect(calls).toHaveLength(1)
  })

  it('does not reuse a load that lacks detail round a new end', async () => {
    await useChartData.getState().load(LONG, { detailAround: [START] })
    expect(useChartData.getState().covers(LONG, { detailAround: [START, END] })).toBe(false)
    expect(useChartData.getState().covers(LONG, { detailAround: [START] })).toBe(true)
  })

  it('asks again for a band that failed, rather than counting it as read', async () => {
    failing = ['harbour']
    await useChartData.getState().load(LONG, { detailAround: [START] })
    expect(useChartData.getState().covers(LONG, { detailAround: [START] })).toBe(false)
    failing = []
    await useChartData.getState().load(LONG, { detailAround: [START] })
    expect(calls).toHaveLength(2)
    expect(useChartData.getState().features.coverage).toBe('full')
  })

  it('is false while nothing is loaded, and after a failure', async () => {
    expect(useChartData.getState().covers(LONG)).toBe(false)
    autoRelease = false
    const p = useChartData.getState().load(LONG)
    calls[0].fail(new Error('Failed to fetch'))
    const f = await p
    expect(f.coverage).toBe('none')
    const s = useChartData.getState()
    expect(s.status).toBe('error')
    expect(s.error).toContain('Failed to fetch')
    expect(s.regions).toEqual([])
    expect(s.covers(LONG)).toBe(false)
  })
})

describe('useChartData.load — one load at a time', () => {
  it('shares the load in flight with a request it covers', async () => {
    autoRelease = false
    const a = useChartData.getState().load(LONG, { detailAround: [START, END] })
    const b = useChartData.getState().load(LONG, { detailAround: [START] })
    await settle()
    expect(calls).toHaveLength(1)
    calls[0].release()
    const [fa, fb] = await Promise.all([a, b])
    expect(fb).toBe(fa)
    expect(calls).toHaveLength(1)
  })

  it('never hands a different request the stale or empty features while loading', async () => {
    // The old rule: "if loading, return get().features" — an empty set, or
    // the previous box — and the router planned on it.
    autoRelease = false
    const first = useChartData.getState().load(LONG, { detailAround: [START] })
    const elsewhere = hopAt({ lat: 29.2, lon: -95.0 })
    let secondDone = false
    const second = useChartData.getState().load(elsewhere).then((f) => {
      secondDone = true
      return f
    })
    await settle()
    // The second waits: it has not answered, and has not started its own
    // fetch alongside the first.
    expect(secondDone).toBe(false)
    expect(calls).toHaveLength(1)

    calls[0].release()
    const f1 = await first
    await settle()
    // Now it loads its own box...
    expect(calls).toHaveLength(2)
    expect(calls[1].bounds).toEqual(chart.padBounds(elsewhere))
    calls[1].release()
    const f2 = await second
    // ...and answers with that, not with the first request's features.
    expect(label(f2)).not.toBe(label(f1))
    const p = chart.padBounds(elsewhere)
    expect(label(f2)).toBe(`${p.minLat.toFixed(4)},${p.minLon.toFixed(4)}`)
    expect(f2.depthAreas.length).toBeGreaterThan(0)
  })

  it('lets a waiting request reuse what the load in flight turned out to cover', async () => {
    autoRelease = false
    const first = useChartData.getState().load(LONG, { detailAround: [START, END] })
    // Needs the harbour band round START, which the first load is fetching —
    // shared directly, no second fetch.
    const second = useChartData.getState().load(hopAt(START), { detailAround: [START] })
    await settle()
    calls[0].release()
    await Promise.all([first, second])
    expect(calls).toHaveLength(1)
  })

  it('makes a forced load wait its turn, then fetch afresh', async () => {
    autoRelease = false
    const first = useChartData.getState().load(LONG)
    const forced = useChartData.getState().load(LONG, { force: true })
    await settle()
    expect(calls).toHaveLength(1)
    calls[0].release()
    await first
    await settle()
    expect(calls).toHaveLength(2)
    calls[1].release()
    await forced
  })

  it('queues several waiting requests without losing any', async () => {
    autoRelease = false
    const boxes = [
      hopAt({ lat: 29.1, lon: -95.1 }),
      hopAt({ lat: 29.2, lon: -95.0 }),
      hopAt({ lat: 29.3, lon: -94.9 }),
    ]
    const all = boxes.map((b) => useChartData.getState().load(b))
    for (let i = 0; i < boxes.length; i++) {
      await settle()
      expect(calls).toHaveLength(i + 1)
      calls[i].release()
    }
    const out = await Promise.all(all)
    out.forEach((f, i) => {
      const p = chart.padBounds(boxes[i])
      expect(label(f)).toBe(`${p.minLat.toFixed(4)},${p.minLon.toFixed(4)}`)
    })
  })
})

describe('useChartData.clear', () => {
  it('does not let a load that started before the clear fill the store after it', async () => {
    autoRelease = false
    const p = useChartData.getState().load(LONG)
    useChartData.getState().clear()
    calls[0].release()
    const f = await p
    // The caller that asked still gets its answer...
    expect(f.depthAreas.length).toBeGreaterThan(0)
    // ...but the emptied store stays empty.
    const s = useChartData.getState()
    expect(s.status).toBe('idle')
    expect(s.bounds).toBeNull()
    expect(s.regions).toEqual([])
  })

  it('lets a load after the clear start at once rather than waiting on the old one', async () => {
    autoRelease = false
    void useChartData.getState().load(LONG)
    useChartData.getState().clear()
    void useChartData.getState().load(LONG)
    await settle()
    expect(calls).toHaveLength(2)
    calls.forEach((c) => c.release())
  })
})

describe('useChartData.saved', () => {
  it('records the whole area and each detail box as areas carried', async () => {
    await useChartData.getState().load(LONG, { detailAround: [START, END] })
    const saved = useChartData.getState().saved
    expect(saved).toHaveLength(3)
    expect(saved[0].bounds).toEqual(chart.padBounds(LONG))
    // The harbour band was read only round the ends, so the whole area does
    // not claim it.
    expect(saved[0].band).not.toContain('harbour')
    expect(saved[0].band).toContain('coastal')
    expect(saved[1].band).toBe('harbour')
  })

  it('drops an older area of the same band that a new one covers', async () => {
    await useChartData.getState().load(LONG)
    await useChartData.getState().load(LONG, true)
    expect(useChartData.getState().saved).toHaveLength(1)
  })
})
