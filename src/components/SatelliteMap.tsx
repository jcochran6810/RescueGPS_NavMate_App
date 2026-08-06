import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { Fix } from '@/lib/types'
import {
  LABELS,
  SATELLITE,
  TILE_SIZE,
  latToTileY,
  lonToTileX,
  metersPerPixel,
  pickScaleBar,
  tileXToLon,
  tileYToLat,
  tilesForView,
  zoomForSpan,
  type TileSource,
} from '@/lib/tiles'
import type { PathMarker } from '@/components/TrackPath'

const MIN_ZOOM = 3
const MAX_ZOOM = 19
const DEFAULT_ZOOM = 16

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
export function SatelliteMap({
  trail,
  fix,
  markers = [],
  labels = false,
  height = 320,
  className = '',
}: {
  trail: Fix[]
  fix: Fix | null
  markers?: PathMarker[]
  /** Draw place names and boundaries over the imagery. */
  labels?: boolean
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

  const anchor = fix ?? trail[trail.length - 1] ?? null
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

  /* ---------------------------------------------------------------- gestures
   * One finger pans, two pinch, the wheel zooms. All of it moves the same two
   * pieces of state — where the middle of the map is and how far in it is —
   * so there is no gesture that can leave the view somewhere the buttons
   * cannot get it back from.
   */

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)

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
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom }
    }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

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
    if (pointers.current.size < 2) pinch.current = null
  }

  /* ------------------------------------------------------------------ tiles */

  const z = Math.max(
    SATELLITE.minZoom,
    Math.min(SATELLITE.maxZoom, Math.round(zoom)),
  )
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

  const layer = (src: TileSource, opacity = 1) => (
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

  const here = fix ? project(fix.lat, fix.lon) : null
  const bar = pickScaleBar(mpp, Math.min(120, w * 0.4))

  const fitTrack = () => {
    if (trail.length === 0) return
    const lats = trail.map((f) => f.lat)
    const lons = trail.map((f) => f.lon)
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
    for (const level of [z, Math.min(z + 1, SATELLITE.maxZoom)]) {
      const mult = 2 ** (level - z)
      for (const t of tilesForView(center, level, layerW * mult, layerH * mult)) {
        urls.add(SATELLITE.url(t.z, t.x, t.y))
        if (labels) urls.add(LABELS.url(t.z, t.x, t.y))
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
    <div className={'space-y-1.5 ' + className}>
      <div
        ref={boxRef}
        className="relative touch-none overflow-hidden rounded-xl border border-white/10 bg-navy-950 select-none"
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        {placed && layer(SATELLITE)}
        {placed && labels && layer(LABELS, 0.9)}

        {!placed && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-500">
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
          aria-label={`Satellite map, ${trail.length} track points`}
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
        </div>

        <div
          className={
            'absolute right-2 bottom-2 flex gap-1 ' + (placed ? '' : 'hidden')
          }
        >
          {trail.length > 1 && (
            <MapButton label="Fit the whole track" onClick={fitTrack} wide>
              Fit track
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

        {imagery !== 'ok' && imagery !== 'idle' && (
          // Stops short of the right edge so it never sits over the zoom
          // controls — the first thing a crew reaches for when the map looks
          // wrong is the zoom.
          <div className="pointer-events-none absolute top-2 right-12 left-2 rounded-lg bg-navy-950/85 px-2.5 py-1.5 text-[11px] text-amber-200">
            {online
              ? 'Satellite imagery did not load here. The track, waypoints and scale below are still exact.'
              : 'Offline — only imagery already saved to this device will appear. The track below is still exact.'}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] text-slate-500">
          {SATELLITE.attribution}
          {labels ? ` · ${LABELS.attribution}` : ''} · z{zoom.toFixed(1)}
        </p>
        <button
          onClick={() => void saveArea()}
          disabled={!!saving || !online || !placed}
          className="rounded-lg border border-white/10 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50"
        >
          {saving
            ? `Saving ${saving.done}/${saving.total}…`
            : 'Save imagery for offline'}
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
