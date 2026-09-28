import { useTeams } from '@/store/useTeams'
import { useTracker } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { useOnline } from '@/hooks/useOnline'
import { useClock } from '@/hooks/useNow'
import { gpsChip, type GpsChip as GpsChipState } from '@/lib/navView'
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
          <GpsChip />

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

const CHIP_TONE: Record<GpsChipState['kind'], string> = {
  live: 'bg-emerald-500/15 text-emerald-300',
  lost: 'bg-red-500/15 text-red-300',
  fix: 'bg-sky-500/15 text-sky-300',
  off: 'bg-white/5 text-slate-300',
}

/**
 * The GPS badge. Four states, not two: a running watch that has had no fix
 * for 15 s is "GPS lost" — the same test the steering card greys itself on —
 * where it used to stay green "GPS live" beside a card saying the signal was
 * gone. And the badge no longer reads "GPS off" above a fix taken by hand on
 * the Home screen: a fix in hand with no watch running is "GPS fix".
 *
 * Its own component, ticking once a second, so a fix that STOPS arriving is
 * shown without re-rendering the whole header.
 */
function GpsChip() {
  const watching = useTracker((s) => s.watching)
  const fix = useTracker((s) => s.fix)
  // The same clock the steering card reads, so the two never disagree.
  const now = useClock()
  const chip = gpsChip(watching, fix, now)
  return (
    <span
      title={chip.title}
      className={'rounded-full px-2 py-1 text-[11px] font-semibold ' + CHIP_TONE[chip.kind]}
    >
      {chip.label}
    </span>
  )
}
