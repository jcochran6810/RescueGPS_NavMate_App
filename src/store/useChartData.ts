import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  bandForSpan,
  ChartUnavailableError,
  boundsSpanNM,
  chartNeeds,
  containsBounds,
  fetchChartArea,
  padBounds,
  unionBounds,
  planChartRegions,
  regionsSatisfy,
  type ChartBounds,
  type LoadedRegion,
} from '@/lib/chart'
import { EMPTY_FEATURES, type ChartFeatures } from '@/lib/routing'
import type { LatLon } from '@/lib/search'
import { describeError } from '@/lib/retry'

/**
 * Charted depths and hazards for the area being planned in.
 *
 * Unlike every other store in this app, the features themselves are **not**
 * persisted. A working area of ENC polygons is comfortably past what
 * localStorage will hold, and this repo has deliberately not taken on
 * IndexedDB yet. Instead the raw HTTP responses are kept by the service
 * worker (a NetworkFirst rule on the `/api/enc` relay, see lib/encCache.ts),
 * so a second fetch of an area already visited is served from the device with
 * no link — which is the offline story that actually matters — and this store
 * only holds the parsed result for as long as the app is open.
 *
 * What IS persisted is the small index of which areas have been pulled down,
 * so the UI can tell a crew what they are carrying before they leave the dock.
 */

export interface SavedArea {
  bounds: ChartBounds
  band: string
  savedAt: string
  coverage: ChartFeatures['coverage']
}

export type ChartStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ChartLoadOptions {
  /**
   * Positions that need the finest charts round them — the start and the
   * destination of the passage. See `DETAIL_HALF_NM` in lib/chart.ts.
   */
  detailAround?: LatLon[]
  /** Fetch again even if what is loaded already satisfies the request. */
  force?: boolean
}

interface ChartDataState {
  features: ChartFeatures
  /** The whole box `features` was fetched for, or null when nothing is loaded. */
  bounds: ChartBounds | null
  /**
   * What `features` was read from, box by box and band by band: the whole
   * box first, then the detail boxes round the ends. Only bands that answered
   * are listed, so a band that failed is asked for again next time.
   */
  regions: LoadedRegion[]
  status: ChartStatus
  error: string | null
  saved: SavedArea[]

  /**
   * True when the loaded features already satisfy a request for this box —
   * every band its size calls for, over the whole box, and the detail bands
   * round each of `detailAround`. Containing the box is not enough: a
   * coastal-only load of a long passage does not cover a harbour hop inside
   * it.
   */
  covers: (b: ChartBounds, opts?: Pick<ChartLoadOptions, 'detailAround'>) => boolean
  /**
   * True when something already loaded was read over the whole of this box
   * (in whatever bands it was read). Looser than `covers`: it is what a
   * re-route asks — "can I plan here on what I am already carrying?" — when
   * the alternative is a download that may not come (no signal offshore).
   */
  holds: (b: ChartBounds) => boolean
  /**
   * Charted features for this box. Resolves with exactly what this request
   * asked for (never another request's box, never a stale empty set while
   * something else loads), or `EMPTY_FEATURES` when the chart could not be
   * read — in which case `status` is `'error'` and `error` says why.
   *
   * The second argument may still be a bare `force` boolean, as it was before
   * the options existed.
   */
  load: (b: ChartBounds, opts?: ChartLoadOptions | boolean) => Promise<ChartFeatures>
  clear: () => void
}

const MAX_SAVED = 20

/**
 * The load in progress, if any, and what it will have read when it finishes.
 *
 * Module state rather than store state: it holds a promise, which must not be
 * persisted, rendered or compared by a selector.
 */
interface Inflight {
  promise: Promise<ChartFeatures>
  planned: LoadedRegion[]
  /** When it started (Date.now()). */
  startedAt: number
  /** Given up on by a later request — it must not write back into the store. */
  abandoned: boolean
}
let inflight: Inflight | null = null

/**
 * A load running longer than this is not waited for by the next request, ms.
 *
 * Every query has its own time limit (`FETCH_TIMEOUT_MS` in lib/chart.ts), but
 * a load is many queries. On a link that stalls rather than fails, the old
 * rule — "wait for the load in flight, then decide" — held every later
 * re-route and every new destination behind one that might take minutes.
 */
export const STALE_LOAD_MS = 45_000

/**
 * Bumped by `clear()`. A load that started before a clear still answers the
 * caller that asked for it, but does not write its result back into a store
 * that has since been emptied on purpose.
 */
let generation = 0

function normalise(opts: ChartLoadOptions | boolean | undefined): ChartLoadOptions {
  if (typeof opts === 'boolean') return { force: opts }
  return opts ?? {}
}

/** What a request for `b` needs read, judged exactly as `load` would fetch it. */
function needsFor(b: ChartBounds, detailAround: LatLon[] | undefined): LoadedRegion[] {
  return chartNeeds(b, { detailAround, spanOf: padBounds(b) })
}

