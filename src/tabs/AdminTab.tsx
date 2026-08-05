import { useEffect, useMemo, useState } from 'react'
import { useAdmin } from '@/store/useAdmin'
import { useOnline } from '@/hooks/useOnline'
import { toast } from '@/store/useToast'
import { Button, Card, EmptyState, Input, Label, Spinner, Stat } from '@/components/ui'
import type {
  AdminUser,
  RequestStatus,
  SupportRequest,
} from '@/lib/types'

const REQUEST_KIND_LABEL: Record<string, string> = {
  help: 'Help',
  account: 'Account',
  team: 'Team',
  data: 'Data',
  bug: 'Bug',
  other: 'Other',
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}

const STATUS_TONE: Record<RequestStatus, string> = {
  open: 'bg-amber-500/15 text-amber-300',
  in_progress: 'bg-sky-500/15 text-sky-300',
  resolved: 'bg-emerald-500/15 text-emerald-300',
  dismissed: 'bg-white/5 text-slate-400',
}

/**
 * The platform admin dashboard — MyTradeCrate's /admin, sized for NavMate.
 *
 * Everything here reads with the admin's own JWT (RLS grants the reads) and
 * mutates through audited SECURITY DEFINER RPCs. The tab itself only renders
 * for platform admins, but that is cosmetic — the database enforces it.
 */
