export const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'track', label: 'Track' },
  { id: 'tides', label: 'Tides' },
  { id: 'compass', label: 'Compass' },
  { id: 'convert', label: 'Convert' },
  { id: 'waypoints', label: 'Waypoints' },
  { id: 'team', label: 'Team' },
  { id: 'data', label: 'Data' },
] as const

export type TabId = (typeof TABS)[number]['id']

/**
 * The section switcher.
 *
 * Positioning is left to the footer stack in App, so the stamp button can sit
 * directly above this row and share one safe-area inset with it.
 */
export function TabBar({
  active,
  onChange,
}: {
  active: TabId
  onChange: (id: TabId) => void
}) {
  return (
    <nav aria-label="Sections">
      {/* Eight sections do not fit a narrow phone at a legible size, so the row
          scrolls rather than shrinking the labels to something unreadable. The
          browser keeps the active one in view. On a wider screen they divide
          the width evenly and nothing scrolls. */}
      <div className="no-scrollbar flex overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            aria-current={active === t.id ? 'page' : undefined}
            className={
              'min-w-[3.25rem] flex-1 border-t-2 px-1 py-2.5 text-[11px] font-semibold whitespace-nowrap transition-colors ' +
              (active === t.id
                ? 'border-sky-400 text-sky-300'
                : 'border-transparent text-slate-400 hover:text-slate-200')
            }
          >
            {t.label}
          </button>
        ))}
      </div>
    </nav>
  )
}
