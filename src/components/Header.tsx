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
  const fix = useTracker((s) => s.fix)
  const pending = useWaypoints((s) => s.pending.length)
  const online = useOnline()

  // Three states, not two. The badge used to read "GPS off" whenever the
  // continuous watch was stopped — including on the Home screen, which takes a
  // single fix and prints the position right underneath. Saying the GPS is off
  // above a live set of coordinates teaches a crew to distrust the badge, so it
  // now distinguishes a running watch from a fix already in hand.
  const gps = watching
    ? { label: 'GPS live', tone: 'bg-emerald-500/15 text-emerald-300' }
    : fix
      ? { label: 'GPS fix', tone: 'bg-sky-500/15 text-sky-300' }
      : { label: 'GPS off', tone: 'bg-white/5 text-slate-300' }

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
        {/* NavMate is the field app and stands on its own name now that it has
            its own address; RescueGPS is the command system it reports into,
            at rescuegps.stationinsight.com. The emblem beside this is the
            shared mark, which is what still ties the two together.
            `min-w-0 truncate` lets the name give way to the status badges and
            the corner buttons rather than pushing them off a narrow phone. */}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-slate-50 sm:text-base">
          NavMate
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
            title={
              watching
                ? 'Recording a continuous track'
                : fix
                  ? 'A position fix is in hand; the continuous track is not running'
                  : 'No position yet'
            }
            className={'rounded-full px-2 py-1 text-[11px] font-semibold ' + gps.tone}
          >
            {gps.label}
          </span>

          {/* The two corner controls: the account circle, then the menu in
              the very corner. */}
          <AccountButton />
          <NavMenu active={active} onChange={onChange} />
        </div>
      </div>

      {/* The scope switcher only appears once there is something to switch
          between. On a solo account it was a full-width control with exactly
          one option, costing a row of the header on every screen to say
          nothing — and vertical space on a phone held one-handed in the field
          is the scarcest thing this layout has. */}
      {teams.length > 0 && (
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
      )}
    </header>
  )
}
