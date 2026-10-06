import { useEffect } from 'react'
import { useFormat } from '@/hooks/useFormat'
import { useTracker } from '@/store/useTracker'
import { toDD, toDDM, toDMS } from '@/lib/coords'
import { DaylightTracker } from '@/components/DaylightTracker'
import { NearbyWaypoints } from '@/components/NearbyWaypoints'
import { Card, Label } from '@/components/ui'
import { usePlanCourse } from '@/store/usePlanCourse'
import { useNavigation } from '@/store/useNavigation'
import { useIncidents } from '@/store/useIncidents'
import { useTeams } from '@/store/useTeams'
import { useSection } from '@/store/useSection'
import { section, shortLabel, type TabId } from '@/lib/sections'
import { LifeBuoy, Navigation, Route, type LucideIcon } from 'lucide-react'

/** Home's tool tiles: everything a crew reaches for that is not a search step. */
const TOOLS = [
  'compass',
  'track',
  'waypoints',
  'tides',
  'eta',
  'convert',
  'team',
  'settings',
] as const satisfies readonly TabId[]

/**
 * The screen the app opens on: where you are, what the light and the water are
 * doing, which way you are pointing, and what you have saved nearby.
 *
 * Everything here is derived from one position fix, so the fix is taken once
 * on arrival rather than making the crew press something before the screen
 * says anything useful.
 */
export function HomeTab({ onNavigate }: { onNavigate: (tab: TabId) => void }) {
  const { fix, watching, error, once } = useTracker()

  useEffect(() => {
    if (!fix && !watching) void once()
  }, [fix, watching, once])

  const fmt = useFormat()
  const planCourse = usePlanCourse((s) => s.dispatch)
  const navStatus = useNavigation((s) => s.status)
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))
  const lastSearchStep = useSection((s) => s.lastSearchStep)
  const lat = fix?.lat ?? null
  const lon = fix?.lon ?? null

  return (
    <div className="space-y-3">
      {/* Every other section opens with a visible h2; Home had no heading at
          all, so a screen reader moving by headings fell straight into the
          position card with nothing naming the screen. It is hidden rather
          than drawn because this is the screen the app opens on, and a title
          bar would push the position itself further down the phone. */}
      <h2 className="sr-only">Home — position, daylight and nearby waypoints</h2>

      {error && (
        <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <Card>
        <div className="flex items-start justify-between gap-2">
          <Label>Current position</Label>
          <button
            onClick={() => void once()}
            className="mb-1.5 flex min-h-9 items-center rounded-lg border border-white/10 px-2.5 text-xs text-slate-300 hover:bg-white/5"
          >
            Refresh
          </button>
        </div>

        {fix ? (
          <div className="tnum space-y-0.5 text-sm text-slate-200">
            <div>
              <span className="text-slate-400">DDM </span>
              {toDDM(fix.lat, 'lat')}, {toDDM(fix.lon, 'lon')}
            </div>
            <div>
              <span className="text-slate-400">DMS </span>
              {toDMS(fix.lat, 'lat')}, {toDMS(fix.lon, 'lon')}
            </div>
            <div>
              <span className="text-slate-400">DD </span>
              {toDD(fix.lat)}, {toDD(fix.lon)}
            </div>
            <div className="text-slate-300">
              {fix.altitude != null ? `Altitude ${Math.round(fix.altitude)} m` : 'Altitude —'}
              {' | '}
              Speed {fmt.speed(fix.speed)}
              {fix.accuracy != null ? ` | ±${Math.round(fix.accuracy)} m` : ''}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-300">
            Waiting for a GPS fix…
          </p>
        )}
      </Card>

      {/* The two jobs this app exists for, as the two biggest buttons on the
          first screen: get somewhere, and look for someone. */}
      <div className="grid grid-cols-2 gap-2">
        {navStatus === 'navigating' ? (
          <BigAction
            icon={Navigation}
            title="Steering"
            detail="Back to the course"
            tone="primary"
            onClick={() => onNavigate('chart')}
          />
        ) : (
          <BigAction
            icon={Route}
            title="Plan a course"
            detail="Route on the chart"
            tone="primary"
            onClick={() => {
              planCourse({ type: 'open' })
              onNavigate('chart')
            }}
          />
        )}
        {incident ? (
          <BigAction
            icon={LifeBuoy}
            title="Continue search"
            detail={incident.incident_number}
            tone="search"
            onClick={() => onNavigate(lastSearchStep ?? 'datum')}
          />
        ) : (
          <BigAction
            icon={LifeBuoy}
            title="Start a search"
            detail="Open or join an incident"
            tone="search"
            onClick={() => onNavigate('incident')}
          />
        )}
      </div>

      {/* Every tool one tap away, by its picture — no menu to open and read. */}
      <nav aria-label="Tools">
        <ul className="grid grid-cols-4 gap-1.5">
          {TOOLS.map((id) => {
            const s = section(id)
            const Icon = s.icon
            return (
              <li key={id}>
                <button
                  onClick={() => onNavigate(id)}
                  title={s.hint}
                  className="flex h-[4.5rem] w-full flex-col items-center justify-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] px-1 text-slate-100 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                >
                  <Icon className="size-6 text-sky-300" aria-hidden />
                  <span className="text-[11px] leading-tight font-semibold">{shortLabel(s)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <DaylightTracker lat={lat} lon={lon} />

      <NearbyWaypoints
        lat={lat}
        lon={lon}
        onSeeAll={() => onNavigate('waypoints')}
      />
    </div>
  )
}

function BigAction({
  icon: Icon,
  title,
  detail,
  tone,
  onClick,
}: {
  icon: LucideIcon
  title: string
  detail: string
  tone: 'primary' | 'search'
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={
        'flex min-h-20 flex-col items-start justify-center gap-1 rounded-2xl px-3 py-2.5 text-left transition-colors ' +
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ' +
        (tone === 'primary'
          ? 'bg-sky-500 text-navy-950 hover:bg-sky-400 active:bg-sky-600'
          : 'border border-orange-400/40 bg-orange-500/15 text-orange-100 hover:bg-orange-500/20')
      }
    >
      <Icon className="size-6" aria-hidden />
      <span className="text-base leading-tight font-semibold">{title}</span>
      <span
        className={
          'max-w-full truncate text-xs ' +
          (tone === 'primary' ? 'text-navy-950/80' : 'text-orange-200/90')
        }
      >
        {detail}
      </span>
    </button>
  )
}
