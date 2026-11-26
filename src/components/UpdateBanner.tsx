import { Download } from 'lucide-react'
import { Button } from '@/components/ui'
import { useUpdate } from '@/store/useUpdate'

/** "A new version of NavMate is available" — Update now / Later. */
export function UpdateBanner() {
  const available = useUpdate((s) => s.available)
  const kind = useUpdate((s) => s.kind)
  const updateNow = useUpdate((s) => s.updateNow)
  const later = useUpdate((s) => s.later)
  if (!available) return null

  return (
    <div
      role="alertdialog"
      aria-labelledby="update-title"
      aria-describedby="update-body"
      className="fixed inset-x-3 top-3 z-[60] mx-auto max-w-md rounded-2xl border border-sky-400/40 bg-navy-900/95 p-4 shadow-2xl shadow-black/50 backdrop-blur"
      style={{ marginTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-start gap-3">
        <Download className="mt-0.5 size-5 shrink-0 text-sky-300" aria-hidden />
        <div className="min-w-0">
          <h2 id="update-title" className="text-sm font-semibold text-slate-50">
            A new version of NavMate is available
          </h2>
          <p id="update-body" className="mt-0.5 text-xs text-slate-300">
            {kind === 'native'
              ? 'Update now opens the download. Install it over this app — your saved waypoints and settings stay.'
              : 'Update now restarts NavMate on the new version. Anything waiting to sync is kept.'}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button onClick={later}>Later</Button>
        <Button variant="primary" onClick={updateNow}>
          Update now
        </Button>
      </div>
    </div>
  )
}
