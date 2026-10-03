import { useState } from 'react'
import { useFormat } from '@/hooks/useFormat'
import { useIncidents } from '@/store/useIncidents'
import { useTeams } from '@/store/useTeams'
import { useAuth } from '@/store/useAuth'
import { useIncidentUnits } from '@/hooks/useIncidentUnits'
import { useTracker } from '@/store/useTracker'
import {
  bearingDeg,
  compassPoint,
  formatDuration,
  haversineNM,
} from '@/lib/geo'
import { useSarRecords } from '@/store/useSarRecords'
import { useOnline } from '@/hooks/useOnline'
import { useNow } from '@/hooks/useNow'
import { toast } from '@/store/useToast'
import { download } from '@/lib/transfer'
import {
  canUpdateIncident,
  incidentTypeLabel,
  newIncidentNumber,
  incidentStatusLabel,
  CLOSE_OPTIONS,
  closePatch,
  incidentHandoff,
} from '@/lib/incident'
import type { LkpPayload, SarRecord } from '@/lib/types'
import { Button, Card, Label } from '@/components/ui'
import { JoinIncidentButton } from '@/components/JoinIncident'
import { IncidentWizard } from '@/components/IncidentWizard'
import { initialAnswers } from '@/lib/wizard/answers'
import { wizardRowsFromAnswers, type Answers } from '@/lib/wizard/rows'
import { useWizardVictims } from '@/store/useWizardVictims'
import { useVictims } from '@/store/useVictims'
import { victimIsEmpty, victimRow } from '@/lib/victim'

/**
 * The incident — the search this team is on. One card, three states: open a
 * search, run it, hand it to command.
 *
 * Everyone on the team sees the same incident, so two phones on the same
 * boat — or two boats on the same team — are working the same search and
 * everything they log lands in the same container. When an incident
 * commander stands up RescueGPS, the handoff export carries the whole
 * picture across in that system's own field names.
 */
