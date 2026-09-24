import { useMemo, useState } from 'react'
import { useHazards } from '@/store/useHazards'
import { useTracker } from '@/store/useTracker'
import { useOnline } from '@/hooks/useOnline'
import { useNow } from '@/hooks/useNow'
import { useFieldIdentity, useIncidentHazards } from '@/hooks/useIncidentFeeds'
import { toast } from '@/store/useToast'
import {
  HAZARD_SEVERITIES,
  HAZARD_TYPES,
  SEVERITY_COLOR,
  activeHazards,
  hazardTypeLabel,
  type HazardSeverity,
  type HazardType,
} from '@/lib/command'
import { Button, Card, Input, Label, Segmented } from '@/components/ui'

/**
 * Hazards on this search (N7): the ones still in force, coloured by severity
 * the same way the maps draw them, and a way to report one where the boat is.
 *
 * Reporting takes a fresh fix rather than asking for a position, because the
 * hazard a crew reports is almost always the one they are looking at — and
 * it is queued like any other capture when there is no signal.
 */
export function HazardsCard() {
  const { incidentId } = useFieldIdentity()
  const all = useIncidentHazards(incidentId)
  const report = useHazards((s) => s.report)
  const queued = useHazards((s) => s.outbox.length)
  const failed = useHazards((s) => s.failed)
  const discardFailed = useHazards((s) => s.discardFailed)
  const once = useTracker((s) => s.once)
  const online = useOnline()
  const now = useNow(60_000)

  const [reporting, setReporting] = useState(false)
  const [type, setType] = useState<HazardType>('debris')
  const [severity, setSeverity] = useState<HazardSeverity>('medium')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const active = useMemo(() => activeHazards(all, now.getTime()), [all, now])
  if (!incidentId) return null

  async function submit() {
    if (!incidentId) return
    setBusy(true)
    try {
      const fix = await once()
      if (!fix) {
        toast('No GPS fix — a hazard needs a position', 'error')
        return
      }
      const created = await report(incidentId, {
        hazard_type: type,
        severity,
        lat: fix.lat,
        lon: fix.lon,
        description,
      })
      if (!created) {
        toast('Could not report the hazard', 'error')
        return
      }
      setDescription('')
      setReporting(false)
      toast(
        `${hazardTypeLabel(type)} reported at your position${online ? '' : ' — offline, will send'}`,
        'success',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <Label>Hazards</Label>
      {queued > 0 && (
        <p className="mb-2 text-xs text-sky-300">
          {queued} report{queued === 1 ? '' : 's'} waiting to send{online ? '' : ' — offline'}.
        </p>
      )}
      {failed.length > 0 && (
        <div className="mb-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {failed.length} report{failed.length === 1 ? '' : 's'} refused — {failed[0].reason}
          <button
            type="button"
            onClick={discardFailed}
            className="ml-2 rounded-lg border border-amber-400/30 px-2 py-0.5"
          >
            Dismiss
          </button>
        </div>
      )}

      {active.length === 0 ? (
        <p className="text-xs text-slate-400">No hazards reported on this search.</p>
      ) : (
        <ul className="space-y-1.5">
          {active.map((h) => (
            <li
              key={h.id}
              className="flex items-start gap-2 rounded-xl border border-white/10 px-3 py-2 text-sm"
            >
              <span
                aria-hidden
                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: SEVERITY_COLOR[h.severity] }}
              />
              <span className="min-w-0">
                <span className="font-semibold text-slate-100">
                  {h.label?.trim() || hazardTypeLabel(h.hazard_type)}
                </span>
                <span className="text-xs text-slate-400"> · {h.severity}</span>
                {h.description && (
                  <span className="block text-xs text-slate-300">{h.description}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!reporting ? (
        <Button variant="ghost" className="mt-3 w-full" onClick={() => setReporting(true)}>
          Report a hazard here…
        </Button>
      ) : (
        <div className="mt-3 space-y-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as HazardType)}
            className="min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
            aria-label="Hazard type"
          >
            {HAZARD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <Segmented
            label="Severity"
            value={severity}
            options={HAZARD_SEVERITIES.map((s) => ({ id: s.value, label: s.label }))}
            onChange={setSeverity}
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is it? (optional)"
            aria-label="Hazard description"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setReporting(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>
              Report at my position
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