export const useChartData = create<ChartDataState>()(
  persist(
    (set, get) => ({
      features: EMPTY_FEATURES,
      bounds: null,
      regions: [],
      status: 'idle',
      error: null,
      saved: [],

      covers: (b, opts = {}) =>
        get().status === 'ready' &&
        regionsSatisfy(get().regions, needsFor(b, opts.detailAround)),

      holds: (b) =>
        get().status === 'ready' &&
        get().features.coverage !== 'none' &&
        get().regions.some((r) => r.bands.length > 0 && containsBounds(r.bounds, b)),

      load: async (b, rawOpts) => {
        const { detailAround, force = false } = normalise(rawOpts)
        const needs = needsFor(b, detailAround)

        // One load at a time. The old rule here was "if something is loading,
        // return whatever features are in the store", which handed a request
        // for one box the empty set — or the previous, different box — while
        // another box was being fetched, and the router planned on it.
        //
        // Now: if what is running will read everything this request needs,
        // share its answer; otherwise wait for it and then decide afresh,
        // because what it loaded may be enough after all. `force` never
        // shares — it asked for a fresh read — but still waits its turn.
        for (;;) {
          if (!force && get().covers(b, { detailAround })) return get().features
          const running = inflight
          if (!running) break
          if (Date.now() - running.startedAt > STALE_LOAD_MS) {
            // Hung. Let it go (it answers whoever asked for it, but writes
            // nothing back) and load afresh rather than queue behind it.
            running.abandoned = true
            inflight = null
            break
          }
          if (!force && regionsSatisfy(running.planned, needs)) return running.promise
          await running.promise
        }

        const bounds = padBounds(b)
        // Adding to what is loaded — the corridor round a route, a detail box
        // round a re-route's start — rather than reading the whole area again:
        // only the missing boxes are fetched, and what was there is kept.
        const prev = get()
        const base =
          !force &&
          prev.status === 'ready' &&
          prev.features.coverage !== 'none' &&
          prev.bounds != null &&
          containsBounds(prev.bounds, bounds)
            ? { features: prev.features, regions: prev.regions }
            : undefined
        const hadChart = prev.status === 'ready' && prev.features.coverage !== 'none'
        const planned: LoadedRegion[] = planChartRegions(bounds, { detailAround }).map((r) => ({
          bounds: r.bounds,
          bands: r.bands.map((band) => band.id),
        }))
        const startedIn = generation
        const entry: Inflight = {
          // Replaced on the next line; set first so `inflight` is never
          // missing while the load's own synchronous start runs.
          promise: Promise.resolve(EMPTY_FEATURES),
          planned,
          startedAt: Date.now(),
          abandoned: false,
        }
        inflight = entry
        set({ status: 'loading', error: null })

        entry.promise = (async (): Promise<ChartFeatures> => {
          try {
            // Every chart scale that covers the area, merged finest-first — a
            // single band left whole harbours with no chart at all — plus the
            // finest bands round each end. See `bandsForSpan` and
            // `DETAIL_HALF_NM` in lib/chart.ts.
            const { bands, regions, ...features } = await fetchChartArea(bounds, {
              detailAround,
              base,
            })
            if (generation !== startedIn || entry.abandoned) return features
            // Each box is labelled with the bands that were read over it AND
            // had something to say — not every band of the whole load, which
            // would claim harbour-scale charts for a whole coastal passage
            // when they were only read round its ends.
            const spoke = (r: LoadedRegion) => r.bands.filter((id) => bands.includes(id))
            const main = regions[0] ? spoke(regions[0]) : []
            const bandId = main.length ? main.join('+') : bandForSpan(boundsSpanNM(bounds)).id
            const savedAt = new Date().toISOString()
            // The whole area, then each detail box as an area of its own: it
            // is what the phone is now carrying at that scale.
            const entries: SavedArea[] = [
              { bounds, band: bandId, savedAt, coverage: features.coverage },
              ...regions
                .slice(1)
                .filter((r) => spoke(r).length > 0)
                .map((r) => ({
                  bounds: r.bounds,
                  band: spoke(r).join('+'),
                  savedAt,
                  coverage: features.coverage,
                })),
            ]
            set({
              features,
              bounds: base && prev.bounds ? unionBounds(prev.bounds, bounds) : bounds,
              regions,
              status: 'ready',
              error: null,
              // Newest first, dropping any area of the same band that one of
              // these now fully covers — keeping a box we have just
              // superseded would tell the crew they are carrying two areas
              // when they have one.
              saved: [
                ...entries,
                ...get().saved.filter(
                  (a) =>
                    !entries.some(
                      (e) => e.band === a.band && containsBounds(e.bounds, a.bounds),
                    ),
                ),
              ].slice(0, MAX_SAVED),
            })
            return features
          } catch (e) {
            // No chart is a planning limitation, not a crash: the planner
            // says it has nothing to plan on rather than guessing. The caller
            // gets the empty set and `error` says why.
            //
            // What was ALREADY loaded is kept. Wiping it here threw away the
            // chart a passage was being steered on the first time a download
            // failed — offshore, with no signal — so every later re-route
            // needed the network too. `covers()` still stays false for the box
            // that failed (its bands are not in `regions`), so the next
            // request for it tries again. Only with nothing loaded before is
            // the store left in 'error'.
            const error =
              e instanceof ChartUnavailableError
                ? `${e.message}. Tried ${e.service}`
                : describeError(e)
            if (generation === startedIn && !entry.abandoned) {
              if (hadChart) {
                set({ status: 'ready', error })
              } else {
                set({
                  features: EMPTY_FEATURES,
                  bounds: null,
                  regions: [],
                  status: 'error',
                  error,
                })
              }
            }
            return EMPTY_FEATURES
          } finally {
            if (inflight === entry) inflight = null
          }
        })()
        return entry.promise
      },

      clear: () => {
        generation++
        // A load still running for the cleared area is let go: it answers the
        // caller that started it, but a load started after the clear neither
        // waits for it nor shares its answer.
        inflight = null
        set({
          features: EMPTY_FEATURES,
          bounds: null,
          regions: [],
          status: 'idle',
          error: null,
        })
      },
    }),
    {
      name: 'navmate.chart.v1',
      storage: createJSONStorage(() => localStorage),
      // Only the index of saved areas. The features themselves live in the
      // service worker's cache — see the note at the top of this file.
      partialize: (s) => ({ saved: s.saved }),
    },
  ),
)