export function AdminTab() {
  const { metrics, users, actions, loading, error, refresh } = useAdmin()
  const online = useOnline()

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-50">Platform admin</h2>
          <p className="text-sm text-slate-400">
            Metrics, requests and accounts. Every change here is audited.
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={() => void refresh()}
          disabled={loading || !online}
        >
          {loading ? <Spinner /> : null} Refresh
        </Button>
      </div>

      {!online && (
        <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          Offline — showing the last loaded numbers. The dashboard needs a
          connection to be current.
        </p>
      )}
      {error && (
        <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
          {metrics && ' — showing the last loaded numbers.'}
        </p>
      )}

      <MetricsSection />
      <RequestsSection />
      <UsersSection />

      <Card>
        <Label>Recent admin actions</Label>
        {actions.length === 0 ? (
          <EmptyState>No admin actions recorded yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-white/5 text-sm">
            {actions.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-slate-200">
                  {a.action}
                  {a.target_kind ? (
                    <span className="text-slate-500"> · {a.target_kind}</span>
                  ) : null}
                </span>
                <span className="tnum shrink-0 text-xs text-slate-500">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-xs text-slate-500">
          Append-only log ({users.length > 0 ? 'latest 25' : 'empty'}). Every
          profile change and request resolution lands here automatically.
        </p>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------- metrics */

function MetricsSection() {
  const metrics = useAdmin((s) => s.metrics)

  if (!metrics) {
    return (
      <Card>
        <Label>Platform metrics</Label>
        <EmptyState>Loading metrics…</EmptyState>
      </Card>
    )
  }

  const mb = metrics.storage_bytes / (1024 * 1024)
  const kinds = Object.entries(metrics.sar_by_kind)

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <Label>Platform metrics</Label>
        <span className="mb-1.5 text-xs text-slate-500">
          As of {new Date(metrics.generated_at).toLocaleTimeString()}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Users"
          value={String(metrics.users_total)}
          hint={`+${metrics.users_new_7d} this week · +${metrics.users_new_30d} this month`}
        />
        <Stat
          label="Active (7d)"
          value={String(metrics.users_active_7d)}
          hint="signed in this week"
        />
        <Stat
          label="Teams"
          value={String(metrics.teams_total)}
          hint={`${metrics.team_members_total} membership${metrics.team_members_total === 1 ? '' : 's'}`}
        />
        <Stat
          label="Waypoints"
          value={String(metrics.waypoints_total)}
          hint={`+${metrics.waypoints_7d} this week · ${metrics.photos_total} photos`}
        />
        <Stat
          label="Datum records"
          value={String(metrics.sar_records_total)}
          hint={`+${metrics.sar_records_7d} this week`}
        />
        <Stat
          label="Open requests"
          value={String(metrics.requests_open)}
          hint={`${metrics.requests_in_progress} in progress · ${metrics.requests_total} all time`}
        />
        <Stat
          label="App errors"
          value={String(metrics.errors_24h)}
          hint={`last 24 h · ${metrics.errors_7d} this week`}
        />
        <Stat
          label="Photo storage"
          value={mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`}
          hint="waypoint-photos bucket"
        />
      </div>
      {kinds.length > 0 && (
        <p className="tnum mt-2 text-xs text-slate-500">
          Datum records by kind:{' '}
          {kinds.map(([k, n]) => `${k.replace('_', ' ')} ${n}`).join(' · ')}
        </p>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------ requests */

const REQUEST_FILTERS: { id: 'active' | RequestStatus | 'all'; label: string }[] = [
  { id: 'active', label: 'Needs action' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'dismissed', label: 'Dismissed' },
  { id: 'all', label: 'All' },
]

function RequestsSection() {
  const requests = useAdmin((s) => s.requests)
  const users = useAdmin((s) => s.users)
  const [filter, setFilter] = useState<'active' | RequestStatus | 'all'>('active')

  const shown = useMemo(() => {
    if (filter === 'all') return requests
    if (filter === 'active')
      return requests.filter((r) => r.status === 'open' || r.status === 'in_progress')
    return requests.filter((r) => r.status === filter)
  }, [requests, filter])

  const emailFor = (userId: string) =>
    users.find((u) => u.user_id === userId)?.email ?? 'unknown account'

  return (
    <Card>
      <Label>Support requests</Label>
      <div className="mb-2 flex gap-1">
        {REQUEST_FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={
              'flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
              (filter === f.id
                ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                : 'border-white/10 text-slate-400 hover:bg-white/5')
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState>
          {filter === 'active'
            ? 'No requests waiting — the queue is clear.'
            : 'Nothing here.'}
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {shown.map((r) => (
            <li key={r.id}>
              <RequestCard request={r} authorEmail={emailFor(r.user_id)} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function RequestCard({
  request: r,
  authorEmail,
}: {
  request: SupportRequest
  authorEmail: string
}) {
  const updateRequest = useAdmin((s) => s.updateRequest)
  const [notes, setNotes] = useState(r.admin_notes)
  const [busy, setBusy] = useState(false)

  async function setStatus(status: RequestStatus) {
    setBusy(true)
    try {
      const { error } = await updateRequest(r.id, status, notes.trim())
      toast(
        error ?? `Request ${STATUS_LABEL[status].toLowerCase()}`,
        error ? 'error' : 'success',
      )
    } finally {
      setBusy(false)
    }
  }

  const settled = r.status === 'resolved' || r.status === 'dismissed'

  return (
    <div className="rounded-xl border border-white/10 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="mr-2 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-semibold text-slate-300">
            {REQUEST_KIND_LABEL[r.kind] ?? r.kind}
          </span>
          <span className="font-semibold text-slate-100">{r.subject}</span>
        </div>
        <span
          className={
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
            STATUS_TONE[r.status]
          }
        >
          {STATUS_LABEL[r.status]}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {authorEmail} · {new Date(r.created_at).toLocaleString()}
      </p>
      {r.body && (
        <p className="mt-1.5 text-sm whitespace-pre-wrap text-slate-300">{r.body}</p>
      )}

      {settled ? (
        r.admin_notes && (
          <p className="mt-2 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-slate-400">
            Admin note: {r.admin_notes}
          </p>
        )
      ) : (
        <>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Note back to the requester (they see this)…"
            rows={2}
            aria-label="Admin note"
            className="mt-2 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
          />
          <div className="mt-2 grid grid-cols-3 gap-2">
            {r.status === 'open' && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void setStatus('in_progress')}
              >
                Start
              </Button>
            )}
            {r.status === 'in_progress' && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void setStatus('open')}
              >
                Reopen
              </Button>
            )}
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void setStatus('resolved')}
            >
              {busy && <Spinner />} Resolve
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (!confirm('Dismiss without resolving?')) return
                void setStatus('dismissed')
              }}
            >
              Dismiss
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- users */

function UsersSection() {
  const users = useAdmin((s) => s.users)
  const [query, setQuery] = useState('')

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        u.full_name.toLowerCase().includes(q) ||
        u.callsign.toLowerCase().includes(q),
    )
  }, [users, query])

  return (
    <Card>
      <Label>Accounts ({users.length})</Label>
      {users.length > 3 && (
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search email, name or callsign…"
          aria-label="Search accounts"
          className="mb-2"
        />
      )}
      {shown.length === 0 ? (
        <EmptyState>No accounts match.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {shown.map((u) => (
            <li key={u.user_id}>
              <UserCard user={u} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function UserCard({ user: u }: { user: AdminUser }) {
  const updateProfile = useAdmin((s) => s.updateProfile)
  const [editing, setEditing] = useState(false)
  const [fullName, setFullName] = useState(u.full_name)
  const [callsign, setCallsign] = useState(u.callsign)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const { error } = await updateProfile(
        u.user_id,
        fullName.trim(),
        callsign.trim(),
      )
      toast(error ?? 'Profile updated', error ? 'error' : 'success')
      if (!error) setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-white/10 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-100">
            {u.email}
            {u.is_admin && (
              <span className="ml-2 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
                Admin
              </span>
            )}
          </div>
          {!editing && (
            <div className="truncate text-xs text-slate-400">
              {u.full_name || 'No name'}
              {u.callsign ? ` · ${u.callsign}` : ''}
            </div>
          )}
        </div>
        {!editing && (
          <button
            onClick={() => {
              setFullName(u.full_name)
              setCallsign(u.callsign)
              setEditing(true)
            }}
            className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/5"
          >
            Edit profile
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-2">
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Full name"
              aria-label={`Full name for ${u.email}`}
            />
            <Input
              value={callsign}
              onChange={(e) => setCallsign(e.target.value)}
              placeholder="Callsign"
              aria-label={`Callsign for ${u.email}`}
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {busy && <Spinner />} Save
            </Button>
          </div>
        </div>
      )}

      <p className="tnum mt-1.5 text-xs text-slate-500">
        Joined {new Date(u.created_at).toLocaleDateString()} · last seen{' '}
        {u.last_sign_in_at
          ? new Date(u.last_sign_in_at).toLocaleString()
          : 'never'}{' '}
        · {u.team_count} team{u.team_count === 1 ? '' : 's'} · {u.waypoint_count}{' '}
        waypoint{u.waypoint_count === 1 ? '' : 's'} · {u.sar_record_count} datum
        record{u.sar_record_count === 1 ? '' : 's'}
        {u.open_requests > 0 && (
          <span className="text-amber-300"> · {u.open_requests} open request{u.open_requests === 1 ? '' : 's'}</span>
        )}
      </p>
    </div>
  )
}
