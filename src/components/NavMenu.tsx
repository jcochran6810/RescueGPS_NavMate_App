import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAdmin } from '@/store/useAdmin'

export const TABS = [
  { id: 'home', label: 'Home', hint: 'Position, daylight and nearby waypoints' },
  { id: 'datum', label: 'Search datum', hint: 'LKP, drift, clues and where to search' },
  { id: 'track', label: 'Live tracking', hint: 'Live position and your path' },
  { id: 'eta', label: 'ETA to waypoint', hint: 'Distance, bearing, time and 60 D = S × T' },
  { id: 'tides', label: 'Tides', hint: 'High and low water near you' },
  { id: 'compass', label: 'Compass', hint: 'Heading and bearings to waypoints' },
  { id: 'convert', label: 'Convert', hint: 'Coordinate formats and UTM' },
  { id: 'waypoints', label: 'Waypoints', hint: 'Everything saved, with photos' },
  { id: 'team', label: 'Team', hint: 'Members, join codes and roles' },
  { id: 'data', label: 'Data', hint: 'Import, export and email' },
  { id: 'help', label: 'Help / Contact', hint: 'Send the platform admin a request' },
  // Only rendered for platform admins — and that is cosmetic; the database
  // enforces it whether or not the entry shows.
  { id: 'admin', label: 'Platform admin', hint: 'Metrics, requests and accounts', adminOnly: true },
] as const

export type TabId = (typeof TABS)[number]['id']

/**
 * The section menu: a button in the top corner of the header that drops a
 * panel down over the page, with an explicit ✕ to close it. Escape and a tap
 * on the backdrop close it too, but the ✕ is always there — a visible way
 * out beats a convention someone may not know.
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
  const tabs = TABS.filter((t) => !('adminOnly' in t) || isAdmin === true)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open the menu"
        className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 text-lg text-slate-200 hover:bg-white/5"
      >
        ☰
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-40 bg-black/60"
            onClick={() => setOpen(false)}
            role="presentation"
          >
            <div
              role="menu"
              aria-label="Sections"
              onClick={(e) => e.stopPropagation()}
              className="safe-top max-h-[85vh] w-full overflow-y-auto rounded-b-2xl border-b border-white/10 bg-navy-900 px-4 pb-4 shadow-2xl shadow-black/50"
            >
              <div className="mx-auto max-w-3xl">
                <div className="flex items-center justify-between pt-3 pb-2">
                  <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                    Go to
                  </span>
                  <div className="flex items-center gap-1.5">
                    {/* Two ways to put the panel away, both visible: collapse
                        it back up, or close it outright. Same result. */}
                    <button
                      onClick={() => setOpen(false)}
                      aria-label="Collapse the menu"
                      className="grid size-8 place-items-center rounded-lg border border-white/10 text-slate-300 hover:bg-white/5"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => setOpen(false)}
                      aria-label="Close the menu"
                      className="grid size-8 place-items-center rounded-lg border border-white/10 text-slate-300 hover:bg-white/5"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <ul className="space-y-1">
                  {tabs.map((t) => (
                    <li key={t.id} role="none">
                      <button
                        role="menuitem"
                        aria-current={t.id === active ? 'page' : undefined}
                        onClick={() => {
                          onChange(t.id)
                          setOpen(false)
                        }}
                        className={
                          'w-full rounded-xl border px-3 py-2.5 text-left transition-colors ' +
                          (t.id === active
                            ? 'border-sky-400/60 bg-sky-500/10'
                            : 'border-white/10 hover:bg-white/5')
                        }
                      >
                        <span
                          className={
                            'block text-sm font-semibold ' +
                            (t.id === active ? 'text-sky-300' : 'text-slate-100')
                          }
                        >
                          {t.label}
                        </span>
                        <span className="block text-xs text-slate-500">{t.hint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
