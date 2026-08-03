import { useEffect, useState } from 'react'
import { useAuth } from '@/store/useAuth'
import { useTeams } from '@/store/useTeams'
import { useWaypoints } from '@/store/useWaypoints'
import { AuthScreen } from '@/components/AuthScreen'
import { Header } from '@/components/Header'
import { TabBar, type TabId } from '@/components/TabBar'
import { Toast } from '@/components/Toast'
import { Spinner } from '@/components/ui'
import { ConvertTab } from '@/tabs/ConvertTab'
import { TrackTab } from '@/tabs/TrackTab'
import { WaypointsTab } from '@/tabs/WaypointsTab'
import { TeamTab } from '@/tabs/TeamTab'
import { DataTab } from '@/tabs/DataTab'

export default function App() {
  const { session, ready, init } = useAuth()
  const [tab, setTab] = useState<TabId>('convert')

  useEffect(() => init(), [init])

  // Retry queued writes as soon as the network comes back.
  useEffect(() => {
    const onOnline = () => void useWaypoints.getState().flush()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  useEffect(() => {
    if (!session) {
      useTeams.getState().reset()
      return
    }
    void useTeams.getState().load()
    void useWaypoints.getState().load()
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

  return (
    <div className="min-h-full">
      <Header />
      <main className="mx-auto max-w-3xl px-3 pt-3 pb-24">
        {tab === 'convert' && <ConvertTab />}
        {tab === 'track' && <TrackTab />}
        {tab === 'waypoints' && <WaypointsTab />}
        {tab === 'team' && <TeamTab />}
        {tab === 'data' && <DataTab />}
      </main>
      <TabBar active={tab} onChange={setTab} />
      <Toast />
    </div>
  )
}
