import { useEffect, useMemo, useRef, useState } from 'react'
import { Sheet } from '@/components/Sheet'
import { CoordInput } from '@/components/CoordInput'
import { Button } from '@/components/ui'
import { canCreate, endLabel, type PickMethod, type PlanPlace } from '@/lib/planCourse'
import { formatPlace } from '@/lib/placeText'
import { useCoordFormat } from '@/store/useCoordFormat'
import { usePlanCourse } from '@/store/usePlanCourse'
import { CourseEndRow, EndBadge } from '@/components/CourseEnds'
import { endText } from '@/lib/courseEnds'
import { Bookmark, Keyboard, LocateFixed, Map as MapIcon, Route, type LucideIcon } from 'lucide-react'

export interface WaypointChoice {
  id: string
  name: string
  lat: number
  lon: number
}

const START_WAYS: { id: PickMethod; label: string; hint: string; icon: LucideIcon }[] = [
  { id: 'here', label: 'Use my current location', hint: 'The route starts from the boat, and follows the GPS', icon: LocateFixed },
  { id: 'map', label: 'Choose on map', hint: 'Tap the chart, then confirm', icon: MapIcon },
  { id: 'coords', label: 'Enter coordinates', hint: 'In your coordinate format', icon: Keyboard },
  { id: 'waypoint', label: 'Select a saved waypoint', hint: 'From this team’s waypoints', icon: Bookmark },
]
const DEST_WAYS = START_WAYS.filter((w) => w.id !== 'here').map((w) =>
  w.id === 'map' ? { ...w, label: 'Choose destination on map' } : w,
)

/**
 * "Plan a course" — the stepper sheet (see `lib/planCourse.ts`).
 *
 * Hidden while a point is being picked on the chart (`method === 'map'`):
 * the chart is what the crew is looking at then, and the plotter shows the
 * pin, its coordinates and Confirm under it (`PlanCoursePickBar`).
 */
