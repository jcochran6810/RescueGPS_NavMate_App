import { useMemo } from 'react'
import { useAssignments } from '@/store/useAssignments'
import { useOnline } from '@/hooks/useOnline'
import { useFieldIdentity, useIncidentAssignments } from '@/hooks/useIncidentFeeds'
import { toast } from '@/store/useToast'
import {
  ASSIGNMENT_STATUS_LABEL,
  FIELD_STATUS_STEPS,
  assignmentLabel,
  canMoveTo,
  isMine,
  parsePolygon,
  sortAssignments,
} from '@/lib/command'
import { Button, Card, Label } from '@/components/ui'

/**
 * The search segments command has assigned on this incident (N5).
 *
 * This crew's own come first, with the three buttons that are the whole of
 * the field's say in them — En route, Searching, Complete. Everyone else's
 * are listed dimmed below, because knowing which water another boat has is
 * how two boats avoid searching the same water. The segments themselves are
 * drawn on the maps.
 */
export function AssignmentsCard() {
  const { incidentId, userId, unitId } = useFieldIdentity()
  const all = useIncidentAssignments(incidentId)
  const pending = useAssignments((s) => s.pending.length)
  const failed = useAssignments((s) => s.failed)
  const setStatus = useAssignments((s) => s.setStatus)
  const discardFailed = useAssignments((s) => s.discardFailed)
  const online = useOnline()

  const list = useMemo(() => sortAssignments(all, userId, unitId), [all, userId, unitId])
  if (!incidentId || list.length === 0) return null

  return (
    <Card>
      <Label>Search assignments</Label>
      {pending > 0 && (
        <p className="mb-2 text-xs text-sky-300">
          {pending} status change{pending === 1 ? '' : 's'} waiting to send
          {online ? '' : ' — offline'}.
        </p>
      )}
      {failed.length > 0 && (
        <div className="mb-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Command refused {failed.length} status change
          {failed.length === 1 ? '' : 's'} — {failed[0].reason}
          <button
            type="button"
            onClick={discardFailed}
            className="ml-2 rounded-lg border border-amber-400/30 px-2 py-0.5"
          >
            Dismiss
          </button>
        </div>
      )}
      <ul className="space-y-2">
        {list.map((a) => {
          const mine = isMine(a, userId, unitId)
          const drawable = parsePolygon(a.segment_geom) !== null
          return (
            <li
              key={a.id}
              className={
                'rounded-xl border px-3 py-2 text-sm ' +
                (mine ? 'border-sky-400/40 bg-sky-500/5' : 'border-white/10 opacity-60')
              }
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-slate-100">{assignmentLabel(a)}</span>
                <span
                  className={
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
                    (a.priority === 'urgent' || a.priority === 'high'
                      ? 'bg-red-500/15 text-red-300'
                      : 'bg-white/10 text-slate-300')
                  }
                >
                  {a.priority}
                </span>
              </div>
              <div className="text-xs text-slate-400">
                {mine ? 'Yours' : 'Another unit'} · {ASSIGNMENT_STATUS_LABEL[a.status]}
                {drawable ? '' : ' · no outline to draw'}
              </div>
              {a.instructions && (
                <p className="mt-1 text-xs whitespace-pre-wrap text-slate-300">
                  {a.instructions}
                </p>
              )}
              {mine && (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {FIELD_STATUS_STEPS.map((step) => (
                    <Button
                      key={step.value}
                      variant={a.status === step.value ? 'primary' : 'default'}
                      className="min-h-9 px-2 text-xs"
                      disabled={!canMoveTo(a.status, step.value)}
                      onClick={async () => {
                        const ok = await setStatus(a, step.value)
                        if (ok) {
                          toast(
                            `${step.label}${online ? '' : ' — offline, will send'}`,
                            'success',
                          )
                        }
                      }}
                    >
                      {step.label}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
