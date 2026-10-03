/**
 * What teammates and command record on this incident, as they record it.
 *
 * Assignments, messages, hazards, catch points and search areas already came
 * live; waypoints, clues / field records (sar_records) and the subject
 * description only arrived on the next full load, so a clue a teammate logged
 * was not on this phone until someone happened to reload. These three now
 * come over Realtime too, filtered to the incident.
 */
import { supabase } from '@/lib/supabase'
import { useWaypoints } from '@/store/useWaypoints'
import { useSarRecords } from '@/store/useSarRecords'
import { useVictims } from '@/store/useVictims'
import type { SarRecord, Waypoint } from '@/lib/types'

interface Change<T> {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: T | Record<string, never>
  old: Partial<T>
}

/** Subscribe to the incident's waypoints, field records and subject; returns unsubscribe. */
export function subscribeIncidentRecords(incidentId: string): () => void {
  const filter = `incident_id=eq.${incidentId}`
  const channel = supabase
    .channel(`navmate-records-${incidentId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'waypoints', filter }, (p) => {
      const c = p as unknown as Change<Waypoint>
      if (c.eventType === 'DELETE') {
        if (c.old?.id) useWaypoints.getState().applyRemote({ id: c.old.id } as Waypoint, true)
      } else useWaypoints.getState().applyRemote(c.new as Waypoint)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sar_records', filter }, (p) => {
      const c = p as unknown as Change<SarRecord>
      if (c.eventType === 'DELETE') {
        if (c.old?.id) useSarRecords.getState().applyRemote({ id: c.old.id } as SarRecord, true)
      } else useSarRecords.getState().applyRemote(c.new as SarRecord)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'victims', filter }, () => {
      // The description is read through the store's own (narrow) select.
      void useVictims.getState().load(incidentId)
    })
    .subscribe()
  return () => {
    void supabase.removeChannel(channel)
  }
}
