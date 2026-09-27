import { useNavCard } from '@/hooks/useNavCard'
import { navBannerView } from '@/lib/navView'

/**
 * The route, one line high, on every tab but the Chart tab.
 *
 * A crew checking the tide table or a teammate's waypoint mid-passage still
 * needs the next bearing and distance in view — the route no longer lives in
 * the Chart tab, and neither should the only place it is shown. Tap it to go
 * back to the full card and the map.
 */
export function NavBanner({ onOpen }: { onOpen: () => void }) {
  const v = useNavCard()
  if (!v) return null
  const b = navBannerView(v)
  const tone =
    b.tone === 'arrived'
      ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100'
      : b.tone === 'alert'
        ? 'border-amber-400/40 bg-amber-500/15 text-amber-100'
        : b.tone === 'stale'
          ? 'border-red-400/40 bg-red-500/10 text-slate-300'
          : 'border-sky-400/40 bg-sky-500/10 text-slate-50'
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open the route on the chart plotter"
      className={
        'mx-auto mb-1 flex min-h-11 w-[calc(100%-1.5rem)] max-w-3xl items-center justify-between gap-2 rounded-xl border px-3 py-1.5 text-left ' +
        tone
      }
    >
      <span className="min-w-0">
        <span className="tnum block truncate text-sm font-semibold">{b.primary}</span>
        {b.secondary && (
          <span className="tnum block truncate text-xs opacity-80">
            {b.tone === 'stale' ? 'GPS signal lost · ' : ''}
            {b.secondary}
          </span>
        )}
      </span>
      <span aria-hidden className="shrink-0 text-lg opacity-70">
        ›
      </span>
    </button>
  )
}
