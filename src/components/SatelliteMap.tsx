import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFormat } from '@/hooks/useFormat'
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
import {
  alongForward,
  forwardScreenDeg,
  pickRings,
  rulerLengthPx,
} from '@/lib/rings'
import { useUnits } from '@/store/useUnits'
import { bearingDeg, compassPoint, haversineNM } from '@/lib/geo'
import { useCoordFormat } from '@/store/useCoordFormat'
import { useMapAction } from '@/store/useMapAction'
import { useWaypointView } from '@/store/useWaypointView'
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
  rotationDeg = 0,
  rangeRings = false,
  forwardDeg = null,
  overlay,
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
   * Turn the ground under the boat, so the screen faces where the crew does.
   *
   * 0 is north up. Pass the heading and the map becomes head-up: what is
   * ahead of the boat is ahead on the screen, which is the one thing a paper
   * chart cannot do and the reason anybody asks for it. The rotation is
   * **display only** — every position, bearing and distance underneath is
   * worked from coordinates and is unaffected.
   */
  rotationDeg?: number
  /** Draw range rings around the boat: how far away, read off the screen. */
  rangeRings?: boolean
  /** The direction the crew is facing, true, for the line ahead of them. */
  forwardDeg?: number | null
  /**
   * Something drawn on top of the ground, inside the map box.
   *
   * Inside, because that is the whole difference between an instrument laid
   * over a chart and a picture sitting next to one — and because the box is
   * the only element that knows where the ground actually is. The map's own
   * attribution and save-for-offline row sit outside it, so an overlay
   * positioned against the component as a whole ends up low and too tall,
   * which is exactly what the first version did.
   *
   * Deaf to touch, so the map underneath still pans, pinches and answers a
   * press.
   */
  overlay?: ReactNode
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
  const distanceUnit = useUnits((s) => s.distance)
  const askMapAction = useMapAction((s) => s.ask)
  const openWaypoint = useWaypointView((s) => s.open)

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

  /*
   * Two frames, once the map can turn.
   *
   * `project` and `unproject` work in the **map frame**: north up, the way the
   * tiles are laid out. What a finger touches is in the **screen frame**,
   * which is the map frame turned by `rotationDeg`. Every gesture therefore
   * has to cross between them, and forgetting one is a tap that lands
   * somewhere the crew did not point — so both directions live here, next to
   * each other, and are the identity when the map is north up.
   */
  const rot = ((rotationDeg % 360) + 360) % 360
  const spin = useCallback(
    (x: number, y: number, deg: number) => {
      if (deg === 0) return { x, y }
      const rad = (deg * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const dx = x - w / 2
      const dy = y - h / 2
      return {
        x: w / 2 + dx * cos - dy * sin,
        y: h / 2 + dx * sin + dy * cos,
      }
    },
    [w, h],
  )
  /** A point the crew touched, in the frame the tiles are laid out in. */
  const toMapFrame = useCallback(
    (x: number, y: number) => spin(x, y, rot),
    [spin, rot],
  )
  /** A projected point, in the frame the crew is looking at. */
  const toScreenFrame = useCallback(
    (x: number, y: number) => spin(x, y, -rot),
    [spin, rot],
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
  const toMapFrameRef = useRef(toMapFrame)
  toMapFrameRef.current = toMapFrame

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
  /** Cancels the guard below, if one is armed. */
  const swallow = useRef<(() => void) | null>(null)

  /**
   * Eat the click the browser makes up when a finger lifts.
   *
   * A touch that ends produces a compatibility mouse sequence —
   * mousedown, mouseup, **click** — aimed at whatever is under the finger at
   * that moment. The press menu opens *under the finger* by design, so the
   * click lands on one of its own items and fires it: press and hold on a
   * phone opened the menu and instantly chose "Save as waypoint" from it.
   *
   * A mouse never does this, which is why every drive in this repo missed it
   * until one ran with touch input.
   *
   * So the first click after the menu opens is swallowed in the capture
   * phase, before React sees it. The guard lifts on that click or after a
   * moment, so a real tap on an item — which needs a new touch — still works.
   */
  const swallowNextClick = useCallback(() => {
    swallow.current?.()
    const eat = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      done()
    }
    const done = () => {
      document.removeEventListener('click', eat, true)
      clearTimeout(timer)
      swallow.current = null
    }
    const timer = setTimeout(done, 700)
    document.addEventListener('click', eat, true)
    swallow.current = done
  }, [])

  const cancelHold = useCallback(() => {
    if (hold.current) {
      clearTimeout(hold.current)
      hold.current = null
    }
  }, [])

  // A press timer outliving its map would fire a menu onto a screen that has
  // moved on, and a swallow left armed would eat a click meant for whatever
  // replaced it.
  useEffect(
    () => () => {
      cancelHold()
      swallow.current?.()
    },
    [cancelHold],
  )

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
      // A drag is measured on the screen; the map moves in its own frame, so
      // the delta is turned before it is applied. Without this a head-up map
      // slides sideways when the crew drags straight down.
      if (rot !== 0) {
        const rad = (rot * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        ;[dx, dy] = [dx * cos - dy * sin, dx * sin + dy * cos]
      }
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
    [from, rot],
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
        // The finger is on the screen; the ground it is over is in the map
        // frame.
        const m = spin(px, py, rot)
        const mx = m.x - w / 2
        const my = m.y - h / 2
        const lon = tileXToLon(lonToTileX(c.lon, v.zoom) + mx / TILE_SIZE, v.zoom)
        const lat = tileYToLat(latToTileY(c.lat, v.zoom) + my / TILE_SIZE, v.zoom)
        return {
          lat: tileYToLat(latToTileY(lat, z) - my / TILE_SIZE, z),
          lon: tileXToLon(lonToTileX(lon, z) - mx / TILE_SIZE, z),
          zoom: z,
          manual: true,
        }
      })
    },
    [from, w, h, spin, rot],
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
      const m = toMapFrameRef.current(x, y)
      const at = unprojectRef.current(m.x, m.y)
      // A press that produced a menu must not also pan when the finger lifts.
      tap.current = null
      // Phones that can, say so — the press has no other feedback until the
      // menu paints, and a crew in gloves needs to know the phone heard it.
      navigator.vibrate?.(8)
      swallowNextClick()
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

  /** How close a tap has to land to count as hitting a marker, in pixels. */
  const MARKER_HIT_PX = 22

  const onPointerUp = (e: ReactPointerEvent) => {
    const t = tap.current
    tap.current = null
    endPointer(e)
    if (!t || t.moved || Date.now() - t.t > TAP_MS) return
    const r = boxRef.current?.getBoundingClientRect()
    if (!r) return
    const screenX = e.clientX - r.left
    const screenY = e.clientY - r.top
    const { x, y } = toMapFrame(screenX, screenY)

    /*
     * A tap on a waypoint opens the waypoint.
     *
     * Only when the map is not being used as a picker: a crew part-way
     * through choosing a destination means the place under their finger, and
     * hijacking that to open a sheet would take the task away from them. When
     * they are just looking at the chart, the marker is the thing they meant.
     */
    if (!onPick) {
      const hit = markers.find((m) => {
        if (!m.waypointId) return false
        const p = project(m.lat, m.lon)
        return Math.hypot(p.x - x, p.y - y) <= MARKER_HIT_PX
      })
      if (hit?.waypointId) {
        openWaypoint(hit.waypointId)
        return
      }
    }

    if (!onPick) return
    onPick(unproject(x, y))
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
  /*
   * A turned rectangle does not cover the box it came from: rotate a 390×320
   * map 45° and its corners swing inside the frame, leaving four wedges of
   * nothing. So the tile layer is grown to the bounding box of the rotation —
   * exactly, rather than by a blanket √2 — which is the smallest amount of
   * extra imagery that still fills the screen. At 0° it is the same size it
   * always was and no extra tile is fetched.
   */
  const rad = (rot * Math.PI) / 180
  const coverW = rot === 0 ? w : Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))
  const coverH = rot === 0 ? h : Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
  const layerW = coverW / scale
  const layerH = coverH / scale

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

  /*
   * The rings hang off the boat, in the frame the crew is looking at — so the
   * projected position is turned into the screen frame before anything is
   * drawn around it. On a head-up map following the boat that is the middle
   * of the screen; after a pan it is wherever the boat now sits.
   */
  const ringCenter = useMemo(() => {
    if (!rangeRings || !here) return null
    return toScreenFrame(here.x, here.y)
  }, [rangeRings, here?.x, here?.y, toScreenFrame])
  const forwardScreen = forwardScreenDeg(forwardDeg, rot)
  /*
   * How far the ruler can run before it leaves the box — measured along the
   * way the crew is facing, not half the smaller side of the map.
   *
   * It used to be `min(w, h) / 2`, which on a head-up map stopped the scale
   * well short of the top of the screen: the crew could see a thing at the
   * edge and the ruler had nothing to say about it. Reported from a phone with
   * the scale ending at 750 ft in the middle of the picture.
   */
  const rulerPx = useMemo(
    () =>
      rangeRings && ringCenter && forwardScreen !== null
        ? rulerLengthPx(ringCenter.x, ringCenter.y, w, h, forwardScreen)
        : 0,
    [rangeRings, ringCenter, forwardScreen, w, h],
  )
  const rings = useMemo(
    () => (rulerPx > 0 ? pickRings(mpp, rulerPx, distanceUnit) : []),
    [rulerPx, mpp, distanceUnit],
  )
  /** "0.0 mi" — the same unit the graduations use, so the scale reads as one. */
  const zeroLabel = rings.length > 0 ? `0 ${rings[0].label.split(' ')[1]}` : ''

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
        {/* The ground turns; the controls and the scale bar do not. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={
            rot === 0
              ? undefined
              : { transform: `rotate(${-rot}deg)`, transformOrigin: '50% 50%' }
          }
        >
          {placed &&
            baseSources.map((src, i) => layer(src, i === 0 ? 1 : HYBRID_BLEND))}
          {placed && overlaySources.map((src) => layer(src, 0.9))}
        </div>

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
          {/*
           * Everything drawn from coordinates turns with the ground, so a
           * track laid over the imagery still lies on the imagery. The scale
           * bar, the range rings and the north arrow are outside this group:
           * a ring is a circle either way, and a scale bar or a north arrow
           * that turned with the map would be measuring nothing.
           */}
          <g
            transform={rot === 0 ? undefined : `rotate(${-rot} ${w / 2} ${h / 2})`}
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
                  // Turned back the other way, so a name is readable with the
                  // map facing any direction. Upside-down text on a screen
                  // somebody is steering by is worse than no label.
                  transform={rot === 0 ? undefined : `rotate(${rot} ${p.x + 8} ${p.y + 4})`}
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
                  transform={rot === 0 ? undefined : `rotate(${rot} ${p.x + 9} ${p.y + 4})`}
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

          </g>

          {/*
           * The range scale: a ruler laid along the way the crew is facing,
           * graduated in the unit they read.
           *
           * Rings came first and were wrong for this screen. A ring tells you
           * how far something is *in any direction*, which is a question
           * nobody on a bearing is asking — and three circles drawn over a
           * chart hide the chart. A ruler ahead answers the question actually
           * being asked, "how far is that", and covers one line of ground
           * instead of three rings of it.
           *
           * Drawn outside the rotating group: it hangs off the boat in the
           * frame the crew is looking at, and its labels have to stay upright.
           */}
          {rings.length > 0 && ringCenter && forwardScreen !== null && (
            <g>
              {(() => {
                const far = rings[rings.length - 1]
                // The line goes to the edge; the graduations go as far as they
                // read. A scale that stops at its last number cannot measure
                // the thing beyond it.
                const lineLen = Math.max(rulerPx, far.px)
                const end = alongForward(forwardScreen, lineLen)
                const step = rings[0].px
                // Five minor ticks to a step, as a rule is divided.
                const minors = []
                for (let i = 1; i * (step / 5) < lineLen; i++) {
                  const at = alongForward(forwardScreen, i * (step / 5))
                  const across = alongForward(forwardScreen + 90, 4)
                  minors.push(
                    <line
                      key={i}
                      x1={ringCenter.x + at.dx - across.dx}
                      y1={ringCenter.y + at.dy - across.dy}
                      x2={ringCenter.x + at.dx + across.dx}
                      y2={ringCenter.y + at.dy + across.dy}
                      className="stroke-white/70"
                      strokeWidth="1"
                    />,
                  )
                }
                const head = alongForward(forwardScreen, lineLen)
                const barbL = alongForward(forwardScreen + 150, 9)
                const barbR = alongForward(forwardScreen - 150, 9)
                return (
                  <g style={{ paintOrder: 'stroke' }}>
                    <line
                      x1={ringCenter.x}
                      y1={ringCenter.y}
                      x2={ringCenter.x + end.dx}
                      y2={ringCenter.y + end.dy}
                      stroke="#06131f"
                      strokeOpacity="0.55"
                      strokeWidth="4"
                    />
                    <line
                      x1={ringCenter.x}
                      y1={ringCenter.y}
                      x2={ringCenter.x + end.dx}
                      y2={ringCenter.y + end.dy}
                      className="stroke-white"
                      strokeWidth="1.5"
                      strokeDasharray="5 4"
                    />
                    {minors}
                    {/* The arrow at the far end says which way this is read. */}
                    <polygon
                      points={
                        `${ringCenter.x + head.dx},${ringCenter.y + head.dy} ` +
                        `${ringCenter.x + head.dx + barbL.dx},${ringCenter.y + head.dy + barbL.dy} ` +
                        `${ringCenter.x + head.dx + barbR.dx},${ringCenter.y + head.dy + barbR.dy}`
                      }
                      className="fill-white stroke-navy-950"
                      strokeWidth="1"
                    />
                  </g>
                )
              })()}

              {/* A graduation at each step, with the distance beside it —
                  beside, not on, so the number never sits on the line it is
                  labelling. */}
              {rings.map((r) => {
                const at = alongForward(forwardScreen, r.px)
                const across = alongForward(forwardScreen + 90, 7)
                const label = alongForward(forwardScreen + 90, 13)
                return (
                  <g key={r.meters}>
                    <line
                      x1={ringCenter.x + at.dx - across.dx}
                      y1={ringCenter.y + at.dy - across.dy}
                      x2={ringCenter.x + at.dx + across.dx}
                      y2={ringCenter.y + at.dy + across.dy}
                      className="stroke-white"
                      strokeWidth="2"
                    />
                    <text
                      x={ringCenter.x + at.dx + label.dx}
                      y={ringCenter.y + at.dy + label.dy + 4}
                      className="fill-white text-[12px] font-semibold"
                      style={{ paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 3.5 }}
                    >
                      {r.label}
                    </text>
                  </g>
                )
              })}

              {/* Nought, at the boat — the end a ruler is measured from. */}
              <text
                x={ringCenter.x + alongForward(forwardScreen + 90, 13).dx}
                y={ringCenter.y + alongForward(forwardScreen + 90, 13).dy + 4}
                className="fill-white text-[12px] font-semibold"
                style={{ paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 3.5 }}
              >
                {zeroLabel}
              </text>
            </g>
          )}

          {/* Which way is north, once the map stops pointing that way itself.
              A turned chart with nothing saying so is how a crew reads a
              bearing backwards. */}
          {rot !== 0 && (
            <g transform={`translate(${w - 26} 26)`}>
              <circle r="15" className="fill-navy-950/70 stroke-white/15" strokeWidth="1" />
              <path
                d="M0,-11 L4,3 L0,0.5 L-4,3 Z"
                className="fill-red-400 stroke-navy-950"
                strokeWidth="0.75"
                transform={`rotate(${-rot})`}
              />
              <text
                y="11"
                textAnchor="middle"
                className="fill-slate-200 text-[9px] font-semibold"
              >
                N
              </text>
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
            // Above the overlay: with a compass rose drawn on the ground, a
            // control stack underneath it is a control stack the crew cannot
            // find.
            'absolute top-2 right-2 z-20 flex flex-col gap-1 ' +
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
            'absolute right-2 bottom-2 z-20 flex gap-1 ' + (placed ? '' : 'hidden')
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
            {/* A crosshair as well as the word: this is the control a crew
                reaches for after panning, and on a map with a dial drawn over
                it the shape is found faster than the label is read. */}
            <svg viewBox="0 0 16 16" className="mr-1 h-3.5 w-3.5" aria-hidden>
              <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
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

        {overlay ? (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-2">
            {overlay}
          </div>
        ) : null}

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
          className="min-h-9 rounded-lg border border-white/10 px-2.5 text-[11px] font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50"
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
  const fmt = useFormat()
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
              {fmt.length(rangeNM)} · {Math.round(bearing)}°{' '}
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
