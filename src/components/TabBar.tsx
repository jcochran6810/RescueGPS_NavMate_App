import { useState } from 'react'
import { Sheet } from '@/components/Sheet'
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
  // Only rendered for platform admins — and that is cosmetic; the database
  // enforces it whether or not the entry shows.
  { id: 'admin', label: 'Platform admin', hint: 'Metrics, requests and accounts', adminOnly: true },
] as const

export type TabId = (typeof TABS)[number]['id']

/**
 * The section switcher.
 *
 * A row of tabs stopped working once there were eight sections: at the width
 * of a phone they either scrolled, hiding half of them off the edge, or shrank
 * the labels past reading. A single control naming the current section, opening
 * a list of the rest, fits any width and gives each entry a target big enough
 * for a gloved thumb.
 *
 * Positioning is left to the footer stack in App, so the stamp button sits
 * directly above this and the two share one safe-area inset.
 */
export function TabBar({
  active,
  onChange,
}: {
  active: TabId
  onChange: (id: TabId) => void
}) {
  const [open, setOpen] = useState(false)
  const isAdmin = useAdmin((s) => s.isAdmin)
  const tabs = TABS.filter((t) => !('adminOnly' in t) || isAdmin === true)
  const current = TABS.find((t) => t.id === active) ?? TABS[0]

  return (
    <nav aria-label="Sections" className="px-3 pt-2">
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-white/10 bg-navy-900/80 px-3 text-left text-sm font-semibold text-slate-100 hover:bg-white/5"
      >
        <span aria-hidden="true" className="text-slate-400">
          ☰
        </span>
        <span className="flex-1 truncate">{current.label}</span>
        <span aria-hidden="true" className="text-slate-400">
          ▲
        </span>
      </button>

      {open && (
        <Sheet label="Choose a section" onDismiss={() => setOpen(false)}>
          <span className="mb-1.5 block text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Go to
          </span>
          <ul role="menu" className="space-y-1 pb-1">
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
        </Sheet>
      )}
    </nav>
  )
}
