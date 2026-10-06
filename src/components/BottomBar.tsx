import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LayoutGrid, X } from 'lucide-react'
import { useAdmin } from '@/store/useAdmin'
import { useIncidents } from '@/store/useIncidents'
import { useTeams } from '@/store/useTeams'
import { goTo, useBackDismiss, useSection } from '@/store/useSection'
import { StampWaypoint } from '@/components/StampWaypoint'
import {
  barTabFor,
  GROUP_ORDER,
  section,
  SECTIONS,
  shortLabel,
  type TabId,
} from '@/lib/sections'

/**
 * The bottom bar: the four places a crew goes most, either side of the stamp
 * button.
 *
 *   Home · Chart · [Stamp] · Search · More
 *
 * It replaces the drop-down menu in the top corner, which put every section
 * two taps and a read of a twelve-line list away — and put them at the top of
 * a phone held in one hand. Everything else is one tap into More, a grid of
 * every section by the job it belongs to.
 */
export function BottomBar() {
  const tab = useSection((s) => s.tab)
  const lastSearchStep = useSection((s) => s.lastSearchStep)
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const [moreOpen, setMoreOpen] = useState(false)
  const closeMore = useCallback(() => setMoreOpen(false), [])
  const lit = moreOpen ? 'more' : barTabFor(tab)

  // Search returns to the step the crew was last on; with no search open the
  // first step is opening one, and with one open it is the datum.
  const searchTarget: TabId = lastSearchStep ?? (incident ? 'datum' : 'incident')

  return (
    <nav aria-label="Sections" className="mx-auto grid max-w-3xl grid-cols-5 items-end px-1">
      <BarButton
        id="home"
        label="Home"
        lit={lit === 'home'}
        onClick={() => goTo('home')}
      />
      <BarButton
        id="chart"
        label="Chart"
        lit={lit === 'chart'}
        onClick={() => goTo('chart')}
      />
      <div className="h-14">
        <StampWaypoint />
      </div>
      <BarButton
        id="search"
        label="Search"
        lit={lit === 'search'}
        // A search is open: say so on the button that leads to it.
        dot={!!incident}
        onClick={() => goTo(searchTarget)}
      />
      <button
        onClick={() => setMoreOpen(true)}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-label="More — open the menu"
        className={barClass(lit === 'more')}
      >
        <LayoutGrid className="size-[22px]" aria-hidden />
        More
      </button>

      {moreOpen && <MoreMenu active={tab} onClose={closeMore} />}
    </nav>
  )
}

function barClass(lit: boolean) {
  return (
    'relative flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-semibold ' +
    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-400 ' +
    (lit ? 'text-sky-300' : 'text-slate-400 hover:text-slate-200')
  )
}

function BarButton({
  id,
  label,
  lit,
  dot = false,
  onClick,
}: {
  id: TabId
  label: string
  lit: boolean
  dot?: boolean
  onClick: () => void
}) {
  const Icon = section(id).icon
  return (
    <button
      onClick={onClick}
      aria-current={lit ? 'page' : undefined}
      className={barClass(lit)}
    >
      <span className="relative">
        <Icon className="size-[22px]" aria-hidden />
        {dot && (
          <span className="absolute -top-0.5 -right-1.5 size-2 rounded-full bg-emerald-400 ring-2 ring-navy-950" />
        )}
      </span>
      {label}
      {lit && <span className="absolute top-0 h-0.5 w-8 rounded-full bg-sky-400" />}
    </button>
  )
}

/**
 * Every section, as a grid of buttons grouped by job, rising from the bottom
 * where the More button is. Big square targets rather than a list of lines:
 * the icon is found before the word is read.
 */
function MoreMenu({ active, onClose }: { active: TabId; onClose: () => void }) {
  const isAdmin = useAdmin((s) => s.isAdmin)
  const panelRef = useRef<HTMLDivElement>(null)
  const sections = SECTIONS.filter((s) => !('adminOnly' in s) || isAdmin === true)

  useBackDismiss(true, onClose)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusTimer = window.setTimeout(
      () => panelRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus(),
      0,
    )
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(focusTimer)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        role="menu"
        aria-label="All sections"
        onClick={(e) => e.stopPropagation()}
        className="safe-bottom max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border-t border-white/10 bg-navy-900 px-3 pt-2 pb-3 shadow-2xl shadow-black/50"
      >
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-between pb-1">
            <span className="text-xs font-semibold tracking-wide text-slate-300 uppercase">
              All sections
            </span>
            <button
              onClick={onClose}
              aria-label="Close the menu"
              className="grid size-9 place-items-center rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>

          {GROUP_ORDER.map((group) => {
            const inGroup = sections.filter((s) => s.group === group)
            if (inGroup.length === 0) return null
            return (
              <div key={group} className="mt-2 first:mt-0">
                <div role="presentation" className="px-1 pb-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                  {group}
                </div>
                <ul className="grid grid-cols-4 gap-1.5">
                  {inGroup.map((s) => {
                    const Icon = s.icon
                    const here = s.id === active
                    return (
                      <li key={s.id} role="none">
                        <button
                          role="menuitem"
                          aria-current={here ? 'page' : undefined}
                          aria-label={s.label}
                          title={s.hint}
                          onClick={() => {
                            goTo(s.id)
                            onClose()
                          }}
                          className={
                            'flex h-[4.5rem] w-full flex-col items-center justify-center gap-1 rounded-xl border px-1 text-center transition-colors ' +
                            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' +
                            (here
                              ? 'border-sky-400/60 bg-sky-500/10 text-sky-300'
                              : 'border-white/10 bg-white/[0.03] text-slate-100 hover:bg-white/5')
                          }
                        >
                          <Icon className="size-6" aria-hidden />
                          <span className="text-[11px] leading-tight font-semibold">{shortLabel(s)}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