export function PlanCourseSheet({
  waypoints,
  hasFix,
  onCreate,
  onOpenSaved,
}: {
  waypoints: WaypointChoice[]
  hasFix: boolean
  /** Plan it: the destination, and the start (null = my live position). */
  onCreate: (dest: PlanPlace, origin: PlanPlace | null) => void
  /** "Open a saved route" — omitted when there are none. */
  onOpenSaved?: () => void
}) {
  const s = usePlanCourse()
  const dispatch = s.dispatch
  const format = useCoordFormat((f) => f.format)
  const [draft, setDraft] = useState({ lat: NaN, lon: NaN })
  const [query, setQuery] = useState('')
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (q ? waypoints.filter((w) => w.name.toLowerCase().includes(q)) : waypoints).slice(0, 60)
  }, [waypoints, query])

  if (!s.open || s.method === 'map') return null

  const stepNo = s.step === 'start' ? 1 : s.step === 'dest' ? 2 : 3
  const title =
    s.step === 'start' ? 'Starting point' : s.step === 'dest' ? 'Destination' : 'Ready to plan'
  const ways = s.step === 'start' ? START_WAYS : DEST_WAYS
  const stepEnd = s.step === 'start' ? 'start' : 'dest'
  const startText = endLabel(s.start)
  const destText = endLabel(s.dest)

  const choose = (m: PickMethod) => {
    if (m === 'here') {
      dispatch({ type: 'here', hasFix })
      return
    }
    setDraft({ lat: NaN, lon: NaN })
    setQuery('')
    dispatch({ type: 'method', method: m })
  }

  return (
    <Sheet label="Plan a course" onDismiss={() => dispatch({ type: 'cancel' })}>
      <div className="mb-3">
        <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
          {`Plan a course · step ${Math.min(stepNo, 2)} of 2`}
        </p>
        <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-50">
          {s.step !== 'review' ? <EndBadge end={stepEnd} /> : null}
          {title}
        </h3>
      </div>

      {/* What is chosen so far, A and B in their own colours, each tappable
          to change — set apart from the ways to choose below. */}
      <div className="mb-3 grid gap-1.5">
        <CourseEndRow
          end="start"
          value={startText}
          detail={s.start?.kind === 'place' ? formatPlace(s.start.place, format) : null}
          active={s.step === 'start'}
          onClick={startText && s.step !== 'start' ? () => dispatch({ type: 'change', end: 'start' }) : undefined}
          actionLabel="Change the starting point"
        />
        <CourseEndRow
          end="dest"
          value={destText}
          detail={s.dest ? formatPlace(s.dest.place, format) : null}
          active={s.step === 'dest'}
          onClick={destText && s.step !== 'dest' ? () => dispatch({ type: 'change', end: 'dest' }) : undefined}
          actionLabel="Change the destination"
        />
      </div>

      {s.error ? (
        <p role="alert" className="mb-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {s.error}
        </p>
      ) : null}

      {s.step !== 'review' && s.method === null ? (
        <div className="grid gap-1.5" role="group" aria-label={`Ways to set the ${title.toLowerCase()}`}>
          <p className={'text-sm font-semibold ' + endText(stepEnd)}>
            {s.step === 'start' ? 'Where does the course start?' : 'Where are you going?'}
          </p>
          {ways.map((w) => {
            const Icon = w.icon
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => choose(w.id)}
                disabled={w.id === 'waypoint' && waypoints.length === 0}
                className="flex min-h-12 w-full items-center gap-3 rounded-xl bg-white/[0.06] px-3 py-2 text-left hover:bg-white/10 disabled:opacity-50"
              >
                <Icon className={'size-5 shrink-0 ' + endText(stepEnd)} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-100">{w.label}</span>
                  <span className="block text-xs text-slate-400">
                    {w.id === 'waypoint' && waypoints.length === 0 ? 'No saved waypoints in this scope yet' : w.hint}
                  </span>
                </span>
              </button>
            )
          })}
          {s.step === 'start' && onOpenSaved ? (
            <button
              type="button"
              onClick={onOpenSaved}
              className="min-h-12 w-full rounded-xl border border-dashed border-white/15 px-3 py-2 text-left hover:bg-white/5"
            >
              <span className="block text-sm font-semibold text-slate-100">Open a saved route</span>
              <span className="block text-xs text-slate-400">Re-checked for your boat before it can be steered</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {s.method === 'coords' ? (
        <div>
          <CoordInput
            label={s.step === 'start' ? 'Starting point' : 'Destination'}
            value={draft}
            onChange={setDraft}
          />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => dispatch({ type: 'back' })}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={!Number.isFinite(draft.lat) || !Number.isFinite(draft.lon)}
              onClick={() => dispatch({ type: 'coords', lat: draft.lat, lon: draft.lon })}
            >
              Use this position
            </Button>
          </div>
        </div>
      ) : null}

      {s.method === 'waypoint' ? (
        <div>
          <label className="block text-xs font-semibold text-slate-300" htmlFor="plan-wp-search">
            Search waypoints
          </label>
          <input
            id="plan-wp-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name"
            className="mt-1 mb-2 w-full min-w-0 rounded-lg border border-white/15 bg-navy-950 px-3 py-2 text-base text-slate-50"
          />
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {found.length === 0 ? (
              <p className="text-sm text-slate-400">No waypoint matches.</p>
            ) : (
              found.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => dispatch({ type: 'waypoint', place: { lat: w.lat, lon: w.lon, label: w.name } })}
                  className="min-h-11 w-full rounded-lg border border-white/10 px-3 py-2 text-left hover:bg-white/5"
                >
                  <span className="block truncate text-sm text-slate-100">{w.name}</span>
                  <span className="tnum block truncate text-xs text-slate-400">{formatPlace(w, format)}</span>
                </button>
              ))
            )}
          </div>
          <Button variant="ghost" className="mt-2 w-full" onClick={() => dispatch({ type: 'back' })}>
            Back
          </Button>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={() => dispatch({ type: 'cancel' })}>
          Cancel
        </Button>
        {canCreate(s) ? (
          <Button
            variant="primary"
            className="min-h-12 text-base"
            onClick={() => {
              const dest = s.dest!.place
              const origin = s.start!.kind === 'here' ? null : s.start!.place
              dispatch({ type: 'cancel' })
              onCreate(dest, origin)
            }}
          >
            <Route className="size-5" aria-hidden />
            Create route
          </Button>
        ) : (
          <Button variant="ghost" disabled={s.step === 'start' && s.method === null} onClick={() => dispatch({ type: 'back' })}>
            Back
          </Button>
        )}
      </div>
    </Sheet>
  )
}

/**
 * Under the chart while a point is being picked for the plan: what to do,
 * the pin's coordinates, Confirm — and a way back to the sheet.
 */
export function PlanCoursePickBar() {
  const s = usePlanCourse()
  const format = useCoordFormat((f) => f.format)
  const picking = s.open && s.method === 'map'
  const ref = useRef<HTMLDivElement>(null)
  // The sheet steps aside for the pick: bring the chart and Confirm into view
  // together (on a phone the bar is otherwise below the fold, under the
  // "Stamp my position" bar — hence the bottom scroll margin).
  useEffect(() => {
    if (picking) ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [picking])
  if (!picking) return null
  const end = s.step === 'start' ? 'start' : 'dest'
  return (
    <div
      ref={ref}
      className={
        'mb-2 scroll-mt-16 rounded-xl border-2 px-3 py-2 ' +
        (end === 'start' ? 'border-emerald-400/50 bg-emerald-500/10' : 'border-violet-400/50 bg-violet-500/10')
      }
      role="region"
      aria-label="Pick a point on the chart"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-50">
        <EndBadge end={end} />
        {s.pending
          ? s.step === 'start'
            ? 'Starting point here?'
            : 'Destination here?'
          : s.step === 'start'
            ? 'Tap the chart where you are starting from'
            : 'Tap the chart where you want to go'}
      </p>
      {s.pending ? <p className="tnum text-xs text-slate-300">{formatPlace(s.pending, format)}</p> : null}
      {s.error ? (
        <p role="alert" className="text-xs text-amber-200">
          {s.error}
        </p>
      ) : null}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button variant="ghost" onClick={() => s.dispatch({ type: 'back' })}>
          Back
        </Button>
        <Button variant="primary" disabled={!s.pending} onClick={() => s.dispatch({ type: 'confirm-pick' })}>
          Confirm
        </Button>
      </div>
    </div>
  )
}
