import { useMemo } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { useIncidents } from '@/store/useIncidents'
import { useSarRecords } from '@/store/useSarRecords'
import { useTeams } from '@/store/useTeams'
import { goTo } from '@/store/useSection'
import { recordsForSearch } from '@/lib/incident'
import { section, SEARCH_STEPS, shortLabel, type SearchStep } from '@/lib/sections'

/** What the search has so far — which steps are done. */
function useSearchProgress() {
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const visible = useSarRecords((s) => s.visible)
  const all = visible()
  const records = useMemo(
    () => recordsForSearch(all, activeTeamId, incident?.id ?? null),
    [all, activeTeamId, incident?.id],
  )
  const hasLkp = records.some((r) => r.kind === 'lkp')
  const clues = records.filter((r) => r.kind === 'clue').length
  return { incident, hasLkp, clues }
}

/**
 * The search as four steps across the top of each of its screens:
 *
 *   ① Incident → ② Datum → ③ Pattern → ④ Clues
 *
 * Where the crew is, what is done, and one tap to any other step. The steps
 * are a guide, not a gate: a crew can log an LKP before anyone has opened an
 * incident (that is the real order on the water, and the incident adopts it).
 */
export function SearchSteps({ current }: { current: SearchStep }) {
  const { incident, hasLkp, clues } = useSearchProgress()
  const done: Record<SearchStep, boolean> = {
    incident: !!incident,
    datum: hasLkp,
    search: false,
    clues: clues > 0,
  }

  return (
    <nav aria-label="Search steps">
      <ol className="grid grid-cols-4 gap-1">
        {SEARCH_STEPS.map((id, i) => {
          const here = id === current
          const s = section(id)
          return (
            <li key={id}>
              <button
                onClick={() => goTo(id)}
                aria-current={here ? 'step' : undefined}
                className={
                  'flex min-h-12 w-full flex-col items-center justify-center gap-0.5 rounded-xl border px-1 py-1 text-[11px] font-semibold transition-colors ' +
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' +
                  (here
                    ? 'border-sky-400/60 bg-sky-500/15 text-sky-200'
                    : 'border-white/10 text-slate-300 hover:bg-white/5')
                }
              >
                <span
                  className={
                    'grid size-5 place-items-center rounded-full text-[10px] font-bold ' +
                    (done[id]
                      ? 'bg-emerald-500 text-navy-950'
                      : here
                        ? 'bg-sky-400 text-navy-950'
                        : 'bg-white/10 text-slate-300')
                  }
                  aria-hidden
                >
                  {done[id] ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                <span>
                  {shortLabel(s)}
                  {id === 'clues' && clues > 0 ? ` (${clues})` : ''}
                </span>
                {done[id] && <span className="sr-only">(done)</span>}
              </button>
            </li>
          )
        })}
      </ol>
      {incident && (
        <p className="mt-1.5 truncate text-center text-[11px] text-slate-400">
          On search{' '}
          <span className="font-semibold text-slate-200">{incident.incident_number}</span>
        </p>
      )}
    </nav>
  )
}

const NEXT: Record<SearchStep, { to: SearchStep; label: string }> = {
  incident: { to: 'datum', label: 'Next: set the search datum' },
  datum: { to: 'search', label: 'Next: run a search pattern' },
  search: { to: 'clues', label: 'Next: log a clue' },
  clues: { to: 'search', label: 'Back to the search pattern' },
}

/** The one button at the foot of each step that moves the search on. */
export function NextStep({ current }: { current: SearchStep }) {
  const next = NEXT[current]
  return (
    <button
      onClick={() => goTo(next.to)}
      className="flex min-h-12 w-full items-center justify-between gap-2 rounded-xl border border-sky-400/40 bg-sky-500/10 px-4 text-sm font-semibold text-sky-200 hover:bg-sky-500/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
    >
      {next.label}
      <ArrowRight className="size-4" aria-hidden />
    </button>
  )
}
