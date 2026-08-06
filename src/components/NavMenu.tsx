import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAdmin } from '@/store/useAdmin'

export const TABS = [
  { id: 'home', label: 'Home', hint: 'Position, daylight and nearby waypoints', group: 'Position' },
  { id: 'track', label: 'Live tracking', hint: 'Live position and your path', group: 'Position' },
  { id: 'compass', label: 'Compass', hint: 'Heading and bearings to waypoints', group: 'Position' },
  { id: 'convert', label: 'Convert', hint: 'Coordinate formats and UTM', group: 'Position' },
  { id: 'datum', label: 'Search datum', hint: 'LKP, drift, clues and where to search', group: 'Search' },
  { id: 'eta', label: 'ETA to waypoint', hint: 'Time to run, and 60 D = S × T', group: 'Search' },
  { id: 'tides', label: 'Tides', hint: 'High and low water near you', group: 'Search' },
  { id: 'waypoints', label: 'Waypoints', hint: 'Everything saved, with photos', group: 'Records' },
  { id: 'team', label: 'Team', hint: 'Members, join codes and roles', group: 'Records' },
  { id: 'data', label: 'Data', hint: 'Import, export and email', group: 'Records' },
  { id: 'help', label: 'Help / Contact', hint: 'Send the platform admin a request', group: 'Support' },
  // Only rendered for platform admins — and that is cosmetic; the database
  // enforces it whether or not the entry shows.
  { id: 'admin', label: 'Platform admin', hint: 'Metrics, requests and accounts', group: 'Support', adminOnly: true },
] as const

export type TabId = (typeof TABS)[number]['id']

const GROUP_ORDER = ['Position', 'Search', 'Records', 'Support'] as const

/**
 * The section menu: a button in the top corner of the header that drops a
 * panel down over the page.
 *
 * Twelve sections is too many to scan as one flat list — on a 390 px phone
 * that ran past the fold, so half the app was reachable only by scrolling a
 * menu. They are grouped by the job being done instead (where am I / running
 * the search / the record / support), and each row is one tap target sized for
 * a gloved thumb, so the whole thing fits a phone screen without scrolling.
 */
export function NavMenu({
  active,
  onChange,
}: {
  active: TabId
  onChange: (id: TabId) => void
}) {
  const [open, setOpen] = useState(false)
  const isAdmin = useAdmin((s) => s.isAdmin)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tabs = TABS.filter((t) => !('adminOnly' in t) || isAdmin === true)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Focus has to come back to the trigger, not be dropped on <body> — the
      // panel it was sitting in is about to be unmounted, and a keyboard user
      // would otherwise have to tab from the top of the page again.
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Move focus into the panel so a keyboard or screen-reader user lands on
    // the list rather than being left behind on the page underneath.
    const focusTimer = window.setTimeout(
      () => panelRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus(),
      0,
    )
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(focusTimer)
      document.body.style.overflow = previous
    }
  }, [open])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(true)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open the menu"
        className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 text-lg text-slate-200 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        ☰
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-40 bg-black/60"
            onClick={close}
            role="presentation"
          >
            <div
              ref={panelRef}
              role="menu"
              aria-label="Sections"
              onClick={(e) => e.stopPropagation()}
              className="safe-top max-h-[92vh] w-full overflow-y-auto rounded-b-2xl border-b border-white/10 bg-navy-900 px-3 pb-3 shadow-2xl shadow-black/50"
            >
              <div className="mx-auto max-w-3xl">
                <div className="flex items-center justify-between pt-2 pb-1.5">
                  <span className="text-xs font-semibold tracking-wide text-slate-300 uppercase">
                    Go to
                  </span>
                  <button
                    onClick={close}
                    aria-label="Close the menu"
                    className="grid size-8 place-items-center rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                  >
                    ✕
                  </button>
                </div>

                {GROUP_ORDER.map((group) => {
                  const inGroup = tabs.filter((t) => t.group === group)
                  if (inGroup.length === 0) return null
                  return (
                    <div key={group} className="mt-1.5 first:mt-0">
                      <div
                        role="presentation"
                        className="px-1 pb-1 text-[10px] font-semibold tracking-wider text-slate-400 uppercase"
                      >
                        {group}
                      </div>
                      <ul className="space-y-1">
                        {inGroup.map((t) => (
                          <li key={t.id} role="none">
                            <button
                              role="menuitem"
                              aria-current={t.id === active ? 'page' : undefined}
                              onClick={() => {
                                onChange(t.id)
                                close()
                              }}
                              className={
                                'flex min-h-11 w-full items-baseline gap-2 rounded-xl border px-3 py-2 text-left transition-colors ' +
                                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' +
                                (t.id === active
                                  ? 'border-sky-400/60 bg-sky-500/10'
                                  : 'border-white/10 hover:bg-white/5')
                              }
                            >
                              <span
                                className={
                                  'shrink-0 text-sm font-semibold ' +
                                  (t.id === active ? 'text-sky-300' : 'text-slate-100')
                                }
                              >
                                {t.label}
                              </span>
                              {/* The hint earns its place for discovery, but it
                                  is secondary — it shares the row rather than
                                  taking one of its own, and it is what gives
                                  way when the screen is narrow. */}
                              <span className="min-w-0 flex-1 truncate text-right text-[11px] text-slate-400">
                                {t.hint}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
