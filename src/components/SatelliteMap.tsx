import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { Fix } from '@/lib/types'
import {
  HYBRID_BLEND,
  LABELS,
  NOAA_CHART,
  SATELLITE,
  SEAMARKS,
  TILE_SIZE,
  latToTileY,
  lonToTileX,
  metersPerPixel,
  pickScaleBar,
  sharedZoomRange,
  tileXToLon,
  tileYToLat,
  tilesForView,
  zoomForSpan,
  type TileSource,
} from '@/lib/tiles'
import type { PathMarker } from '@/components/TrackPath'
import { formatPosition } from '@/lib/coords'
import { bearingDeg, compassPoint, formatDistance, haversineNM } from '@/lib/geo'
import { useCoordFormat } from '@/store/useCoordFormat'
import { useMapAction } from '@/store/useMapAction'
import { toast } from '@/store/useToast'

const MIN_ZOOM = 3
const MAX_ZOOM = 19
const DEFAULT_ZOOM = 16
/** What the offline-save button says it is about to pull down. */
const SAVE_NOUN: Record<MapBase, string> = {
  satellite: 'imagery',
  chart: 'chart',
  hybrid: 'chart and imagery',
}
/** Movement under this is a tap, not a pan. */
const TAP_SLOP_PX = 6
/** And a tap held longer than this is a press, not a pick. */
const TAP_MS = 500
/** How wide the press menu is allowed to be, so it can be kept on screen. */
const MENU_W = 216

/**
 * A satellite map with the track drawn on it.
 *
 * The imagery is the thing a crew asks for first and the thing that fails
 * first, so the two are kept apart: tiles are one layer, and the track,
 * waypoints, accuracy circle and scale bar are another, drawn from the fixes
 * themselves. When the imagery does not arrive — no signal, a captive portal,
 * a corner of the world Esri has not flown — the overlay is still exactly
 * right, and the map says the imagery is missing rather than quietly showing
 * the crew a blank ocean.
 */
/**
 * What the map draws underneath everything else.
 *
 * `hybrid` is not a third source — it is the imagery with the chart blended
 * over it at half strength, so a crew can read a depth contour and see the
 * bank it belongs to in the same glance.
 */
export type MapBase = 'satellite' | 'chart' | 'hybrid'

