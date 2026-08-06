import { SupportRequests } from '@/components/SupportRequests'

/** Help is its own section: file a request, watch it get handled. */
export function HelpTab() {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Help</h2>
        <p className="text-sm text-slate-400">
          Anything you need from the platform admin — account changes, team
          problems, bugs — starts here.
        </p>
      </div>

      <SupportRequests />
    </div>
  )
}
