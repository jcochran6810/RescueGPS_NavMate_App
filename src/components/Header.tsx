import { useAuth } from '@/store/useAuth'
import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { useOnline } from '@/hooks/useOnline'

export function Header() {
  const { profile, user, signOut } = useAuth()
  const { teams, activeTeamId, setActiveTeam } = useTeams()
  const watching = useTracker((s) => s.watching)
  const pending = useWaypoints((s) => s.pending.length)
  const online = useOnline()

  const who = profile?.callsign || profile?.full_name || user?.email || ''

  return (
    <header className="safe-top sticky top-0 z-30 border-b border-white/10 bg-navy-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 pb-2">
        {/* Emblem only up here — the wordmark would be unreadable at this
            size, and the row already competes with the team switcher. */}
        <img
          src="/icon-192.png"
          alt=""
          width={192}
          height={192}
          className="size-6 shrink-0 rounded"
        />
        <span className="font-semibold tracking-tight text-slate-50">
          RescueGPS
        </span>

        <div className="ml-auto flex items-center gap-2">
          {!online && (
            <span className="rounded-full bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-300">
              Offline
            </span>
          )}
          {pending > 0 && (
            <span
              title={`${pending} change${pending === 1 ? '' : 's'} waiting to sync`}
              className="rounded-full bg-sky-500/15 px-2 py-1 text-[11px] font-semibold text-sky-300"
            >
              {pending} queued
            </span>
          )}
          <span
            className={
              'rounded-full px-2 py-1 text-[11px] font-semibold ' +
              (watching
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-white/5 text-slate-400')
            }
          >
            GPS {watching ? 'live' : 'off'}
          </span>
        </div>
      </div>

      <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 pb-2">
        <label className="sr-only" htmlFor="team-switcher">
          Active team
        </label>
        <select
          id="team-switcher"
          value={activeTeamId ?? ''}
          onChange={(e) => setActiveTeam(e.target.value || null)}
          className="min-h-9 flex-1 rounded-lg border border-white/10 bg-navy-900 px-2 text-sm text-slate-200 focus:border-sky-400/60 focus:outline-none"
        >
          <option value="">Private — only me</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        <span className="max-w-[9rem] truncate text-xs text-slate-400">
          {who}
        </span>
        <button
          onClick={() => void signOut()}
          className="rounded-lg border border-white/10 px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5"
        >
          Sign out
        </button>
      </div>
    </header>
  )
}
