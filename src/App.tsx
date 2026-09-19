import { useEffect, useState } from 'react'
import { useAuth } from '@/store/useAuth'
import { useTeams } from '@/store/useTeams'
import { toast } from '@/store/useToast'
import { useTides } from '@/store/useTides'
import { useSarRecords } from '@/store/useSarRecords'
import { useIncidents } from '@/store/useIncidents'
import { useVessels } from '@/store/useVessels'
import { useWaypoints } from '@/store/useWaypoints'
import { useAdmin } from '@/store/useAdmin'
import { useSupport } from '@/store/useSupport'
import { installErrorReporting } from '@/lib/errlog'
import { AuthScreen } from '@/components/AuthScreen'
import { RecoverPassword } from '@/components/RecoverPassword'
import { Header } from '@/components/Header'
import { MapActionHost } from '@/components/MapActionHost'
import { useIncidentTelemetry } from '@/hooks/useIncidentUnits'
import { type TabId } from '@/components/NavMenu'
import { StampWaypoint } from '@/components/StampWaypoint'
import { SurvivalBanner } from '@/components/SurvivalBanner'
import { Toast } from '@/components/Toast'
import { Spinner } from '@/components/ui'
import { HomeTab } from '@/tabs/HomeTab'
import { DatumTab } from '@/tabs/DatumTab'
import { SearchTab } from '@/tabs/SearchTab'
import { AdminTab } from '@/tabs/AdminTab'
import { ChartTab } from '@/tabs/ChartTab'
import { ConvertTab } from '@/tabs/ConvertTab'
import { TrackTab } from '@/tabs/TrackTab'
import { EtaTab } from '@/tabs/EtaTab'
import { TidesTab } from '@/tabs/TidesTab'
import { CompassTab } from '@/tabs/CompassTab'
import { WaypointsTab } from '@/tabs/WaypointsTab'
import { TeamTab } from '@/tabs/TeamTab'
import { DataTab } from '@/tabs/DataTab'
import { HelpTab } from '@/tabs/HelpTab'

export default function App() {
  const { session, ready, recovering, init } = useAuth()
  const [tab, setTab] = useState<TabId>('home')

  useEffect(() => init(), [init])

  // Runtime errors feed the admin dashboard's health numbers.
  useEffect(() => installErrorReporting(), [])

  // Retry queued writes — and any photos staged offline — as soon as the
  // network comes back.
  useEffect(() => {
    const onOnline = () => {
      const wp = useWaypoints.getState()
      void wp.flush().then(() => wp.drainStagedPhotos())
      void useSarRecords.getState().flush()
      void useIncidents.getState().flush()
      void useVessels.getState().flush()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  useEffect(() => {
    /*
     * Wait for auth to have an answer before acting on the lack of a session.
     *
     * On the first render `session` is null because it has not been restored
     * yet, not because anyone signed out — and treating that as a sign-out
     * ran `useTeams.reset()`, which cleared the selected team. The load that
     * followed then found `activeTeamId` already null, decided the stored
     * selection was stale and **deleted it from localStorage**, so every
     * refresh dropped the crew back to "Private — only me" for good.
     */
    if (!ready) return
    if (!session) {
      useTeams.getState().reset()
      // The waypoint cache is deliberately NOT cleared here — it may hold an
      // unsynced queue, and its ownerId guard stops another account from
      // inheriting it. The tide station pin carries no such protection.
      useTides.getState().reset()
      useAdmin.getState().reset()
      useSupport.getState().reset()
      return
    }
    void useTeams.getState().load()
    void useWaypoints.getState().load()
    void useSarRecords.getState().load()
    void useIncidents.getState().load()
    void useVessels.getState().load()
    void useAdmin.getState().check()
  }, [session, ready])

  /*
   * An invite link: `?join=ABC123`.
   *
   * The code is the credential, so following the link is the whole consent —
   * asking again would be asking somebody to confirm the thing they just
   * tapped. The parameter is removed as soon as it has been used, so a
   * refresh does not replay it and the code does not sit in the address bar
   * of a phone that gets passed round a boat.
   *
   * It runs only once there is a session, which is what lets the link survive
   * the sign-in screen for somebody installing NavMate because of it.
   */
  useEffect(() => {
    if (!ready || !session) return
    const params = new URLSearchParams(window.location.search)
    const code = params.get('join')
    if (!code) return
    params.delete('join')
    const rest = params.toString()
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash,
    )
    void (async () => {
      const { team, error } = await useTeams.getState().joinTeam(code.trim())
      if (error) {
        toast(error, 'error')
        return
      }
      if (team) {
        useTeams.getState().setActiveTeam(team.id)
        toast(`Joined ${team.name}`, 'success')
      }
    })()
  }, [session, ready])

  if (!ready) {
    return (
      <div className="grid min-h-full place-items-center text-slate-300">
        <Spinner />
      </div>
    )
  }

  if (!session) {
    return (
      <>
        <AuthScreen />
        <Toast />
      </>
    )
  }

  if (recovering) {
    return (
      <>
        <RecoverPassword />
        <Toast />
      </>
    )
  }

  return (
    <div className="min-h-full">
      {/* This boat's fixes go to the search, and the other units come back —
          from here rather than from a map, because a crew reading the datum
          worksheet is still a unit on the search. */}
      <IncidentTelemetry />
      <Header active={tab} onChange={setTab} />
      {/* Clears the footer, which now carries only the stamp button — the
          section menu lives in the header's top corner. */}
      <main className="mx-auto max-w-3xl px-3 pt-3 pb-24">
        {tab === 'home' && <HomeTab onNavigate={setTab} />}
        {tab === 'datum' && <DatumTab onNavigate={setTab} />}
        {tab === 'search' && <SearchTab />}
        {tab === 'track' && <TrackTab />}
        {tab === 'eta' && <EtaTab />}
        {tab === 'tides' && <TidesTab />}
        {tab === 'compass' && <CompassTab />}
        {tab === 'chart' && <ChartTab />}
        {tab === 'convert' && <ConvertTab />}
        {tab === 'waypoints' && <WaypointsTab />}
        {tab === 'team' && <TeamTab />}
        {tab === 'data' && <DataTab />}
        {tab === 'help' && <HelpTab />}
        {tab === 'admin' && <AdminTab />}
      </main>

      {/* What a long press on any map in the app asked for — the sheet it
          opens, or the handover to the chart plotter. Here because both need
          something no map can reach: the tab, and a sheet that contains a map. */}
      <MapActionHost onNavigate={setTab} />

      {/* Stamping is the one action that can be urgent, so the button sits on
          every screen, in the same place, however far the page has scrolled. */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-navy-950/95 backdrop-blur">
        {/* Above the stamp button, so the clock is read on the way to the one
            control that is on every screen. It renders nothing at all unless
            the search already knows the water temperature and when the person
            went in. */}
        <SurvivalBanner />
        <div className="mx-auto max-w-3xl pb-2">
          <StampWaypoint />
        </div>
      </div>

      <Toast />
    </div>
  )
}

/** Nothing to draw — it exists so the telemetry runs wherever the crew is. */
function IncidentTelemetry() {
  useIncidentTelemetry()
  return null
}
