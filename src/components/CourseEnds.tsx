import { ChevronRight } from 'lucide-react'
import { END_STYLE, type CourseEnd } from '@/lib/courseEnds'

/**
 * The two ends of a course, drawn the same way everywhere they appear — the
 * plotter, the Plan a course sheet and the bar under the chart while a point
 * is being picked: a lettered badge in a colour of its own, **A** green for
 * where the course starts and **B** violet for where it goes.
 *
 * They used to be a grey caption and a line of text, the same as every other
 * row on the screen, so the two things a crew sets to get a course blended
 * into the options around them. The colours are chosen to stay clear of the
 * route's own (sky = the route, amber = check by eye, red = not safe).
 */
export function EndBadge({ end, className = '' }: { end: CourseEnd; className?: string }) {
  const s = END_STYLE[end]
  return (
    <span
      aria-hidden
      className={
        'grid size-7 shrink-0 place-items-center rounded-full text-sm font-bold ' + s.badge + ' ' + className
      }
    >
      {s.letter}
    </span>
  )
}

/**
 * One end of the course as a single big button: the badge, what it is, where
 * it is, and a chevron saying the whole row changes it. Unset, it is a dashed
 * call to action in the end's own colour rather than a "Not set" that reads
 * like a value.
 */
export function CourseEndRow({
  end,
  value,
  detail,
  active = false,
  onClick,
  actionLabel,
}: {
  end: CourseEnd
  /** What it is set to; null when it is not set yet. */
  value: string | null
  /** The position, in the crew's coordinate format. */
  detail?: string | null
  /** The end being set right now (the sheet's current step). */
  active?: boolean
  onClick?: () => void
  /** Accessible name — "Change the starting point", "Set the destination". */
  actionLabel: string
}) {
  const s = END_STYLE[end]
  const caption = end === 'start' ? 'From' : 'To'
  const body = (
    <>
      <EndBadge end={end} />
      <span className="min-w-0 flex-1">
        <span className={'block text-[10px] font-semibold tracking-wider uppercase ' + s.text}>
          {caption}
        </span>
        {value ? (
          <span className="block truncate text-base font-semibold text-slate-50">{value}</span>
        ) : (
          <span className={'block text-base font-semibold ' + s.text}>
            {end === 'start' ? 'Set the starting point' : 'Set the destination'}
          </span>
        )}
        {value && detail ? (
          <span className="tnum block truncate text-xs text-slate-300">{detail}</span>
        ) : null}
      </span>
      {onClick ? (
        <span className={'flex shrink-0 items-center text-xs font-semibold ' + s.text}>
          {value ? 'Change' : null}
          <ChevronRight className="size-5" aria-hidden />
        </span>
      ) : null}
    </>
  )
  const cls =
    'flex min-h-16 w-full min-w-0 items-center gap-3 rounded-xl border-2 px-3 py-2 text-left ' +
    (value ? (active ? s.ring : 'border-white/15 bg-navy-950/40') : 'border-dashed ' + s.ring) +
    (onClick ? ' hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400' : '')
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={value ? `${actionLabel} — ${caption} ${value}` : actionLabel}
      className={cls}
    >
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}
