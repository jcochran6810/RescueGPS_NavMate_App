/**
 * Send everything this phone is holding, in the right order.
 *
 * Every store already queues its own writes, but before this each one was
 * retried only on its own triggers — some on a 60 s timer while an incident
 * was open, some only on the browser's `online` event, which never fires on a
 * weak signal (`navigator.onLine` stays true while every request fails). A
 * clue recorded on a weak signal could then sit on the phone until the crew
 * happened to record something else. Here one loop sends them all:
 *
 *   - every SYNC_EVERY_MS while the app is open, whatever is on screen,
 *   - when the signal comes back, and
 *   - when the app comes back to the front.
 *
 * Incidents go first: a waypoint, clue or person for an incident opened out of
 * signal is refused until the incident itself is on the server.
 */
import { useIncidents } from '@/store/useIncidents'
import { useWizardVictims } from '@/store/useWizardVictims'
import { useWaypoints } from '@/store/useWaypoints'
import { useSarRecords } from '@/store/useSarRecords'
import { useVessels } from '@/store/useVessels'
import { useAssignments } from '@/store/useAssignments'
import { useMessages } from '@/store/useMessages'
import { useHazards } from '@/store/useHazards'
import { useCatchPoints } from '@/store/useCatchPoints'
import { useVictims } from '@/store/useVictims'
import { useIncidentShare } from '@/store/useIncidentShare'
import { useSearchAreas } from '@/store/useSearchAreas'
import { drainPendingPhotos } from '@/lib/photoStash'

export const SYNC_EVERY_MS = 20_000

let running: Promise<void> | null = null

async function quietly(step: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await step()
  } catch (e) {
    console.warn('sync step failed', e instanceof Error ? e.message : String(e))
  }
}

/** One pass over every queue. Concurrent calls share the pass in progress. */
export function flushAll(): Promise<void> {
  if (running) return running
  running = (async () => {
    await quietly(() => useIncidents.getState().flush())
    await Promise.all([
      quietly(() => useWizardVictims.getState().flush()),
      quietly(async () => {
        await useWaypoints.getState().flush()
        await useWaypoints.getState().drainStagedPhotos()
      }),
      quietly(() => useSarRecords.getState().flush()),
      quietly(() => useVessels.getState().flush()),
      quietly(() => useAssignments.getState().flush()),
      quietly(() => useMessages.getState().flush()),
      quietly(() => useHazards.getState().flush()),
      quietly(() => useCatchPoints.getState().flush()),
      quietly(() => useVictims.getState().flush()),
      quietly(() => useIncidentShare.getState().flush()),
      quietly(() => useSearchAreas.getState().flushMarks()),
    ])
    await quietly(() => drainPendingPhotos())
  })().finally(() => {
    running = null
  })
  return running
}

/** Everything still waiting on this phone, by kind — for the status line. */
export function unsentCounts(): Record<string, number> {
  const counts: Record<string, number> = {
    incidents: useIncidents.getState().pending.length,
    people: useWizardVictims.getState().pending.length + useVictims.getState().pending.length,
    waypoints: useWaypoints.getState().pending.length,
    'clues & records': useSarRecords.getState().pending.length,
    'assignment updates': useAssignments.getState().pending.length,
    messages: useMessages.getState().outbox.length,
    hazards: useHazards.getState().outbox.length,
    'catch points': useCatchPoints.getState().outbox.length,
    'track points': useIncidentShare.getState().queue.length,
    'segment marks': useSearchAreas.getState().pendingMarks.length,
  }
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0))
}

/** Start the loop; returns a stop function. */
export function startSyncLoop(): () => void {
  if (typeof window === 'undefined') return () => {}
  const kick = () => {
    void flushAll()
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') kick()
  }
  const timer = window.setInterval(kick, SYNC_EVERY_MS)
  window.addEventListener('online', kick)
  document.addEventListener('visibilitychange', onVisible)
  kick()
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('online', kick)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