export function IncidentCard() {
  const fmt = useFormat()
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const incidents = useIncidents()
  const sar = useSarRecords()
  const online = useOnline()
  const now = useNow(30_000)

  const incident = incidents.activeIncident(activeTeamId)
  const me = useAuth((s) => s.user?.id ?? null)
  /*
   * A search this crew walked into rather than started. They are not the
   * incident commander of it, so closing it is not theirs to do — the way out
   * is to leave, and the search carries on without them.
   *
   * Their own team's search is not one of those, whoever on the team opened
   * it: the team reads it, updates it and closes it, and it is the search the
   * team scope puts them on — "leaving" it would last until the next screen.
   * Nor is a search command has handed them as IC. The same rule decides
   * whether the incident row will take their writes at all.
   */
  const joined = !!incident && !canUpdateIncident(incident, me, activeTeamId)
  const units = useIncidentUnits()
  const fix = useTracker((s) => s.fix)

  /*
   * The new-incident wizard's answers — the same questions as command's
   * wizard in RescueGPS. Held here, not in the sheet, so a stray tap that
   * closes the sheet keeps everything typed so far.
   */
  const [draft, setDraft] = useState<Answers>(initialAnswers)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [closing, setClosing] = useState(false)
  const [closeAs, setCloseAs] = useState(CLOSE_OPTIONS[0].value)

  async function open() {
    setOpening(true)
    try {
      const id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : undefined
      const number = newIncidentNumber(new Date(), id)
      // The rows command's own wizard would write for these answers.
      const rows = wizardRowsFromAnswers(draft, { incidentNumber: number, clientId: id ?? null })
      const created = await incidents.openIncident({
        id,
        incident_number: number,
        incident_type: String(rows.incident.incident_type),
        incident_name: String(rows.incident.incident_name ?? ''),
        team_id: activeTeamId,
        wizard_row: rows.incident,
      })
      if (!created) {
        toast('Could not open the incident', 'error')
        return
      }

      // Adopt what the crew already logged in this scope before the incident
      // existed — the LKP is very often recorded first. Bounded to the last
      // 24 h so a previous search's records are not swept in.
      const cutoff = Date.now() - 24 * 3_600_000
      const orphans = sar
        .visible()
        .filter(
          (r) =>
            r.incident_id === null &&
            (activeTeamId ? r.team_id === activeTeamId : r.team_id === null) &&
            new Date(r.recorded_at).getTime() >= cutoff,
        )
      for (const r of orphans) {
        await sar.updateRecord(r.id, { incident_id: created.id })
      }
      // A logged LKP fills the position only when the wizard gave none.
      const lkp = orphans.find((r) => r.kind === 'lkp')
      if (lkp && lkp.lat != null && lkp.lon != null && created.lkp_lat == null) {
        await incidents.updateIncident(created.id, {
          lkp_lat: lkp.lat,
          lkp_lng: lkp.lon,
          lkp_time: lkp.recorded_at,
          lkp_source: lkpSourceOf(lkp),
          incident_time: created.incident_time ?? lkp.recorded_at,
        })
      }

      if (rows.victims.length > 0) {
        await useWizardVictims.getState().queue(created.id, rows.victims)
      }

      const password = String(draft.incidentPassword ?? '').trim()
      let passwordNote = ''
      if (password) {
        const r = await incidents.setIncidentPassword(created.id, password)
        if (r !== 'set') passwordNote = ' — password not set (set it again once online)'
      }

      setDraft(initialAnswers())
      setWizardOpen(false)
      toast(
        `${created.incident_number} opened` +
          (orphans.length > 0 ? ` — ${orphans.length} record${orphans.length === 1 ? '' : 's'} attached` : '') +
          (online ? '' : ' — offline, will sync') +
          passwordNote,
        'success',
      )
    } finally {
      setOpening(false)
    }
  }

  if (!incident) {
    return (
      <Card>
        <Label>Search incident</Label>
        <p className="mb-2 text-xs text-slate-400">
          Open an incident and everything the team logs — LKP, conditions,
          markers, clues — belongs to this search, ready to hand to command.
        </p>
        <Button variant="primary" className="w-full" onClick={() => setWizardOpen(true)}>
          {draft.incidentType ? 'Continue new search incident' : 'Start New Search Incident'}
        </Button>
        <p className="mt-1 text-[11px] text-slate-400">
          The same questions as command's wizard. Answer what you know; command
          completes the rest.
        </p>
        {wizardOpen && (
          <IncidentWizard
            answers={draft}
            onChange={setDraft}
            onSubmit={() => void open()}
            onDismiss={() => setWizardOpen(false)}
            onDiscard={() => {
              setDraft(initialAnswers())
              setWizardOpen(false)
            }}
            busy={opening}
          />
        )}
        {/* The other way onto a search: one that is already running. A second
            boat, or a unit arriving late, should not have to start a second
            container for the same search. */}
        <JoinIncidentButton />
      </Card>
    )
  }

  const started = incident.incident_time ?? incident.lkp_time ?? incident.created_at
  const hours = Math.max(0, (now.getTime() - new Date(started).getTime()) / 3_600_000)
  const suspended = incident.status === 'suspended'

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Search incident</Label>
        <span
          className={
            'mb-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
            (suspended
              ? 'bg-amber-500/15 text-amber-300'
              : 'bg-emerald-500/15 text-emerald-300')
          }
        >
          {incidentStatusLabel(incident)}
        </span>
      </div>

      <div className="text-sm">
        <div className="font-semibold text-slate-50">
          {incident.incident_number}
          {incident.incident_name ? ` — ${incident.incident_name}` : ''}
        </div>
        <div className="text-xs text-slate-300">
          {incidentTypeLabel(incident.incident_type)} · running{' '}
          {formatDuration(hours)}
          {incidents.pendingCount() > 0 && !online ? ' · offline, will sync' : ''}
        </div>
      </div>

      {/* Who else is on it, and where. The point of joining a search is that
          everyone can see everyone — so it is said on the card, not only
          drawn on a map the crew may not be looking at. */}
      {units.length > 0 && (
        <ul className="mt-2 space-y-1">
          {units.map((u) => {
            const nm = fix ? haversineNM(fix.lat, fix.lon, u.lat, u.lon) : null
            const deg = fix ? bearingDeg(fix.lat, fix.lon, u.lat, u.lon) : null
            return (
              <li
                key={u.id}
                className={
                  'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1 text-xs ' +
                  (u.stale ? 'bg-white/5 text-slate-400' : 'bg-amber-500/10 text-amber-100')
                }
              >
                <span className="font-semibold">{u.name}</span>
                <span className="tnum">
                  {nm != null && deg != null
                    ? `${fmt.length(nm)} ${compassPoint(deg)}`
                    : '—'}
                  {u.speedKn != null && u.speedKn >= 0.5
                    ? ` · ${u.speedKn.toFixed(1)} kn`
                    : ''}
                  {u.stale ? ' · no signal' : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {!closing ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              const saved = useVictims.getState().drafts[incident.id] ?? null
              const report = incidentHandoff({
                incident,
                records: sar.visible(),
                victim:
                  saved && !victimIsEmpty(saved)
                    ? victimRow(saved, incident.id)
                    : null,
              })
              const stamp = new Date().toISOString().slice(0, 16).replace(':', '')
              download(
                `navmate-handoff-${incident.incident_number}-${stamp}.json`,
                report,
                'application/json',
              )
              toast(
                'Handoff exported — RescueGPS table shapes, ready for command',
                'success',
              )
            }}
          >
            Handoff to command
          </Button>
          {joined ? (
            <Button
              variant="ghost"
              onClick={async () => {
                await incidents.leaveIncident(incident.id)
                toast(`Left ${incident.incident_number}`, 'success')
              }}
            >
              Leave search
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setClosing(true)}>
              Close incident…
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <select
            value={closeAs}
            onChange={(e) => setCloseAs(e.target.value as typeof closeAs)}
            className="min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
            aria-label="Close incident as"
          >
            {CLOSE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setClosing(false)}>
              Keep searching
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                await incidents.closeIncident(incident.id, closeAs)
                setClosing(false)
                // Says what was written — "Closed · Found alive", or
                // "Cancelled" — in the words the command side will show.
                toast(
                  `${incident.incident_number} — ${incidentStatusLabel({
                    status: 'active',
                    outcome: null,
                    ...closePatch(closeAs),
                  })}`,
                  'success',
                )
              }}
            >
              Close
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function lkpSourceOf(lkp: SarRecord): string {
  const source = (lkp.payload as LkpPayload).source
  // RescueGPS marks field-originated GPS fixes as field_gps; the other two
  // source names it takes as-is.
  return source === 'gps' ? 'field_gps' : source
}
