import { memo, useEffect, useMemo, useRef } from 'react'
import { normalizeDeg, shortestDelta } from '@/lib/heading'

/**
 * The dial.
 *
 * It is the *rose* that turns, not a needle: whatever sits under the index at
 * the top of the card is the way the device is pointing, which is how a
 * hand-bearing compass is read and the only arrangement that lets a crew steer
 * by it without doing arithmetic first.
 *
 * Two things here are less obvious than they look.
 *
 * **The rotation is unwrapped.** Feeding `rotate(-heading)` straight into the
 * transform sends the card spinning 358° backwards every time the boat's head
 * crosses north, because 359 and 1 are two degrees apart on a compass and 358
 * apart as numbers. The angle animated here is allowed to run past 360 and
 * below 0 without bound, and only ever moves by the short way round.
 *
 * **It animates outside React.** The store emits at 12 Hz, which is plenty for
 * digits and visibly steppy on a moving dial, so a frame loop eases the
 * transform on the group directly. Re-rendering 180 tick marks sixty times a
 * second to achieve the same thing would cost battery on the one device that
 * has none to spare.
 */

interface TickSpec {
  deg: number
  kind: 'minor' | 'medium' | 'major'
}

const TICKS: TickSpec[] = []
for (let deg = 0; deg < 360; deg += 2) {
  TICKS.push({
    deg,
    kind: deg % 30 === 0 ? 'major' : deg % 10 === 0 ? 'medium' : 'minor',
  })
}

const CARDINALS = [
  { deg: 0, label: 'N' },
  { deg: 90, label: 'E' },
  { deg: 180, label: 'S' },
  { deg: 270, label: 'W' },
]

const INTERCARDINALS = [
  { deg: 45, label: 'NE' },
  { deg: 135, label: 'SE' },
  { deg: 225, label: 'SW' },
  { deg: 315, label: 'NW' },
]

/** The 30° graduations that are not already a letter. */
const NUMBERS = [30, 60, 120, 150, 210, 240, 300, 330]

const TICK_OUTER = 92

function tickInner(kind: TickSpec['kind']): number {
  return kind === 'major' ? 78 : kind === 'medium' ? 82 : 86
}

export interface RoseMarker {
  /** Bearing in the same reference the dial is showing. */
  deg: number
  kind: 'target' | 'course'
  label?: string
}

/** How fast the drawn angle chases the reading. Seconds. */
const EASE_TAU = 0.09

