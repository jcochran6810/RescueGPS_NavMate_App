import { useMemo, useState } from 'react'
import { useFieldIdentity, useIncidentSearchPicture } from '@/hooks/useIncidentFeeds'
import { useSearchAreas } from '@/store/useSearchAreas'
import { useOnline } from '@/hooks/useOnline'
import { toast } from '@/store/useToast'
import {
  RIVER_SEGMENT_FIELD_STEPS,
  RIVER_SEGMENT_STATUS_LABEL,
  riverSegments,
  type RiverSegmentStatus,
} from '@/lib/command'
import { Button, Card, Label } from '@/components/ui'

/**
 * Command's numbered river segments (RescueGPS Narrow Water Search NW4).
 *
 * Command cuts the river into fixed-length segments numbered from the LKP
 * (R1 downstream, R-1 upstream) with each one's probability. A crew marks a
 * segment Searching, Searched or Negative; command applies a negative to its
 * probability with the segment's POD — the crew's mark is the report, not
 * the number. The segments are drawn on the maps with the other search areas.
 */
export function RiverSegmentsCard() {
  const { incidentId } = useFieldIdentity()
  const { areas } = useIncidentSearchPicture(incidentId)
  const markSegment = useSearchAreas((s) => s.markSegment)
  const online = useOnline()
  const [busy, setBusy] = useState<string | null>(null)
  const list = useMemo(() => riverSegments(areas), [areas])
  if (!incidentId || list.length === 0) return null

  const mark = async (id: string, status: RiverSegmentStatus) => {
    const area = list.find((a) => a.id === id)
    if (!area) return
    setBusy(id)
    const r = await markSegment(area, status)
    setBusy(null)
    toast(r.ok ? `${area.name ?? 'Segment'}: ${RIVER_SEGMENT_STATUS_LABEL[status]}` : `Not sent — ${r.reason}`, r.ok ? 'success' : 'error')
  }

  return (
    <Card>
      <Label>River segments</Label>
      <p className="mb-2 text-xs text-slate-400">
        From command, numbered from the LKP: R1 downstream, R-1 upstream. Probability is
        command&apos;s, at the hour it cut them.
        {online ? '' : ' Offline — marks need signal.'}
      </p>
      <ul className="space-y-2">
        {list.map((a) => (
          <li key={a.id} className="rounded-xl border border-white/10 px-3 py-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold text-slate-100">{a.name}</span>
              <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-slate-300">
                {a.poc == null ? 'POC —' : `POC ${(a.poc * 100).toFixed(a.poc < 0.1 ? 1 : 0)}%`}
              </span>
            </div>
            <div className="text-xs text-slate-400">
              {RIVER_SEGMENT_STATUS_LABEL[a.status ?? 'pending'] ?? a.status}
              {a.status === 'negative' && a.pod != null ? ` · POD ${Math.round(a.pod * 100)}%` : ''}
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {RIVER_SEGMENT_FIELD_STEPS.map((step) => (
                <Button
                  key={step.value}
                  variant={a.status === step.value ? 'primary' : 'default'}
                  className="min-h-11 px-2 text-xs"
                  title={step.hint}
                  disabled={!online || busy === a.id || a.status === step.value}
                  onClick={() => void mark(a.id, step.value)}
                >
                  {step.label}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}
