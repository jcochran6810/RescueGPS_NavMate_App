import { Button } from '@/components/ui'
import { useNavCard } from '@/hooks/useNavCard'
import { etaText, type NavNotice } from '@/lib/navView'
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
  const clear = useNavigation((s) => s.clear)
  if (!v) return null

  if (v.phase === 'arrived') {
    return (
      <section
        aria-live="polite"
        className="rounded-2xl border border-emerald-400/50 bg-emerald-500/15 p-4 shadow-lg shadow-black/20"
      >
        <p className="text-2xl font-semibold text-emerald-100">{v.arrivedText}</p>
        <p className="mt-1 text-sm text-emerald-100/80">
          Steering has stopped moving on. End the route when you are done with it.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="primary" onClick={stop}>
            End
          </Button>
          <Button variant="ghost" onClick={clear}>
            Clear route
          </Button>
        </div>
      </section>
    )
  }

  const grey = v.stale ? 'opacity-45' : ''
  return (
    <section
      aria-label="Steering"
      className="rounded-2xl border border-sky-400/40 bg-navy-900/90 p-4 shadow-lg shadow-black/30"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-sky-200">{v.title}</p>
        <span className="tnum shrink-0 text-[11px] text-slate-400">{v.radiusText}</span>
      </div>

      <div className={'mt-1 flex items-baseline justify-between gap-3 ' + grey}>
        <span className="tnum text-5xl leading-none font-bold text-slate-50">
          {v.atMark ? 'Here' : (v.bearing ?? '—')}
        </span>
        <span className="tnum text-3xl leading-none font-semibold text-slate-100">
          {v.distance}
        </span>
      </div>

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
        <Cell label="Time" value={v.timeToGo ?? '—'} />
        <Cell
          label="Arrive"
          value={v.eta?.text ?? '—'}
          hint={v.eta?.dayMark || undefined}
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

      <Button variant="danger" className="mt-3 w-full" onClick={stop}>
        End
      </Button>
      <span className="sr-only" aria-live="polite">
        {v.title}. {v.bearing ?? ''} {v.distance}. {etaText(v.eta) ?? ''}
      </span>
    </section>
  )
}

function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-navy-900 px-3 py-2">
      <div className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </div>
      <div className="text-lg font-semibold text-slate-50">
        {value}
        {hint ? <span className="ml-1 text-xs font-semibold text-amber-300">{hint}</span> : null}
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
}

function Notice({ notice }: { notice: NavNotice }) {
  return (
    <p
      role={notice.kind === 'stale' || notice.kind === 'rerouting' ? 'status' : undefined}
      className={'mt-2 rounded-lg border px-3 py-2 text-sm font-semibold ' + NOTICE_TONE[notice.kind]}
    >
      {notice.text}
    </p>
  )
}