export const CompassRose = memo(function CompassRose({
  heading,
  markers = [],
  level,
  tilt,
  caption,
  degraded = false,
  overMap = false,
}: {
  /** Degrees, or null when there is no reading and the rose sits north-up. */
  heading: number | null
  markers?: RoseMarker[]
  /** Bubble position, -1 to 1 in screen axes, or null to hide the level. */
  level?: { x: number; y: number } | null
  tilt?: number | null
  /** The line under the digits — the point of the compass and its reference. */
  caption?: string
  /** Draw it as untrustworthy — the reading is there but should not be used. */
  degraded?: boolean
  /**
   * Drawn over a map rather than on the page.
   *
   * The face goes: a dial is an instrument laid over the ground, and an opaque
   * one hides the thing it is pointing at. What stays is everything that
   * carries information — the graduations, the digits, the north arm, the
   * index — over a barely-there wash that keeps them legible against bright
   * imagery without hiding it.
   */
  overMap?: boolean
}) {
  const roseRef = useRef<SVGGElement>(null)
  /** The drawn angle, unwrapped, which is why it is not React state. */
  const drawn = useRef<number | null>(null)
  const target = useRef(0)
  const frame = useRef<number | null>(null)

  const wanted = heading === null ? 0 : -heading

  useEffect(() => {
    // Keep the target near whatever is currently drawn, so a reading that has
    // crossed north does not unwind the whole way round.
    target.current =
      drawn.current === null
        ? wanted
        : drawn.current + shortestDelta(drawn.current, wanted)

    if (drawn.current === null) {
      drawn.current = target.current
      roseRef.current?.setAttribute('transform', `rotate(${target.current})`)
      return
    }

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      drawn.current = target.current
      roseRef.current?.setAttribute('transform', `rotate(${target.current})`)
      return
    }

    if (frame.current !== null) return

    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const cur = drawn.current ?? target.current
      const gap = target.current - cur
      if (Math.abs(gap) < 0.02) {
        drawn.current = target.current
        roseRef.current?.setAttribute('transform', `rotate(${target.current})`)
        frame.current = null
        return
      }
      const next = cur + gap * (1 - Math.exp(-dt / EASE_TAU))
      drawn.current = next
      roseRef.current?.setAttribute('transform', `rotate(${next})`)
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
  }, [wanted])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    },
    [],
  )

  // 180 ticks and 12 labels never change, so they are built once and reused
  // rather than diffed on every reading.
  const face = useMemo(
    () => (
      <>
        {TICKS.map((t) => (
          <line
            key={t.deg}
            x1="0"
            y1={-TICK_OUTER}
            x2="0"
            y2={-tickInner(t.kind)}
            transform={`rotate(${t.deg})`}
            strokeWidth={t.kind === 'major' ? 2.4 : t.kind === 'medium' ? 1.6 : 1}
            strokeLinecap="round"
            className={
              t.deg === 0
                ? 'stroke-red-400'
                : t.kind === 'minor'
                  ? overMap
                    ? 'stroke-white/70'
                    : 'stroke-slate-500/50'
                  : overMap
                    ? 'stroke-white'
                    : 'stroke-slate-300/70'
            }
          />
        ))}

        {NUMBERS.map((deg) => (
          <text
            key={deg}
            x="0"
            y="-66"
            transform={`rotate(${deg}) rotate(${-deg} 0 -66)`}
            textAnchor="middle"
            dominantBaseline="middle"
            className={
              overMap ? 'fill-white text-[11px] font-medium' : 'fill-slate-400 text-[11px] font-medium'
            }
            style={
              overMap
                ? { paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 3 }
                : undefined
            }
          >
            {deg}
          </text>
        ))}

        {INTERCARDINALS.map((c) => (
          <text
            key={c.label}
            x="0"
            y="-64"
            transform={`rotate(${c.deg}) rotate(${-c.deg} 0 -64)`}
            textAnchor="middle"
            dominantBaseline="middle"
            className={
              overMap ? 'fill-white text-[10px] font-semibold tracking-wide' : 'fill-slate-400 text-[10px] font-semibold tracking-wide'
            }
            style={
              overMap
                ? { paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 3 }
                : undefined
            }
          >
            {c.label}
          </text>
        ))}

        {CARDINALS.map((c) => (
          <text
            key={c.label}
            x="0"
            y="-62"
            transform={`rotate(${c.deg}) rotate(${-c.deg} 0 -62)`}
            textAnchor="middle"
            dominantBaseline="middle"
            className={
              'text-[17px] font-bold ' +
              (c.label === 'N' ? 'fill-red-400' : overMap ? 'fill-white' : 'fill-slate-200')
            }
            style={
              overMap
                ? { paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 3.5 }
                : undefined
            }
          >
            {c.label}
          </text>
        ))}

        {/* The north arm. A rose without one is a ring of numbers. It stops
            short of the hub so that it never crosses the digits — the number
            is the thing that gets read out over a radio, and nothing may sit
            on top of it. */}
        <polygon points="0,-52 -6.5,-36 0,-41 6.5,-36" className="fill-red-400/90" />
      </>
    ),
    [overMap],
  )

  const bubble = level && tilt != null ? bubbleFor(level, tilt) : null

  return (
    <svg
      viewBox="-100 -100 200 200"
      className={
        'mx-auto block ' + (overMap ? 'h-full w-full' : 'w-full max-w-[19rem]')
      }
      role="img"
      aria-label={
        heading === null
          ? 'Compass dial, no heading'
          : `Heading ${Math.round(normalizeDeg(heading))} degrees`
      }
    >
      <defs>
        <radialGradient id="rose-face" cx="50%" cy="35%" r="75%">
          <stop offset="0%" stopColor="#12293f" />
          <stop offset="70%" stopColor="#0b1f33" />
          <stop offset="100%" stopColor="#06131f" />
        </radialGradient>
        <linearGradient id="rose-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.28)" />
          <stop offset="55%" stopColor="rgba(255,255,255,0.06)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.16)" />
        </linearGradient>
      </defs>

      {/* Bezel. Over a map there is no face at all — the dial is a ring of
          graduations laid on the ground, and anything behind it is ground the
          crew cannot see. Legibility comes from outlining the marks rather
          than from tinting what is underneath. */}
      {!overMap && <circle r="97" fill="url(#rose-face)" />}
      <circle
        r="97"
        fill="none"
        stroke="url(#rose-rim)"
        strokeWidth="2.5"
        opacity={overMap ? 0.85 : 1}
      />
      {!overMap && (
        <circle r="74" fill="none" className="stroke-white/5" strokeWidth="1" />
      )}

      {/* `data-rose` is how the headless drive reads the drawn angle back out
          — the one thing about this dial that cannot be checked from a
          screenshot is whether it took the short way round. */}
      <g ref={roseRef} data-rose="" opacity={degraded ? 0.45 : 1}>
        {face}

        {markers.map((m) => (
          <g key={`${m.kind}-${m.deg}`} transform={`rotate(${normalizeDeg(m.deg)})`}>
            {m.kind === 'target' ? (
              <>
                <polygon
                  points="0,-96 -7,-80 0,-84 7,-80"
                  className="fill-sky-400"
                />
                <line
                  x1="0"
                  y1="-80"
                  x2="0"
                  y2="0"
                  className="stroke-sky-400/35"
                  strokeWidth="1.5"
                  strokeDasharray="4 5"
                />
              </>
            ) : (
              <polygon
                points="0,-96 -6,-82 0,-86 6,-82"
                className="fill-none stroke-emerald-300"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            )}
          </g>
        ))}
      </g>

      {/* The index. Fixed to the card, because it is the device, not the world. */}
      <polygon points="0,-99 -8,-84 8,-84" className="fill-amber-300" />
      <line
        x1="0"
        y1="-84"
        x2="0"
        y2="-74"
        className="stroke-amber-300/70"
        strokeWidth="2"
      />

      {/* The hub the number sits on. Not over a map: a filled disc in the
          middle of the dial covers the one piece of ground the crew is
          standing on and asking about. The number keeps its own outline
          instead. */}
      {!overMap && (
        <>
          <circle r="32" fill="url(#rose-face)" />
          <circle r="32" fill="none" className="stroke-white/10" strokeWidth="1" />
        </>
      )}

      {/*
       * The number, which is what actually gets read out over a radio.
       *
       * Not over a map. It is 38 px of digits in the middle of the dial, and
       * the middle of the dial is where the crew is standing — on a map it
       * covered their own position marker and the nought of the range scale,
       * which was reported from a phone. Over a map it is rendered below the
       * dial instead, in ordinary text, by whoever placed the map there.
       */}
      {!overMap && (
      <text
        x="0"
        y="-8"
        data-heading=""
        textAnchor="middle"
        dominantBaseline="middle"
        className="tnum fill-slate-50 text-[38px] font-semibold"
        style={
          overMap
            ? { paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 6 }
            : undefined
        }
      >
        {heading === null ? '—' : `${Math.round(normalizeDeg(heading))}°`}
      </text>
      )}
      {caption && !overMap && (
        <text
          x="0"
          y="15"
          data-caption=""
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-slate-300 text-[10px] font-semibold tracking-[0.12em] uppercase"
          style={
            overMap
              ? { paintOrder: 'stroke', stroke: '#06131f', strokeWidth: 4 }
              : undefined
          }
        >
          {caption}
        </text>
      )}

      {bubble}
    </svg>
  )
})

/**
 * A spirit level, drawn low on the face.
 *
 * A magnetometer read at a steep angle is a magnetometer read badly, and the
 * crew holding it has no way to know that from a number. The bubble is the
 * fastest thing on the card to read and the only one that says *how to fix it*.
 */
function bubbleFor(level: { x: number; y: number }, tilt: number) {
  const r = 11.5
  const reach = 8
  const mag = Math.hypot(level.x, level.y)
  const scale = mag > 1 ? 1 / mag : 1
  const bx = level.x * scale * reach
  const by = level.y * scale * reach
  const tone =
    tilt <= 8
      ? 'fill-emerald-300'
      : tilt <= 25
        ? 'fill-amber-300'
        : 'fill-red-400'

  return (
    <g transform="translate(0 38)" aria-hidden="true">
      <circle r={r} className="fill-navy-950/70 stroke-white/15" strokeWidth="1" />
      <circle r={reach - 4.5} className="fill-none stroke-white/10" strokeWidth="1" />
      <circle cx={bx} cy={by} r="3.4" className={tone} />
    </g>
  )
}
