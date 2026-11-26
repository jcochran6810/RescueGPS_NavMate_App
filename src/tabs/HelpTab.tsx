import { SupportRequests } from '@/components/SupportRequests'
import { InstallCard } from '@/components/InstallCard'
import { versionLabel } from '@/lib/version'
import { isNativeApp } from '@/lib/native'

/** Help is its own section: file a request, watch it get handled. */
export function HelpTab() {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Help</h2>
        <p className="text-sm text-slate-300">
          Anything you need from the platform admin — account changes, team
          problems, bugs — starts here.
        </p>
      </div>

      <InstallCard />

      <SupportRequests />

      <p className="text-center text-xs text-slate-400">
        NavMate {isNativeApp() ? 'for Android' : 'web app'} · {versionLabel()}
      </p>
    </div>
  )
}
