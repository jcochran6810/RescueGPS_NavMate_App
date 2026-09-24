import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMessages, LOCAL_PREFIX } from '@/store/useMessages'
import { useOnline } from '@/hooks/useOnline'
import { useFieldIdentity, useIncidentMessages } from '@/hooks/useIncidentFeeds'
import { toast } from '@/store/useToast'
import {
  inbox,
  isIncoming,
  messageAudience,
  pendingEmergency,
  type FieldMessage,
  type MessagePriority,
} from '@/lib/command'
import { Button, Card, Input, Label } from '@/components/ui'

const AUDIENCE_LABEL = { me: 'To you', unit: 'To your unit', all: 'To everyone' } as const

function time(t: string): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Messages on this incident (N6): what command has sent to this crew, to
 * their unit or to everyone, and what the crew has sent back.
 *
 * Opening a message is what marks it read — command sees delivered the moment
 * it reaches the phone and read when somebody has actually looked at it,
 * which are different facts and both worth having. Writing works offline and
 * sends when there is a link, never twice.
 */
export function MessagesCard() {
  const { incidentId, userId, unitId } = useFieldIdentity()
  const all = useIncidentMessages(incidentId)
  const send = useMessages((s) => s.send)
  const markRead = useMessages((s) => s.markRead)
  const queued = useMessages((s) => s.outbox.length)
  const failed = useMessages((s) => s.failed)
  const discardFailed = useMessages((s) => s.discardFailed)
  const online = useOnline()

  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [priority, setPriority] = useState<MessagePriority>('normal')

  const list = useMemo(() => inbox(all, userId, unitId), [all, userId, unitId])
  const unread = list.filter((m) => isIncoming(m, userId, unitId) && !m.read_at).length
  const open = list.find((m) => m.id === openId) ?? null

  if (!incidentId) return null

  async function submit() {
    if (!incidentId) return
    const ok = await send(incidentId, draft, priority, open && isIncoming(open, userId, unitId) ? open : null)
    if (!ok) {
      toast('Could not queue the message', 'error')
      return
    }
    setDraft('')
    setPriority('normal')
    toast(online ? 'Message sent' : 'Message queued — offline, will send', 'success')
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Messages</Label>
        {unread > 0 && (
          <span className="mb-1.5 rounded-full bg-sky-500/20 px-2 py-0.5 text-[11px] font-semibold text-sky-200">
            {unread} unread
          </span>
        )}
      </div>

      {queued > 0 && (
        <p className="mb-2 text-xs text-sky-300">
          {queued} message{queued === 1 ? '' : 's'} waiting to send{online ? '' : ' — offline'}.
        </p>
      )}
      {failed.length > 0 && (
        <div className="mb-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {failed.length} message{failed.length === 1 ? '' : 's'} refused — {failed[0].reason}
          <button
            type="button"
            onClick={discardFailed}
            className="ml-2 rounded-lg border border-amber-400/30 px-2 py-0.5"
          >
            Dismiss
          </button>
        </div>
      )}

      {list.length === 0 ? (
        <p className="text-xs text-slate-400">Nothing yet from command on this search.</p>
      ) : (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto">
          {list.map((m) => {
            const incoming = isIncoming(m, userId, unitId)
            const audience = messageAudience(m, userId, unitId)
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpenId(m.id === openId ? null : m.id)
                    if (incoming) markRead(m)
                  }}
                  className={
                    'w-full rounded-xl border px-3 py-2 text-left text-sm ' +
                    (m.priority === 'emergency'
                      ? 'border-red-500/50 bg-red-500/10'
                      : m.priority === 'urgent'
                        ? 'border-amber-400/40 bg-amber-500/5'
                        : 'border-white/10') +
                    (incoming && !m.read_at ? ' font-semibold' : '')
                  }
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                    <span>
                      {incoming ? (audience ? AUDIENCE_LABEL[audience] : 'Command') : 'You'}
                      {m.priority !== 'normal' ? ` · ${m.priority.toUpperCase()}` : ''}
                    </span>
                    <span className="tnum">
                      {time(m.created_at)}
                      {!incoming &&
                        (m.id.startsWith(LOCAL_PREFIX)
                          ? ' · queued'
                          : m.read_at
                            ? ' · read'
                            : m.delivered_at
                              ? ' · delivered'
                              : ' · sent')}
                    </span>
                  </div>
                  <p
                    className={
                      'mt-0.5 text-slate-100 ' +
                      (m.id === openId ? 'whitespace-pre-wrap' : 'truncate')
                    }
                  >
                    {m.body}
                  </p>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-3 space-y-2">
        {open && isIncoming(open, userId, unitId) && (
          <p className="text-xs text-sky-300">Replying to the message above.</p>
        )}
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={open && isIncoming(open, userId, unitId) ? 'Reply…' : 'Message to the incident…'}
          aria-label="Message"
        />
        <div className="flex gap-2">
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as MessagePriority)}
            className="min-h-11 w-32 shrink-0 rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
            aria-label="Priority"
          >
            <option value="normal">Normal</option>
            <option value="urgent">Urgent</option>
            <option value="emergency">Emergency</option>
          </select>
          <Button
            variant="primary"
            className="w-full"
            disabled={!draft.trim()}
            onClick={() => void submit()}
          >
            {open && isIncoming(open, userId, unitId) ? 'Reply' : 'Send'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

/**
 * An emergency message takes the whole screen until somebody acknowledges it.
 *
 * Everything else on a search can wait for the crew to look at a card; an
 * emergency from command cannot, and the one screen a crew is guaranteed to
 * be looking at is whichever one is open. Acknowledging is what marks it
 * read, so command knows it has been seen and not merely delivered.
 */
export function EmergencyAlert() {
  const { incidentId, userId, unitId } = useFieldIdentity()
  const all = useIncidentMessages(incidentId)
  const markRead = useMessages((s) => s.markRead)
  const m: FieldMessage | null = useMemo(
    () => pendingEmergency(all, userId, unitId),
    [all, userId, unitId],
  )
  if (!m) return null

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Emergency message from command"
      className="fixed inset-0 z-50 grid place-items-center bg-red-950/95 px-6"
    >
      <div className="w-full max-w-md text-center">
        <p className="text-sm font-bold tracking-widest text-red-200 uppercase">
          Emergency · {time(m.created_at)}
        </p>
        <p className="mt-4 text-2xl font-semibold whitespace-pre-wrap text-white">
          {m.body}
        </p>
        <Button
          variant="danger"
          className="mt-8 w-full text-base"
          onClick={() => markRead(m)}
        >
          Acknowledge
        </Button>
      </div>
    </div>,
    document.body,
  )
}