export function SatelliteMap({
  trail,
  fix,
  markers = [],
  units = [],
  route = [],
  routeUnverified = false,
  labels = false,
  base = 'satellite',
  seamarks = false,
  onPick,
  pickHint,
  longPress = 'full',
  height = 320,
  className = '',
}: {
  trail: Fix[]
  fix: Fix | null
  markers?: PathMarker[]
  /**
   * The other boats on this search — where they are, which way they are
   * pointing and how fast. Drawn differently from a waypoint on purpose: a
   * waypoint is a place, a unit is somebody, and confusing the two on a
   * screen is how two boats search the same water.
   */
  units?: {
    id: string
    name: string
    lat: number
    lon: number
    heading: number | null
    speedKn: number | null
    stale: boolean
  }[]
  /** A planned line to steer — a search pattern — drawn dashed, under the
   *  track, with a square at each turn point. Drawn from the coordinates
   *  like everything else, so it is exact even when imagery is not. */
  route?: { lat: number; lon: number }[]
  /**
   * The line is a fallback, not a plotted course — nothing about it has been
   * checked against the chart. Drawn so it cannot be mistaken for one: a
   * straight line through land in the same amber dash as a real route is the
   * most dangerous thing this screen can show.
   */
  routeUnverified?: boolean
  /** Draw place names and boundaries over the imagery. */
  labels?: boolean
  /** Which base layer to draw: aerial imagery, or the NOAA chart. */
  base?: MapBase
  /** Draw OpenSeaMap buoys and lights over the base. */
  seamarks?: boolean
  /**
   * Called with the position under a tap. Set it and the map becomes a picker
   * as well as a display — the crew points at where they want to go.
   */
  onPick?: (p: { lat: number; lon: number }) => void
  /** One line shown over the map while it is pickable. */
  pickHint?: string
  /**
   * What a press and hold offers.
   *
   * `full` is every map in the app: the position under the finger, and the two
   * things a crew does with a place they have just spotted — keep it, or go to
   * it. `pick` is for a map that is already inside a picker, where "save a
   * waypoint" would open a second sheet on top of the one being filled in;
   * there the press offers the pick itself and the readout. `off` is for a map
   * that is decoration.
   */
  longPress?: 'full' | 'pick' | 'off'
  height?: number
  className?: string
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: height })
  /**
   * Where the map is looking, as one piece of state rather than three.
   *
   * Two reasons it is not a centre and a zoom held separately. A gesture that
   * moves and zooms at once cannot then land half-applied; and every gesture
   * can be written as a functional update, which is what stops a fast drag
   * from computing its next step out of a centre React has not re-rendered
   * yet. `manual` false means the map is following the crew, wherever they
   * are, and `lat`/`lon` are not being used.
   */
  const [view, setView] = useState({
    lat: 0,
    lon: 0,
    zoom: DEFAULT_ZOOM,
    manual: false,
  })
  const [imagery, setImagery] = useState<'idle' | 'ok' | 'partial' | 'failed'>(
    'idle',
  )
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(
    null,
  )
  const [online, setOnline] = useState(() => navigator.onLine)
  /**
   * The map filling the screen.
   *
   * Deliberately not the Fullscreen API. iOS Safari does not implement
   * `requestFullscreen` on anything but a video, which is most of the phones
   * this app runs on, and a control that silently does nothing on the target
   * platform is worse than no control. A fixed overlay works everywhere and
   * keeps this the same React element, so the view, the tiles already fetched
   * and a press menu left open all survive the change.
   */
  const [expanded, setExpanded] = useState(false)
  /** An open press menu: where it was pressed, and the place underneath. */
  const [menu, setMenu] = useState<
    { x: number; y: number; lat: number; lon: number } | null
  >(null)
  const coordFormat = useCoordFormat((s) => s.format)
  const askMapAction = useMapAction((s) => s.ask)

  const loaded = useRef(0)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  /**
   * Escape leaves, in this order: the press menu first, then full screen.
   * One key doing two jobs is fine as long as it never does both at once —
   * dismissing the menu and the whole map on one press would look like the
   * map closed itself.
   */
  useEffect(() => {
    if (!expanded && !menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (menu) setMenu(null)
      else setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, menu])

  // The page behind must not scroll under a map that covers it.
  useEffect(() => {
    if (!expanded) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [expanded])

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // With neither a fix nor a track, a planned route still gives the map a
  // place to be — a crew plans the pattern before they start running it.
  const anchor: { lat: number; lon: number } | null =
    fix ?? trail[trail.length - 1] ?? route[0] ?? null
  // Read inside the state updaters, which run after this render rather than
  // during it, so they need the current anchor and not the one they closed
  // over.
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor

  const following = !view.manual && anchor !== null
  /** Until there is a fix or a pan, the map has nowhere to be. */
  const placed = view.manual || anchor !== null
  const zoom = view.zoom
  const center =
    following && anchor
      ? { lat: anchor.lat, lon: anchor.lon }
      : { lat: view.lat, lon: view.lon }

  const { w, h } = size
  const mpp = metersPerPixel(center.lat, zoom)

  /** Geographic position to a pixel inside the map box. */
  const project = useCallback(
    (lat: number, lon: number) => ({
      x: (lonToTileX(lon, zoom) - lonToTileX(center.lon, zoom)) * TILE_SIZE + w / 2,
      y: (latToTileY(lat, zoom) - latToTileY(center.lat, zoom)) * TILE_SIZE + h / 2,
    }),
    [zoom, center.lat, center.lon, w, h],
  )

  /**
   * A pixel inside the map box back to a geographic position — the exact
   * inverse of `project`, and what turns a tap into a destination.
   */
  const unproject = useCallback(
    (px: number, py: number) => ({
      lat: tileYToLat(latToTileY(center.lat, zoom) + (py - h / 2) / TILE_SIZE, zoom),
      lon: tileXToLon(lonToTileX(center.lon, zoom) + (px - w / 2) / TILE_SIZE, zoom),
    }),
    [zoom, center.lat, center.lon, w, h],
  )

  /**
   * Read by the press timer, which fires half a second after the render it was
   * armed in. A press cannot have panned the map — that cancels it — but the
   * map may have moved under a stationary finger while following the boat, and
   * the place the crew pressed is the place on the ground, not the pixel.
   */
  const unprojectRef = useRef(unproject)
  unprojectRef.current = unproject

  /* ---------------------------------------------------------------- gestures
   * One finger pans, two pinch, the wheel zooms. All of it moves the same two
   * pieces of state — where the middle of the map is and how far in it is —
   * so there is no gesture that can leave the view somewhere the buttons
   * cannot get it back from.
   */

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)
  /**
   * Where and when a single pointer went down, so a tap can be told from a
   * drag. The box takes pointer capture and is `touch-none`, so no click event
   * ever arrives and the discrimination has to be made here.
   */
  const tap = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(
    null,
  )
  /** The press-and-hold timer, armed on the way down and cancelled by a pan. */
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelHold = useCallback(() => {
    if (hold.current) {
      clearTimeout(hold.current)
      hold.current = null
    }
  }, [])

  // A press timer outliving its map would fire a menu onto a screen that has
  // moved on.
  useEffect(() => cancelHold, [cancelHold])

  /** Where the map is looking right now, following the crew or not. */
  const from = useCallback(
    (v: { lat: number; lon: number; zoom: number; manual: boolean }) => {
      const a = anchorRef.current
      return v.manual || !a
        ? { lat: v.lat, lon: v.lon }
        : { lat: a.lat, lon: a.lon }
    },
    [],
  )

  const panBy = useCallback(
    (dx: number, dy: number) => {
      setView((v) => {
        const c = from(v)
        return {
          lat: tileYToLat(latToTileY(c.lat, v.zoom) - dy / TILE_SIZE, v.zoom),
          lon: tileXToLon(lonToTileX(c.lon, v.zoom) - dx / TILE_SIZE, v.zoom),
          zoom: v.zoom,
          manual: true,
        }
      })
    },
    [from],
  )

  /**
   * Zoom, holding one point of the ground still under the finger.
   *
   * While the map is following the crew it stays centred on them instead —
   * pinching towards a corner and losing your own position off the edge is
   * not what anyone means by zooming in.
   */
  const zoomAround = useCallback(
    (next: (z: number) => number, px: number, py: number) => {
      setView((v) => {
        const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next(v.zoom)))
        if (z === v.zoom) return v
        if (!v.manual && anchorRef.current) return { ...v, zoom: z }
        const c = from(v)
        const lon = tileXToLon(
          lonToTileX(c.lon, v.zoom) + (px - w / 2) / TILE_SIZE,
          v.zoom,
        )
        const lat = tileYToLat(
          latToTileY(c.lat, v.zoom) + (py - h / 2) / TILE_SIZE,
          v.zoom,
        )
        return {
          lat: tileYToLat(latToTileY(lat, z) - (py - h / 2) / TILE_SIZE, z),
          lon: tileXToLon(lonToTileX(lon, z) - (px - w / 2) / TILE_SIZE, z),
          zoom: z,
          manual: true,
        }
      })
    },
    [from, w, h],
  )

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    // Registered by hand because React's wheel listener is passive, and a map
    // that zooms *and* scrolls the page under it is unusable.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAround(
        (z) => z - Math.sign(e.deltaY) * 0.5,
        e.clientX - r.left,
        e.clientY - r.top,
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAround])

  const onPointerDown = (e: ReactPointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    tap.current =
      pointers.current.size === 1
        ? { x: e.clientX, y: e.clientY, t: Date.now(), moved: false }
        : null
    cancelHold()
    setMenu(null)
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom }
      return
    }
    if (longPress === 'off' || pointers.current.size !== 1) return
    // Armed on the way down and cancelled by a pan, a second finger or a
    // release — so the only way to reach it is to hold still, which is what a
    // press is. The same TAP_MS that has always stopped a long hold counting
    // as a pick: one threshold, so there is no gap between the two where a
    // gesture does nothing at all.
    const { clientX, clientY } = e
    hold.current = setTimeout(() => {
      hold.current = null
      const r = boxRef.current?.getBoundingClientRect()
      if (!r) return
      const x = clientX - r.left
      const y = clientY - r.top
      const at = unprojectRef.current(x, y)
      // A press that produced a menu must not also pan when the finger lifts.
      tap.current = null
      // Phones that can, say so — the press has no other feedback until the
      // menu paints, and a crew in gloves needs to know the phone heard it.
      navigator.vibrate?.(8)
      setMenu({ x, y, lat: at.lat, lon: at.lon })
    }, TAP_MS)
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (tap.current) {
      // A finger on a boat is never perfectly still: a few pixels of slop is
      // a tap, more than that is the start of a pan.
      const slop = Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y)
      if (slop > TAP_SLOP_PX) {
        tap.current.moved = true
        cancelHold()
      }
    }

    if (pointers.current.size >= 2) cancelHold()

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinch.current.dist > 0) {
        const r = boxRef.current?.getBoundingClientRect()
        const start = pinch.current
        // Measured from where the fingers started, not from the last frame,
        // so a slow pinch does not accumulate rounding into a drift.
        zoomAround(
          () => start.zoom + Math.log2(dist / start.dist),
          (a.x + b.x) / 2 - (r?.left ?? 0),
          (a.y + b.y) / 2 - (r?.top ?? 0),
        )
      }
      return
    }
    panBy(e.clientX - prev.x, e.clientY - prev.y)
  }

  const endPointer = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId)
    cancelHold()
    if (pointers.current.size < 2) pinch.current = null
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const t = tap.current
    tap.current = null
    endPointer(e)
    if (!onPick || !t || t.moved || Date.now() - t.t > TAP_MS) return
    const r = boxRef.current?.getBoundingClientRect()
    if (!r) return
    onPick(unproject(e.clientX - r.left, e.clientY - r.top))
  }

  /* ------------------------------------------------------------------ tiles */

  /**
   * The base layers, bottom first. Two of them in the hybrid view — the
   * imagery carries the ground, the chart carries the soundings — and the
   * chart's tiles are transparent PNGs, so blending them is a matter of
   * drawing one over the other rather than of compositing anything.
   */
  const baseSources = useMemo<TileSource[]>(() => {
    if (base === 'hybrid') return [SATELLITE, NOAA_CHART]
    return [base === 'chart' ? NOAA_CHART : SATELLITE]
  }, [base])
  const baseLabel = base === 'hybrid' ? 'Hybrid chart and satellite' : baseSources[0].label
  /**
   * The overlays currently drawn. Kept as a list so `saveArea` fills the cache
   * with exactly what is on screen rather than assuming imagery.
   */
  const overlaySources = useMemo(() => {
    const out: TileSource[] = []
    if (labels) out.push(LABELS)
    if (seamarks) out.push(SEAMARKS)
    return out
  }, [labels, seamarks])

  // Clamped to the levels *every* base layer publishes, so the hybrid view
  // cannot zoom to where only one of its two halves exists.
  const baseZoom = useMemo(() => sharedZoomRange(baseSources), [baseSources])
  const z = Math.max(baseZoom.min, Math.min(baseZoom.max, Math.round(zoom)))
  /** Between integer zooms the whole tile layer is scaled rather than refetched. */
  const scale = 2 ** (zoom - z)
  const layerW = w / scale
  const layerH = h / scale

  // Nothing is fetched until there is a position or a pan. A map that opens
  // on zoom 16 of the middle of the Atlantic costs a crew six tiles of
  // cellular data to be told nothing.
  const tiles = useMemo(
    () =>
      w > 0 && h > 0 && placed
        ? tilesForView({ lat: center.lat, lon: center.lon }, z, layerW, layerH)
        : [],
    [center.lat, center.lon, z, layerW, layerH, w, h, placed],
  )

  const noteLoaded = () => {
    loaded.current++
    setImagery((s) => (s === 'ok' ? s : 'ok'))
  }
  const noteFailed = () => {
    setImagery(loaded.current > 0 ? 'partial' : 'failed')
  }

  // A tile that did not arrive is hidden rather than left as a broken-image
  // glyph. The browser draws one per missing tile, and a map covered in them
  // reads as a fault in the app rather than a gap in the imagery — which the
  // banner says plainly, once.
  const show = (e: { currentTarget: HTMLImageElement }) => {
    e.currentTarget.style.visibility = 'visible'
  }
  const hide = (e: { currentTarget: HTMLImageElement }) => {
    e.currentTarget.style.visibility = 'hidden'
  }

  /**
   * One tile layer. Each source is clamped to its own zoom range: the chart
   * stops at 18 and the seamarks at 18 too, and asking either for a level it
   * does not publish returns nothing but a screen of failed requests.
   */
  const layer = (src: TileSource, opacity = 1) => {
    if (z < src.minZoom || z > src.maxZoom) return null
    return (
    <div
      key={src.id}
      className="pointer-events-none absolute top-1/2 left-1/2"
      style={{
        width: layerW,
        height: layerH,
        marginLeft: -layerW / 2,
        marginTop: -layerH / 2,
        transform: `scale(${scale})`,
        transformOrigin: '50% 50%',
        opacity,
      }}
    >
      {tiles.map((t) => (
        <img
          key={`${src.id}:${t.key}`}
          src={src.url(t.z, t.x, t.y)}
          alt=""
          aria-hidden
          draggable={false}
          crossOrigin={src.crossOrigin ? 'anonymous' : undefined}
          decoding="async"
          onLoad={(e) => {
            show(e)
            if (!src.overlay) noteLoaded()
          }}
          onError={(e) => {
            hide(e)
            if (!src.overlay) noteFailed()
          }}
          style={{
            position: 'absolute',
            left: t.left,
            top: t.top,
            width: TILE_SIZE,
            height: TILE_SIZE,
          }}
        />
      ))}
    </div>
    )
  }

  /* ---------------------------------------------------------------- overlays */

  const path = useMemo(() => {
    if (trail.length < 2) return ''
    return trail
      .map((f, i) => {
        const p = project(f.lat, f.lon)
        return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`
      })
      .join(' ')
  }, [trail, project])

  const routePath = useMemo(() => {
    if (route.length < 2) return ''
    return route
      .map((p, i) => {
        const v = project(p.lat, p.lon)
        return `${i === 0 ? 'M' : 'L'}${v.x.toFixed(1)},${v.y.toFixed(1)}`
      })
      .join(' ')
  }, [route, project])

  const here = fix ? project(fix.lat, fix.lon) : null
  const bar = pickScaleBar(mpp, Math.min(120, w * 0.4))

  const fitTrack = () => {
    if (trail.length === 0 && route.length === 0) return
    const pts = [...trail, ...route]
    const lats = pts.map((f) => f.lat)
    const lons = pts.map((f) => f.lon)
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2
    const lon = (Math.min(...lons) + Math.max(...lons)) / 2
    const spanM = Math.max(
      (Math.max(...lats) - Math.min(...lats)) * 111_132,
      (Math.max(...lons) - Math.min(...lons)) *
        111_320 *
        Math.cos((lat * Math.PI) / 180),
      50,
    )
    setView({
      lat,
      lon,
      zoom: zoomForSpan(spanM * 1.3, lat, Math.min(w, h) || 320, MAX_ZOOM),
      manual: true,
    })
  }

  /**
   * Pull the tiles around here into the cache while there is still a signal.
   *
   * This is the whole offline-imagery story: the service worker keeps every
   * tile the app fetches, so fetching them deliberately now is what makes them
   * there later. Two zoom levels — the one on screen and one closer — because
   * the level you want at the scene is the one you did not save.
   */
  const saveArea = async () => {
    if (saving) return
    const urls = new Set<string>()
    const sources = [...baseSources, ...overlaySources]
    for (const level of [z, Math.min(z + 1, baseZoom.max)]) {
      const mult = 2 ** (level - z)
      for (const t of tilesForView(center, level, layerW * mult, layerH * mult)) {
        for (const src of sources) {
          if (level < src.minZoom || level > src.maxZoom) continue
          urls.add(src.url(level, t.x, t.y))
        }
      }
    }
    const list = [...urls].slice(0, 400)
    const total = list.length
    setSaving({ done: 0, total })

    let done = 0
    const workers = Array.from({ length: 6 }, async () => {
      for (;;) {
        const url = list.pop()
        if (!url) return
        try {
          await fetch(url, { mode: 'cors', credentials: 'omit' })
        } catch {
          // A tile that will not come down is a tile that will not be there
          // later; the count still moves so the progress cannot stall.
        }
        done++
        setSaving({ done, total })
      }
    })
    await Promise.all(workers)
    setSaving(null)
  }

  return (
    <div
      className={
        expanded
          ? // Over everything, including a sheet (z-40) the map may be inside
            // — a picker that expanded to half the screen would be worse than
            // not expanding at all.
            'safe-top safe-bottom fixed inset-0 z-50 flex flex-col gap-1.5 bg-navy-950 px-2'
          : 'space-y-1.5 ' + className
      }
    >
      <div
        ref={boxRef}
        className={
          'relative touch-none overflow-hidden rounded-xl border border-white/10 bg-navy-950 select-none ' +
          // `min-h-0` or the box refuses to shrink inside the column and the
          // attribution row is pushed off the bottom of the screen.
          (expanded ? 'min-h-0 flex-1' : '')
        }
        style={expanded ? undefined : { height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endPointer}
      >
        {placed &&
          baseSources.map((src, i) => layer(src, i === 0 ? 1 : HYBRID_BLEND))}
        {placed && overlaySources.map((src) => layer(src, 0.9))}

        {placed && onPick && pickHint ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-navy-950/70 px-3 py-1.5 text-center text-xs text-slate-200">
            {pickHint}
          </div>
        ) : null}

        {/* On the map, not only on a card below it. Whoever is looking at this
            line is looking here. */}
        {placed && routeUnverified && route.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-red-950/80 px-3 py-1.5 text-center text-xs font-semibold text-red-100">
            Not a course — a straight line to the destination. Nothing on it has
            been checked for depth, land or obstructions.
          </div>
        ) : null}

        {!placed && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-300">
            No position yet. Start tracking, or take a fix, and the map will
            open where you are.
          </div>
        )}

        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          className={
            'pointer-events-none absolute inset-0 ' + (placed ? '' : 'hidden')
          }
          role="img"
          aria-label={
            `${baseLabel} map, ${trail.length} track points` +
            (units.length > 0 ? `, ${units.length} other units on this search` : '')
          }
        >
          {markers.map((m) => {
            const p = project(m.lat, m.lon)
            if (p.x < -40 || p.x > w + 40 || p.y < -20 || p.y > h + 20) {
              return null
            }
            return (
              <g key={m.id}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r="5"
                  className="fill-sky-400 stroke-navy-950"
                  strokeWidth="2"
                />
                <text
                  x={p.x + 8}
                  y={p.y + 4}
                  className="fill-sky-200 text-[11px] font-semibold"
                  style={{ paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 3 }}
                >
                  {m.name}
                </text>
              </g>
            )
          })}

          {units.map((u) => {
            const p = project(u.lat, u.lon)
            if (p.x < -40 || p.x > w + 40 || p.y < -20 || p.y > h + 20) return null
            return (
              <g key={u.id} opacity={u.stale ? 0.45 : 1}>
                {u.heading != null ? (
                  // A boat with a heading is drawn as one, pointing where it
                  // is going — which is half of what the other crews need to
                  // know from a glance at the chart.
                  <path
                    d="M0,-9 L5,7 L0,4 L-5,7 Z"
                    className="fill-amber-300 stroke-navy-950"
                    strokeWidth="1.5"
                    transform={`translate(${p.x} ${p.y}) rotate(${u.heading})`}
                  />
                ) : (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r="5"
                    className="fill-amber-300 stroke-navy-950"
                    strokeWidth="1.5"
                  />
                )}
                <text
                  x={p.x + 9}
                  y={p.y + 4}
                  className="fill-amber-100 text-[11px] font-semibold"
                  style={{ paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 3 }}
                >
                  {u.name}
                  {u.speedKn != null && u.speedKn >= 0.5
                    ? ` ${u.speedKn.toFixed(1)} kn`
                    : ''}
                  {u.stale ? ' (no signal)' : ''}
                </text>
              </g>
            )
          })}

          {routePath && (
            <>
              <path
                d={routePath}
                fill="none"
                stroke="#06131f"
                strokeWidth="4"
                strokeOpacity="0.6"
                strokeLinejoin="round"
              />
              <path
                d={routePath}
                fill="none"
                className={
                  routeUnverified ? 'stroke-red-400' : 'stroke-amber-300'
                }
                strokeWidth={routeUnverified ? 2.5 : 1.5}
                strokeDasharray={routeUnverified ? '2 5' : '6 4'}
                strokeLinejoin="round"
              />
              {route.map((p, i) => {
                const v = project(p.lat, p.lon)
                if (v.x < -20 || v.x > w + 20 || v.y < -20 || v.y > h + 20) {
                  return null
                }
                return (
                  <rect
                    key={i}
                    x={v.x - 3}
                    y={v.y - 3}
                    width="6"
                    height="6"
                    className="fill-amber-300 stroke-navy-950"
                    strokeWidth="1"
                  />
                )
              })}
            </>
          )}

          {path && (
            <>
              <path
                d={path}
                fill="none"
                stroke="#06131f"
                strokeWidth="5"
                strokeOpacity="0.7"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <path
                d={path}
                fill="none"
                className="stroke-emerald-400"
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </>
          )}

          {here && fix && (
            <g>
              {fix.accuracy != null && mpp > 0 && (
                <circle
                  cx={here.x}
                  cy={here.y}
                  r={Math.min(fix.accuracy / mpp, Math.max(w, h))}
                  className="fill-sky-400/10 stroke-sky-300/50"
                  strokeWidth="1"
                />
              )}
              {fix.heading != null && (
                <path
                  d="M0,-16 L6,2 L0,-2 L-6,2 Z"
                  className="fill-emerald-300 stroke-navy-950"
                  strokeWidth="1"
                  transform={`translate(${here.x} ${here.y}) rotate(${fix.heading})`}
                />
              )}
              <circle
                cx={here.x}
                cy={here.y}
                r="6"
                className="fill-emerald-400 stroke-navy-950"
                strokeWidth="2"
              />
            </g>
          )}

          {/* Scale bar, drawn from metres-per-pixel so it measures the imagery
              rather than decorating it. */}
          <g transform={`translate(10 ${h - 14})`}>
            <line
              x1="0"
              y1="0"
              x2={bar.px}
              y2="0"
              stroke="#e2e8f0"
              strokeWidth="2"
              strokeOpacity="0.85"
            />
            <line x1="0" y1="-4" x2="0" y2="4" stroke="#e2e8f0" strokeWidth="2" />
            <line
              x1={bar.px}
              y1="-4"
              x2={bar.px}
              y2="4"
              stroke="#e2e8f0"
              strokeWidth="2"
            />
            <text
              x={bar.px / 2}
              y="-6"
              textAnchor="middle"
              className="text-[10px] font-semibold"
              fill="#e2e8f0"
              style={{ paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 3 }}
            >
              {bar.label}
            </text>
          </g>
        </svg>

        <div
          className={
            'absolute top-2 right-2 flex flex-col gap-1 ' +
            (placed ? '' : 'hidden')
          }
        >
          <MapButton
            label="Zoom in"
            onClick={() => zoomAround((z) => z + 1, w / 2, h / 2)}
          >
            +
          </MapButton>
          <MapButton
            label="Zoom out"
            onClick={() => zoomAround((z) => z - 1, w / 2, h / 2)}
          >
            −
          </MapButton>
          <MapButton
            // Not "Full screen map": the From/To chips on the chart plotter
            // are named "Map", and an accessible name is matched loosely in
            // more places than a test — one that contains another control's
            // whole name is a control that answers to it.
            label={expanded ? 'Leave full screen' : 'Full screen'}
            onClick={() => {
              setMenu(null)
              setExpanded((f) => !f)
            }}
            active={expanded}
          >
            {/* Corners pointing out, then in. A phone screen is small enough
                that the map is the page, and this is the control that says so. */}
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
              <path
                d={
                  expanded
                    ? 'M6.5 1.5v5h-5M9.5 14.5v-5h5'
                    : 'M1.5 6.5v-5h5M14.5 9.5v5h-5'
                }
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={expanded ? 'M1.5 14.5l5-5M14.5 1.5l-5 5' : 'M1.5 1.5l5 5M14.5 14.5l-5-5'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </MapButton>
        </div>

        <div
          className={
            'absolute right-2 bottom-2 flex gap-1 ' + (placed ? '' : 'hidden')
          }
        >
          {(trail.length > 1 || route.length > 1) && (
            <MapButton
              label={route.length > 1 ? 'Fit the pattern and track' : 'Fit the whole track'}
              onClick={fitTrack}
              wide
            >
              {route.length > 1 ? 'Fit pattern' : 'Fit track'}
            </MapButton>
          )}
          <MapButton
            label="Centre on my position"
            onClick={() => setView((v) => ({ ...v, manual: false }))}
            wide
            active={following}
            disabled={!anchor}
          >
            {following ? 'Following' : 'Centre'}
          </MapButton>
        </div>

        {menu && (
          <PressMenu
            at={menu}
            w={w}
            h={h}
            format={coordFormat}
            from={fix}
            onClose={() => setMenu(null)}
            actions={[
              ...(onPick
                ? [
                    {
                      key: 'use',
                      label: 'Use this point',
                      run: () => onPick({ lat: menu.lat, lon: menu.lon }),
                    },
                  ]
                : []),
              ...(longPress === 'full'
                ? [
                    {
                      key: 'waypoint',
                      label: 'Save as waypoint',
                      run: () => askMapAction('waypoint', menu),
                    },
                    {
                      key: 'navigate',
                      label: 'Navigate here',
                      run: () => askMapAction('navigate', menu),
                    },
                  ]
                : []),
              {
                key: 'copy',
                label: 'Copy position',
                run: () => {
                  const text = formatPosition(menu.lat, menu.lon, coordFormat)
                  navigator.clipboard
                    ?.writeText(text)
                    .then(() => toast('Position copied', 'success'))
                    // A clipboard needs a secure context and a permission, and
                    // a refusal is silent otherwise — the crew would be left
                    // pasting the last thing they copied.
                    .catch(() => toast('Could not copy the position', 'error'))
                },
              },
            ]}
          />
        )}

        {imagery !== 'ok' && imagery !== 'idle' && (
          // Stops short of the right edge so it never sits over the zoom
          // controls — the first thing a crew reaches for when the map looks
          // wrong is the zoom.
          <div className="pointer-events-none absolute top-2 right-12 left-2 rounded-lg bg-navy-950/85 px-2.5 py-1.5 text-[11px] text-amber-200">
            {online
              ? `${baseLabel} tiles did not all load here. The track, waypoints and scale below are still exact.`
              : 'Offline — only imagery already saved to this device will appear. The track below is still exact.'}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] text-slate-300">
          {[...baseSources, ...overlaySources].map((s) => s.attribution).join(' · ')}{' '}
          · z{zoom.toFixed(1)}
        </p>
        <button
          onClick={() => void saveArea()}
          disabled={!!saving || !online || !placed}
          className="rounded-lg border border-white/10 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50"
        >
          {saving
            ? `Saving ${saving.done}/${saving.total}…`
            : `Save ${SAVE_NOUN[base]} for offline`}
        </button>
      </div>
    </div>
  )
}

function MapButton({
  children,
  label,
  onClick,
  wide = false,
  active = false,
  disabled = false,
}: {
  children: ReactNode
  label: string
  onClick: () => void
  wide?: boolean
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      // The map swallows pointer events for panning; stopping them here keeps a
      // tap on a control from also dragging the ground out from under it.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={
        'flex min-h-8 items-center justify-center rounded-lg border text-xs font-semibold backdrop-blur disabled:opacity-40 ' +
        (wide ? 'px-2.5 ' : 'w-8 ') +
        (active
          ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200'
          : 'border-white/15 bg-navy-950/75 text-slate-200 hover:bg-navy-950/90')
      }
    >
      {children}
    </button>
  )
}

/**
 * What a press and hold offers: where the finger is, and what can be done
 * with it.
 *
 * Anchored to the press rather than to a corner of the map, because the point
 * being talked about is under the finger and a menu somewhere else makes the
 * crew hold two places in their head. Clamped so it cannot open off the edge,
 * and flipped above the press when there is no room below.
 *
 * The readout is the crew's own coordinate format, and the range and bearing
 * from the boat are there because that is the question actually being asked of
 * a place spotted on a chart: how far, and which way.
 */
function PressMenu({
  at,
  w,
  h,
  format,
  from,
  actions,
  onClose,
}: {
  at: { x: number; y: number; lat: number; lon: number }
  w: number
  h: number
  format: 'dd' | 'ddm' | 'dms'
  from: Fix | null
  actions: { key: string; label: string; run: () => void }[]
  onClose: () => void
}) {
  const estimatedH = 86 + actions.length * 36
  const left = Math.max(8, Math.min(at.x - MENU_W / 2, Math.max(8, w - MENU_W - 8)))
  const below = at.y + 12
  const top = below + estimatedH > h - 8 ? Math.max(8, at.y - estimatedH - 12) : below

  const rangeNM = from ? haversineNM(from.lat, from.lon, at.lat, at.lon) : null
  const bearing = from ? bearingDeg(from.lat, from.lon, at.lat, at.lon) : null

  return (
    <>
      {/* A press dismisses the menu wherever it lands — but the map's own
          handler would also unmount the menu before a tap on it became a
          click, so the menu stops the event where it starts. */}
      <div
        className="absolute inset-0 z-20"
        onPointerDown={(e) => {
          e.stopPropagation()
          onClose()
        }}
      />
      <div
        role="menu"
        aria-label="Place on the map"
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute z-20 overflow-hidden rounded-xl border border-white/15 bg-navy-950/95 shadow-xl shadow-black/50 backdrop-blur"
        style={{ left, top, width: MENU_W }}
      >
        <div className="border-b border-white/10 px-3 py-2">
          <p className="tnum text-xs leading-snug font-semibold text-slate-100">
            {formatPosition(at.lat, at.lon, format)}
          </p>
          {rangeNM !== null && bearing !== null && (
            <p className="tnum mt-0.5 text-[11px] text-slate-400">
              {formatDistance(rangeNM, 'nm')} · {Math.round(bearing)}°{' '}
              {compassPoint(bearing)} from here
            </p>
          )}
        </div>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            role="menuitem"
            onClick={() => {
              a.run()
              onClose()
            }}
            className="block w-full px-3 py-2 text-left text-sm text-slate-100 hover:bg-white/10"
          >
            {a.label}
          </button>
        ))}
      </div>
    </>
  )
}
