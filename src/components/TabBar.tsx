export const TABS = [
  { id: 'convert', label: 'Convert' },
  { id: 'track', label: 'Track' },
  { id: 'waypoints', label: 'Waypoints' },
  { id: 'team', label: 'Team' },
  { id: 'data', label: 'Data' },
] as const

export type TabId = (typeof TABS)[number]['id']

export function TabBar({
  active,
  onChange,
}: {
  active: TabId
  onChange: (id: TabId) => void
}) {
  return (
    <nav
      aria-label="Sections"
      className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-navy-950/95 backdrop-blur"
    >
      <div className="mx-auto flex max-w-3xl">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            aria-current={active === t.id ? 'page' : undefined}
            className={
              'flex-1 border-t-2 px-1 py-2.5 text-xs font-semibold transition-colors ' +
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
