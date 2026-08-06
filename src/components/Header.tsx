import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { useOnline } from '@/hooks/useOnline'
import { NavMenu, type TabId } from '@/components/NavMenu'
import { AccountButton } from '@/components/AccountButton'

export function Header({
  active,
  onChange,
}: {
  active: TabId
  onChange: (id: TabId) => void
}) {
  const { teams, activeTeamId, setActiveTeam } = useTeams()
  const watching = useTracker((s) => s.watching)
  const pending = useWaypoints((s) => s.pending.length)
  const online = useOnline()

  return (
    <header className="safe-top sticky top-0 z-30 border-b border-white/10 bg-navy-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 pb-2">
        {/* Emblem only up here — the wordmark would be unreadable at this
            size. The artwork has no field of its own, so it sits on the
            header's blur. Hidden on the narrowest screens, where the name
            and the two corner buttons need every pixel. */}
        <img
          src="/emblem-192.png"
          alt=""
          width={192}
          height={192}
          className="size-6 shrink-0 max-[379px]:hidden"
        />
        {/* NavMate is the field app; RescueGPS is the system it reports into.
            `min-w-0 truncate` lets the name give way to the status badges and
            the corner buttons rather than pushing them off a narrow phone. */}
        <span className="min-w-0 flex-1 truncate text-xs tracking-tight min-[360px]:text-sm sm:text-base">
          <span className="font-semibold text-slate-50">RescueGPS</span>{' '}
          <span className="font-medium text-sky-300">NavMate</span>
        </span>

        <div className="flex shrink-0 items-center gap-1.5">
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

          {/* The two corner controls: the account circle, then the menu in
              the very corner. */}
          <AccountButton />
          <NavMenu active={active} onChange={onChange} />
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
      </div>
    </header>
  )
}
