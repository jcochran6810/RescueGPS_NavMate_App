import { useMemo } from 'react'
import { Button } from '@/components/ui'
import { useFormat } from '@/hooks/useFormat'
import { useNavCard } from '@/hooks/useNavCard'
import { keepUnitsTogether, legRows, routeSummary, type NavNotice } from '@/lib/navView'
import { useNavigation } from '@/store/useNavigation'

/**
 * The big card at the top of the Chart tab while a route is being steered.
 *
 * Laid out the way a crew reads it underway, largest first: which waypoint,
 * the bearing to it and how far; which way to turn; then the whole passage —
 * distance to go, time to go and the clock time of arrival.
 *
 * Everything on it comes from `useNavCard` → `navCardView` (lib/navView.ts),
 * so the rules — feet near a mark, T or M on every bearing, no bearing inside
 * the arrival circle, greyed when the GPS has gone quiet — are tested there,
 * not re-decided here. On screen only: no sound, no vibration.
 */
export function NavCard() {
  const v = useNavCard()
  const stop = useNavigation((s) => s.stop)
  if (!v) return null

  if (v.phase === 'arrived') {
    return (
      <section
        aria-live="polite"
        className="rounded-2xl border border-emerald-400/50 bg-emerald-500/15 p-4 shadow-lg shadow-black/20"
      >
        <p className="text-2xl font-semibold text-emerald-100">{v.arrivedText}</p>
        <p className="mt-1 text-sm text-emerald-100/80">
          You are within the arrival circle of your destination. Press Done
          when you are finished with this route.
        </p>
        {/* One button: after arriving, ending the route and clearing it are
            the same thing — the passage is over. */}
        <Button variant="primary" className="mt-3 w-full" onClick={stop}>
          Done
        </Button>
      </section>
    )
  }

  const grey = v.stale ? 'opacity-45' : ''
  // The course to steer differs from the bearing to the point only when the
  // boat is off the line into it: then both are shown — the point's bearing
  // and distance (what the crew is heading for), and the course back onto
  // the line (what to steer).
  const splitCourse = !!v.pointBearing && !!v.bearing && v.pointBearing !== v.bearing
  return (
    <section
      aria-label="Steering"
      className={
        'rounded-2xl border p-4 shadow-lg shadow-black/30 ' +
        (v.slowDown ? 'border-red-400 bg-red-950/95 ring-2 ring-red-500/70' : 'border-sky-400/40 bg-navy-900/90')
      }
    >
      {/* GPS too poor for the boat's margins, with shallows or land that
          close to the line ahead: the loudest thing on the card. On screen
          only — the crew asked for no sound. */}
      {v.slowDown && (
        <p
          role="alert"
          className="mb-2 rounded-lg bg-red-600 px-3 py-2 text-center text-lg font-bold tracking-wide text-white"
        >
          Slow down — GPS not accurate enough here
        </p>
      )}
      {/* The circle note goes under the title when the two do not fit side
          by side, rather than squeezing "To waypoint 1 of 12" into three
          lines on a 320 px phone. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <p
          className={
            'min-w-0 text-sm font-semibold ' + (v.rounding ? 'text-amber-200' : 'text-sky-200')
          }
        >
          {v.title}
        </p>
        <span className="tnum ml-auto text-[11px] text-slate-400">{v.radiusText}</span>
      </div>

      {/* The two numbers the crew steers by. They share a line when they fit
          and the distance drops under the bearing when they do not — never
          off the edge: on a 320 px phone "5.22 NM" used to lose its M. */}
      <div
        className={
          'mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 ' + grey
        }
      >
        <span className="tnum text-5xl leading-none font-bold text-slate-50 max-[359px]:text-[2.5rem]">
          {v.atMark ? 'Here' : (v.bearing ?? '—')}
          {splitCourse && (
            <span className="ml-1 align-middle text-xs font-semibold tracking-wide text-slate-400 uppercase">
              steer
            </span>
          )}
        </span>
        <span className="tnum ml-auto text-3xl leading-none font-semibold whitespace-nowrap text-slate-100 max-[359px]:text-2xl">
          {v.distance}
        </span>
      </div>

      {splitCourse && (
        <p className={'tnum mt-1 text-sm text-slate-300 ' + grey}>
          {v.title.replace(/^To /, '').replace(/ — don’t cut the corner$/, '')}: {v.pointBearing} · {v.distance}
        </p>
      )}
      {v.backOnLine && (
        <p className={'mt-1 text-sm font-semibold text-amber-200 ' + grey}>{v.backOnLine}</p>
      )}

      {v.turn && (
        <div className={'mt-2 flex items-center gap-2 ' + grey}>
          {v.turn.kind === 'turn' ? (
            <>
              <span
                aria-hidden
                className={
                  'text-3xl leading-none ' +
                  (v.turn.side === 'right' ? 'text-emerald-300' : 'text-red-300')
                }
              >
                {v.turn.side === 'right' ? '▶' : '◀'}
              </span>
              <span className="text-lg font-semibold text-slate-100">{v.turn.text}</span>
            </>
          ) : (
            <span className="text-lg font-semibold text-emerald-300">{v.turn.text}</span>
          )}
        </div>
      )}
      {v.then && <p className={'mt-1 text-sm text-slate-300 ' + grey}>{v.then}</p>}

      <div
        className={
          'tnum mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 ' +
          grey
        }
      >
        <Cell label="To go" value={v.remaining} />
        <Cell label="Time" value={v.timeToGo ? keepUnitsTogether(v.timeToGo) : '—'} />
        <Cell
          label="Arrive"
          // Where "11:59 PM" cannot fit a third of a narrow card, it breaks
          // before the PM — not inside it.
          value={v.eta?.text.replace('\u00a0', ' ') ?? '—'}
          hint={v.eta?.dayMark || undefined}
          small
        />
      </div>
      {v.speedNote && (
        <p className={'tnum mt-1 text-[11px] text-slate-400 ' + grey}>
          Time worked {v.speedNote}.
        </p>
      )}

      {v.notices.map((n) => (
        <Notice key={n.kind + n.text} notice={n} />
      ))}

      <PendingReroute />

      <Button variant="danger" className="mt-3 w-full" onClick={stop}>
        End
      </Button>
      {/* Read aloud only when it changes meaning — a new waypoint, a new
          notice — never the distance and ETA ticking over every second, which
          queued an announcement a second for the whole passage. The numbers
          stay on the card for a screen reader to read when asked; the
          "last fix N s ago" count is left out for the same reason. */}
      <span className="sr-only" aria-live="polite">
        {v.title}.
        {v.notices
          .filter((n) => n.kind !== 'stale')
          .map((n) => ` ${n.text}`)
          .join('')}
        {v.stale ? ' GPS signal lost.' : ''}
      </span>
    </section>
  )
}

