import { useRef, useState } from 'react'
import { useWaypoints } from '@/store/useWaypoints'
import { useTeams } from '@/store/useTeams'
import { useOnline } from '@/hooks/useOnline'
import { toast } from '@/store/useToast'
import { download, parseImport, serialize, type ExportFormat } from '@/lib/transfer'
import { toDD } from '@/lib/coords'
import { Button, Card, Input, Label, Spinner } from '@/components/ui'

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'json', label: 'JSON' },
  { id: 'gpx', label: 'GPX' },
  { id: 'csv', label: 'CSV' },
]

export function DataTab() {
  const {
    visible,
    importMany,
    clearLocal,
    load,
    pendingCount,
    lastSyncedAt,
    syncing,
    flush,
  } = useWaypoints()
  const { activeTeamId, activeTeam } = useTeams()
  const online = useOnline()

  const [email, setEmail] = useState('')
  const [importing, setImporting] = useState(false)
  const [scopeAll, setScopeAll] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const queued = pendingCount()
  const team = activeTeam()
  const all = visible()

  // Default to the scope shown on the Waypoints tab, so the count here matches
  // the list the user just looked at.
  const waypoints = scopeAll
    ? all
    : all.filter((w) =>
        activeTeamId ? w.team_id === activeTeamId : w.team_id === null,
      )

  const scopeLabel = scopeAll
    ? 'every waypoint on this account'
    : team
      ? `shared with ${team.name}`
      : 'private waypoints'

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Data</h2>
        <p className="text-sm text-slate-400">
          Waypoints sync to your account. Export or back them up here.
        </p>
      </div>

      <Card>
        <Label>Sync</Label>
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-slate-300">
            {queued > 0 ? (
              <span className="text-sky-300">
                {queued} change{queued === 1 ? '' : 's'} waiting
              </span>
            ) : (
              <span className="text-emerald-300">Everything synced</span>
            )}
            <div className="text-xs text-slate-500">
              {lastSyncedAt
                ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}`
                : 'Not synced yet'}
              {!online && ' · offline'}
            </div>
          </div>
          <Button
            onClick={async () => {
              await flush()
              await load()
              toast(online ? 'Synced' : 'Still offline', online ? 'success' : 'error')
            }}
            disabled={syncing || !online}
          >
            {syncing && <Spinner />}
            Sync now
          </Button>
        </div>
      </Card>

      <Card>
        <Label>
          Save to device ({waypoints.length} waypoint
          {waypoints.length === 1 ? '' : 's'})
        </Label>
        <div className="mb-3 flex gap-1">
          {[
            { id: false, label: team ? team.name : 'Private' },
            { id: true, label: 'Everything' },
          ].map((s) => (
            <button
              key={String(s.id)}
              onClick={() => setScopeAll(s.id)}
              className={
                'flex-1 truncate rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
                (scopeAll === s.id
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                  : 'border-white/10 text-slate-400 hover:bg-white/5')
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {FORMATS.map((f) => (
            <Button
              key={f.id}
              onClick={() => {
                if (waypoints.length === 0)
                  return toast('No waypoints to export', 'error')
                const { filename, body, mime } = serialize(waypoints, f.id)
                download(filename, body, mime)
                toast(`Exported ${f.label}`, 'success')
              }}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Exporting {scopeLabel}. Photos are not embedded — they stay in cloud
          storage and travel with your account.
        </p>
      </Card>

      <Card>
        <Label>Send by email</Label>
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="recipient@example.com"
          inputMode="email"
          type="email"
        />
        <Button
          className="mt-2"
          onClick={() => {
            if (waypoints.length === 0)
              return toast('No waypoints to send', 'error')
            const body = waypoints
              .map(
                (w) =>
                  `${w.name}\n${toDD(w.lat)}, ${toDD(w.lon)}${
                    w.note ? `\n${w.note}` : ''
                  }`,
              )
              .join('\n\n')
            window.location.href =
              `mailto:${encodeURIComponent(email.trim())}` +
              `?subject=${encodeURIComponent('NavMate waypoints')}` +
              `&body=${encodeURIComponent(body)}`
          }}
        >
          Open email with data
        </Button>
        <p className="mt-1.5 text-xs text-slate-500">
          Opens your mail app with the waypoints pasted in. For a file
          attachment, export JSON above and attach it.
        </p>
      </Card>

      <Card>
        <Label>Restore from a backup file</Label>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json,.gpx,application/gpx+xml,text/csv,.csv"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            setImporting(true)
            try {
              const text = await file.text()
              const parsed = parseImport(text, file.name)
              if (parsed.length === 0) {
                toast('No usable waypoints in that file', 'error')
                return
              }
              const n = await importMany(parsed, activeTeamId)
              toast(`Imported ${n} waypoint${n === 1 ? '' : 's'}`, 'success')
            } catch (err) {
              toast(
                `Import failed: ${err instanceof Error ? err.message : 'bad file'}`,
                'error',
              )
            } finally {
              setImporting(false)
              if (fileRef.current) fileRef.current.value = ''
            }
          }}
        />
        <Button onClick={() => fileRef.current?.click()} disabled={importing}>
          {importing && <Spinner />}
          Import JSON / GPX / CSV
        </Button>
        <p className="mt-1.5 text-xs text-slate-500">
          Imported waypoints go into your current scope
          {activeTeamId ? ' and are shared with the active team' : ' as private'}.
        </p>
      </Card>

      <Card className="border-red-500/25">
        <Label>Danger zone</Label>
        <Button
          variant="danger"
          onClick={() => {
            if (
              !confirm(
                'Clear the local copy on this device? Anything already synced ' +
                  'stays in your account and will download again. Unsynced ' +
                  'changes will be lost.',
              )
            )
              return
            clearLocal()
            void load()
            toast('Local copy cleared')
          }}
        >
          Clear local copy
        </Button>
        <p className="mt-1.5 text-xs text-slate-500">
          This does not delete waypoints from your account — delete those
          individually on the Waypoints tab.
        </p>
      </Card>
    </div>
  )
}
