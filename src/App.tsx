import { useEffect, useState } from 'react'
import { useAuth } from '@/store/useAuth'
import { useTeams } from '@/store/useTeams'
import { useTides } from '@/store/useTides'
import { useSarRecords } from '@/store/useSarRecords'
import { useWaypoints } from '@/store/useWaypoints'
import { useAdmin } from '@/store/useAdmin'
import { useSupport } from '@/store/useSupport'
import { installErrorReporting } from '@/lib/errlog'
import { AuthScreen } from '@/components/AuthScreen'
import { RecoverPassword } from '@/components/RecoverPassword'
import { Header } from '@/components/Header'
import { TabBar, type TabId } from '@/components/TabBar'
import { StampWaypoint } from '@/components/StampWaypoint'
import { Toast } from '@/components/Toast'
import { Spinner } from '@/components/ui'
import { HomeTab } from '@/tabs/HomeTab'
import { DatumTab } from '@/tabs/DatumTab'
import { AdminTab } from '@/tabs/AdminTab'
import { ConvertTab } from '@/tabs/ConvertTab'
import { TrackTab } from '@/tabs/TrackTab'
import { EtaTab } from '@/tabs/EtaTab'
import { TidesTab } from '@/tabs/TidesTab'
import { CompassTab } from '@/tabs/CompassTab'
import { WaypointsTab } from '@/tabs/WaypointsTab'
import { TeamTab } from '@/tabs/TeamTab'
import { DataTab } from '@/tabs/DataTab'

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
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  useEffect(() => {
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
    void useAdmin.getState().check()
  }, [session])

  if (!ready) {
    return (
      <div className="grid min-h-full place-items-center text-slate-400">
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
      <Header />
      {/* Clears the footer, which is the stamp button and the section row
          stacked together. */}
      <main className="mx-auto max-w-3xl px-3 pt-3 pb-40">
        {tab === 'home' && <HomeTab onNavigate={setTab} />}
        {tab === 'datum' && <DatumTab />}
        {tab === 'track' && <TrackTab />}
        {tab === 'eta' && <EtaTab />}
        {tab === 'tides' && <TidesTab />}
        {tab === 'compass' && <CompassTab />}
        {tab === 'convert' && <ConvertTab />}
        {tab === 'waypoints' && <WaypointsTab />}
        {tab === 'team' && <TeamTab />}
        {tab === 'data' && <DataTab />}
        {tab === 'admin' && <AdminTab />}
      </main>

      {/* Stamping is the one action that can be urgent, so the button sits on
          every screen, in the same place, however far the page has scrolled. */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-navy-950/95 backdrop-blur">
        <div className="mx-auto max-w-3xl">
          <StampWaypoint />
          <TabBar active={tab} onChange={setTab} />
        </div>
      </div>

      <Toast />
    </div>
  )
}
