import { useEffect, useMemo } from 'react'
import { useAuth } from '@/store/useAuth'
import { useIncidents } from '@/store/useIncidents'
import { useTeams } from '@/store/useTeams'
import { useIncidentShare } from '@/store/useIncidentShare'
import { useAssignments, withPendingStatus } from '@/store/useAssignments'
import { useMessages, visibleMessages } from '@/store/useMessages'
import { useHazards, visibleHazards } from '@/store/useHazards'
import { useSearchAreas } from '@/store/useSearchAreas'
import type { FieldAssignment, FieldMessage, IncidentHazard, SearchArea } from '@/lib/command'
import type { CommandLkp } from '@/store/useSearchAreas'

/** How often the LKP is re-read (it is not on the Realtime publication). */
const LKP_REFRESH_MS = 60_000

/** Who this crew is on the current search: the three keys everything filters by. */
export function useFieldIdentity(): {
  incidentId: string | null
  userId: string | null
  unitId: string | null
} {
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incidentId = useIncidents((s) => s.activeIncident(activeTeamId)?.id ?? null)
  const userId = useAuth((s) => s.user?.id ?? null)
  const unitId = useIncidentShare((s) => (incidentId ? (s.unitIds[incidentId] ?? null) : null))
  return { incidentId, userId, unitId }
}

const EMPTY: never[] = []

/** This incident's assignments, with queued status changes applied. */
export function useIncidentAssignments(incidentId: string | null): FieldAssignment[] {
  const cached = useAssignments((s) => (incidentId ? s.byIncident[incidentId] : undefined))
  const pending = useAssignments((s) => s.pending)
  return useMemo(
    () => withPendingStatus(cached ?? EMPTY, pending),
    [cached, pending],
  )
}

export function useIncidentMessages(incidentId: string | null): FieldMessage[] {
  const cached = useMessages((s) => (incidentId ? s.byIncident[incidentId] : undefined))
  const outbox = useMessages((s) => s.outbox)
  const receipts = useMessages((s) => s.receipts)
  return useMemo(
    () => (incidentId ? visibleMessages(cached ?? EMPTY, outbox, receipts, incidentId) : EMPTY),
    [cached, outbox, receipts, incidentId],
  )
}

export function useIncidentHazards(incidentId: string | null): IncidentHazard[] {
  const cached = useHazards((s) => (incidentId ? s.byIncident[incidentId] : undefined))
  const outbox = useHazards((s) => s.outbox)
  return useMemo(
    () => (incidentId ? visibleHazards(cached ?? EMPTY, outbox, incidentId) : EMPTY),
    [cached, outbox, incidentId],
  )
}

export function useIncidentSearchPicture(incidentId: string | null): {
  areas: SearchArea[]
  lkp: CommandLkp | null
} {
  const areas = useSearchAreas((s) => (incidentId ? s.byIncident[incidentId] : undefined))
  const lkp = useSearchAreas((s) => (incidentId ? (s.lkpByIncident[incidentId] ?? null) : null))
  return { areas: areas ?? EMPTY, lkp }
}

/**
 * Everything command sends to the field, followed live for the incident this
 * crew is on: assignments, messages, hazards, search areas and the LKP.
 *
 * Mounted once, in `App`, beside the telemetry, for the same reason — a crew
 * on any screen is still on the search and still needs the order that has
 * just come in. Every subscription is filtered to the incident and torn down
 * the moment the incident changes, so a crew never hears a search they have
 * left.
 */
export function useIncidentFeeds(): void {
  const { incidentId, userId, unitId } = useFieldIdentity()

  useEffect(() => {
    if (!incidentId) return
    void useAssignments.getState().load(incidentId)
    void useMessages.getState().load(incidentId)
    void useHazards.getState().load(incidentId)
    void useSearchAreas.getState().load(incidentId)
    const off = [
      useAssignments.getState().subscribe(incidentId),
      useMessages.getState().subscribe(incidentId),
      useHazards.getState().subscribe(incidentId),
      useSearchAreas.getState().subscribe(incidentId),
    ]
    const timer = setInterval(() => {
      void useSearchAreas.getState().loadLkp(incidentId)
      // Anything queued while the socket was quiet goes now.
      void useAssignments.getState().flush()
      void useMessages.getState().flush()
      void useHazards.getState().flush()
    }, LKP_REFRESH_MS)
    return () => {
      clearInterval(timer)
      for (const f of off) f()
    }
  }, [incidentId])

  // Delivered on receipt: every message that reaches this phone says so.
  const cached = useMessages((s) => (incidentId ? s.byIncident[incidentId] : undefined))
  useEffect(() => {
    if (incidentId && cached) {
      useMessages.getState().markDelivered(incidentId, userId, unitId)
    }
  }, [incidentId, cached, userId, unitId])
}
