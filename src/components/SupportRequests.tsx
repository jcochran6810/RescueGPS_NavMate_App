import { useEffect, useState } from 'react'
import { useSupport } from '@/store/useSupport'
import { useOnline } from '@/hooks/useOnline'
import { toast } from '@/store/useToast'
import { Button, Card, Input, Label, Spinner } from '@/components/ui'
import type { RequestKind, RequestStatus } from '@/lib/types'

const KINDS: { id: RequestKind; label: string }[] = [
  { id: 'help', label: 'Help' },
  { id: 'account', label: 'Account change' },
  { id: 'team', label: 'Team problem' },
  { id: 'data', label: 'Data issue' },
  { id: 'bug', label: 'Bug report' },
  { id: 'other', label: 'Other' },
]

const STATUS_LABEL: Record<RequestStatus, string> = {
  open: 'Open',
  in_progress: 'Being handled',
  resolved: 'Resolved',
  dismissed: 'Closed',
}

const STATUS_TONE: Record<RequestStatus, string> = {
  open: 'bg-amber-500/15 text-amber-300',
  in_progress: 'bg-sky-500/15 text-sky-300',
  resolved: 'bg-emerald-500/15 text-emerald-300',
  dismissed: 'bg-white/5 text-slate-300',
}

/**
 * File a request to the platform admin, and see what happened to the ones
 * already filed — including the note the admin wrote back.
 */
export function SupportRequests() {
  const { mine, loading, error, load, submit } = useSupport()
  const online = useOnline()

  const [kind, setKind] = useState<RequestKind>('help')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  async function send() {
    if (!subject.trim()) {
      toast('Give the request a subject', 'error')
      return
    }
    setSending(true)
    try {
      const { error } = await submit(kind, subject, body)
      if (error) {
        toast(error, 'error')
        return
      }
      setSubject('')
      setBody('')
      toast('Request sent to the platform admin', 'success')
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <Label>Contact the platform admin</Label>
      <p className="mb-2 text-xs text-slate-400">
        Account changes, team problems, bugs — file it here and the platform
        admin picks it up. You will see their answer below.
      </p>

      <div className="flex gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as RequestKind)}
          className="min-h-11 w-36 shrink-0 rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
          aria-label="Request type"
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          maxLength={200}
          aria-label="Request subject"
        />
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What do you need?"
        rows={3}
        maxLength={4000}
        aria-label="Request details"
        className="mt-2 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-400 focus:border-sky-400/60 focus:outline-none"
      />
      <Button
        variant="primary"
        className="mt-2 w-full"
        onClick={() => void send()}
        disabled={sending || !online}
      >
        {sending && <Spinner />} Send request
      </Button>
      {!online && (
        <p className="mt-1.5 text-xs text-amber-300">
          Requests need a connection — this is a message to a person, and
          nothing is queued behind your back. Try again with signal.
        </p>
      )}

      {error && (
        <p className="mt-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {mine.length > 0 && (
        <ul className="mt-3 space-y-2">
          {mine.map((r) => (
            <li key={r.id} className="rounded-xl border border-white/10 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-slate-100">
                  {r.subject}
                </span>
                <span
                  className={
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
                    STATUS_TONE[r.status]
                  }
                >
                  {STATUS_LABEL[r.status]}
                </span>
              </div>
              <p className="tnum text-xs text-slate-400">
                {new Date(r.created_at).toLocaleString()}
              </p>
              {r.admin_notes && (
                <p className="mt-1 rounded-lg bg-sky-500/5 px-2.5 py-1.5 text-xs text-sky-200">
                  Admin: {r.admin_notes}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {loading && mine.length === 0 && (
        <p className="mt-2 text-center text-xs text-slate-400">Loading your requests…</p>
      )}
    </Card>
  )
}