/**
 * A re-route that came back best-effort, laid out for the crew to decide:
 * what it breaks, and the two choices. Steering the current route carries
 * on until they choose.
 */
function PendingReroute() {
  const pending = useNavigation((s) => s.pendingPlan)
  const accept = useNavigation((s) => s.acceptPendingPlan)
  const dismiss = useNavigation((s) => s.dismissPendingPlan)
  const fmt = useFormat()
  const flagged = useMemo(
    () =>
      pending
        ? legRows(pending.legs, { formatDepth: (m) => fmt.depth(m) }).filter((r) => r.flagged)
        : [],
    [pending, fmt],
  )
  if (!pending) return null
  const summary = routeSummary(pending, { now: Date.now(), formatLength: fmt.length })
  return (
    <div className="mt-2 rounded-lg border border-red-400/50 bg-red-500/10 px-3 py-2 text-sm text-red-100">
      <p className="font-semibold">New route from here: {summary.distance}</p>
      <p className="mt-1 text-xs">
        {pending.confirmReason ??
          'No route from here keeps your depth and stand-off the whole way.'}
      </p>
      {flagged.map((r) => (
        <p key={r.n} className="mt-1 text-xs font-semibold text-red-200">
          Leg {r.n}: {r.note}
        </p>
      ))}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button variant="danger" onClick={accept}>
          I understand — steer it
        </Button>
        <Button variant="ghost" onClick={dismiss}>
          Keep current route
        </Button>
      </div>
    </div>
  )
}

