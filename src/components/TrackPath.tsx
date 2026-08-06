import { useMemo } from 'react'
import type { Fix } from '@/lib/types'
import { NM_TO_METERS } from '@/lib/geo'

/** Nautical miles in a degree of latitude, by definition. */
const NM_PER_DEGREE = 60
const VIEW = 100
const PADDING = 8

export interface PathMarker {
  id: string
  name: string
  lat: number
  lon: number
}

/**
 * The recorded path, drawn north-up at whatever scale fits it.
 *
 * This is a plot, not a map: there is no basemap under it. Tiles would need a
 * connection at the exact moment the crew has none, and a chart that silently
 * fails to load is worse than one that was never promised. What it does show
 * honestly is the shape of the track, where it started, where you are now, and
 * how big the whole thing is — with a scale bar so the shape can be measured.
 */
export function TrackPath({
  trail,
  markers = [],
  className = '',
}: {
  trail: Fix[]
  markers?: PathMarker[]
  className?: string
}) {
  const plot = useMemo(() => {
    if (trail.length === 0) return null

    // A local flat projection, good to a fraction of a percent over the few
    // miles a track covers. Longitude is squeezed by the latitude so the shape
    // is not stretched east-west.
    const lat0 = trail.reduce((s, f) => s + f.lat, 0) / trail.length
    const kx = Math.cos((lat0 * Math.PI) / 180) * NM_PER_DEGREE
    const lon0 = trail[0].lon

    const project = (lat: number, lon: number) => ({
      x: (lon - lon0) * kx,
      y: -(lat - lat0) * NM_PER_DEGREE,
    })

    const points = trail.map((f) => project(f.lat, f.lon))
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    // A stationary track has zero extent, which would divide by zero. Give it
    // a hundred-metre box so the marker still lands in the middle.
    const spanNM = Math.max(maxX - minX, maxY - minY, 0.054)
    const scale = (VIEW - PADDING * 2) / spanNM
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2

    const toView = (lat: number, lon: number) => {
      const p = project(lat, lon)
      return {
        x: VIEW / 2 + (p.x - cx) * scale,
        y: VIEW / 2 + (p.y - cy) * scale,
      }
    }

    const path = trail
      .map((f, i) => {
        const v = toView(f.lat, f.lon)
        return `${i === 0 ? 'M' : 'L'}${v.x.toFixed(2)},${v.y.toFixed(2)}`
      })
      .join(' ')

    return { toView, path, spanNM, scale }
  }, [trail])

  if (!plot) {
    return (
      <div
        className={
          'grid h-48 place-items-center rounded-xl border border-dashed border-white/10 text-sm text-slate-400 ' +
          className
        }
      >
        No path recorded yet.
      </div>
    )
  }

  const start = plot.toView(trail[0].lat, trail[0].lon)
  const here = plot.toView(
    trail[trail.length - 1].lat,
    trail[trail.length - 1].lon,
  )
  const bar = scaleBar(plot.spanNM)

  return (
    <div
      className={
        'relative overflow-hidden rounded-xl border border-white/10 bg-navy-950/60 ' +
        className
      }
    >
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="block h-48 w-full" role="img"
        aria-label={`Recorded path, ${trail.length} points`}>
        {markers.map((m) => {
          const v = plot.toView(m.lat, m.lon)
          if (v.x < 0 || v.x > VIEW || v.y < 0 || v.y > VIEW) return null
          return (
            <g key={m.id}>
              <circle cx={v.x} cy={v.y} r="1.6" className="fill-sky-400/70" />
              <text
                x={v.x + 3}
                y={v.y - 2.5}
                className="fill-sky-300/80 text-[3.6px]"
              >
                {m.name}
              </text>
            </g>
          )
        })}

        <path
          d={plot.path}
          fill="none"
          className="stroke-emerald-400"
          strokeWidth="1.2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <circle cx={start.x} cy={start.y} r="2" className="fill-slate-400" />
        <circle cx={here.x} cy={here.y} r="2.8" className="fill-emerald-300" />
        <circle
          cx={here.x}
          cy={here.y}
          r="5"
          className="fill-none stroke-emerald-300/40"
          strokeWidth="1"
        />

        {/* Drawn in view units rather than CSS, so the bar is exactly as long
            as the distance it claims however wide the card ends up. */}
        <g className="stroke-slate-500">
          <line
            x1={VIEW - 4 - bar.nm * plot.scale}
            y1={VIEW - 4}
            x2={VIEW - 4}
            y2={VIEW - 4}
            strokeWidth="0.8"
          />
          <line
            x1={VIEW - 4 - bar.nm * plot.scale}
            y1={VIEW - 6}
            x2={VIEW - 4 - bar.nm * plot.scale}
            y2={VIEW - 2}
            strokeWidth="0.8"
          />
          <line x1={VIEW - 4} y1={VIEW - 6} x2={VIEW - 4} y2={VIEW - 2} strokeWidth="0.8" />
        </g>
        <text
          x={VIEW - 4}
          y={VIEW - 7}
          textAnchor="end"
          className="fill-slate-500 text-[3.6px]"
        >
          {bar.label}
        </text>
      </svg>

      <div className="pointer-events-none absolute top-1.5 left-2 text-[10px] font-semibold text-slate-400">
        N ↑
      </div>
    </div>
  )
}

/** A round number of distance that fits comfortably inside the plotted span. */
function scaleBar(spanNM: number): { nm: number; label: string } {
  const target = spanNM / 3
  const metric = [
    { nm: 25 / NM_TO_METERS, label: '25 m' },
    { nm: 50 / NM_TO_METERS, label: '50 m' },
    { nm: 100 / NM_TO_METERS, label: '100 m' },
    { nm: 250 / NM_TO_METERS, label: '250 m' },
    { nm: 500 / NM_TO_METERS, label: '500 m' },
    { nm: 0.5, label: '0.5 NM' },
    { nm: 1, label: '1 NM' },
    { nm: 2, label: '2 NM' },
    { nm: 5, label: '5 NM' },
    { nm: 10, label: '10 NM' },
    { nm: 25, label: '25 NM' },
    { nm: 50, label: '50 NM' },
  ]
  for (let i = metric.length - 1; i >= 0; i--) {
    if (metric[i].nm <= target) return metric[i]
  }
  return metric[0]
}