/**
 * One of the three passage numbers. A third of a 320 px card is about 70 px
 * of text, so nothing here may insist on one line: "10 h 16 min" breaks
 * between its hours and its minutes, "+1 day" drops under the clock, and a
 * word that still does not fit breaks rather than running under its
 * neighbour (they were `whitespace-nowrap`, and "1 h 16 min" read
 * "1 h 16 mi").
 */
function Cell({
  label,
  value,
  hint,
  small = false,
}: {
  label: string
  value: string
  hint?: string
  small?: boolean
}) {
  return (
    <div className="min-w-0 bg-navy-900 px-1.5 py-2 min-[360px]:px-2 min-[400px]:px-3">
      <div className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </div>
      <div
        className={
          'leading-tight font-semibold text-slate-50 [overflow-wrap:anywhere] ' +
          (small
            ? 'text-[13px] min-[360px]:text-sm min-[400px]:text-base sm:text-lg'
            : 'text-[15px] min-[360px]:text-base min-[400px]:text-lg')
        }
      >
        {value}
        {hint ? (
          <span className="ml-1 inline-block text-xs font-semibold whitespace-nowrap text-amber-300">
            {hint}
          </span>
        ) : null}
      </div>
    </div>
  )
}

const NOTICE_TONE: Record<NavNotice['kind'], string> = {
  stale: 'border-red-400/50 bg-red-500/15 text-red-100',
  waiting: 'border-white/15 bg-white/5 text-slate-200',
  rerouting: 'border-sky-400/50 bg-sky-500/15 text-sky-100',
  'off-course': 'border-amber-400/50 bg-amber-500/15 text-amber-100',
  'gps-poor': 'border-amber-400/40 bg-amber-500/10 text-amber-100',
  error: 'border-red-400/40 bg-red-500/10 text-red-100',
  'leg-caution': 'border-amber-400/50 bg-amber-500/10 text-amber-100',
  'reroute-confirm': 'border-red-400/60 bg-red-500/15 text-red-100',
  'shallow-here': 'border-red-400/60 bg-red-500/20 text-red-50',
  'round-first': 'border-amber-400/60 bg-amber-500/15 text-amber-100',
  'gps-margin': 'border-amber-400/40 bg-amber-500/10 text-amber-100',
  'gps-slow': 'border-red-400/70 bg-red-500/25 text-red-50',
}

function Notice({ notice }: { notice: NavNotice }) {
  const tone =
    notice.kind === 'leg-caution' && notice.tone === 'alert'
      ? 'border-red-400/50 bg-red-500/10 text-red-100'
      : notice.kind === 'shallow-here' && notice.tone === 'caution'
        ? // "May be" — within the fix's error, not under the boat: amber.
          'border-amber-400/60 bg-amber-500/15 text-amber-100'
        : NOTICE_TONE[notice.kind]
  return (
    <p
      role={
        notice.kind === 'shallow-here' ||
        notice.kind === 'gps-slow' ||
        notice.kind === 'reroute-confirm' ||
        notice.kind === 'round-first'
          ? 'alert'
          : notice.kind === 'rerouting'
            ? 'status'
            : undefined
      }
      className={'mt-2 rounded-lg border px-3 py-2 text-sm font-semibold ' + tone}
    >
      {notice.text}
    </p>
  )
}
