import { useEffect, useMemo, useState } from 'react'
import { useTracker } from '@/store/useTracker'
import { useTeams } from '@/store/useTeams'
import { useSarRecords } from '@/store/useSarRecords'
import { useIncidents } from '@/store/useIncidents'
import { useWaypoints } from '@/store/useWaypoints'
import { useOnline } from '@/hooks/useOnline'
import { useNow } from '@/hooks/useNow'
import { toast } from '@/store/useToast'
import { parseCoord, toDD, toDMS } from '@/lib/coords'
import { formatBearing, formatDistance, formatDuration } from '@/lib/geo'
import { download } from '@/lib/transfer'
import {
  SEARCH_OBJECT_TYPES,
  searchObjectType,
  computeDatum,
  observedDrift,
  datumReport,
  LKP_ERROR_NM,
  type LkpSource,
} from '@/lib/sar'
import { Button, Card, EmptyState, Input, Label, Stat } from '@/components/ui'
import { IncidentCard } from '@/components/IncidentCard'
import type {
  CluePayload,
  DriftMarkerPayload,
  EnvironmentPayload,
  LkpPayload,
  SarRecord,
} from '@/lib/types'

/**
 * The datum section: what a single unit collects while searching for a
 * victim, and the worksheet that turns it into a place to search.
 *
 * Everything here writes through the offline queue — the LKP taken out of
 * coverage is precisely the one that must not be lost — and everything is
 * shaped to feed RescueGPS's drift engine when the unit is back in coverage.
 */
export function DatumTab() {
  const once = useTracker((s) => s.once)
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const {
    visible,
    load,
    createRecord,
    updateRecord,
    removeRecord,
    pendingCount,
    failed,
    retryFailed,
    discardFailed,
  } = useSarRecords()
  const online = useOnline()
  const incident = useIncidents((s) => s.activeIncident(activeTeamId))

  useEffect(() => {
    void load()
    void useIncidents.getState().load()
  }, [load])

  const all = visible()
  // Same scoping rule as every other list: the team switcher in the header
  // decides what this page is looking at.
  const records = useMemo(
    () =>
      all.filter((r) =>
        activeTeamId ? r.team_id === activeTeamId : r.team_id === null,
      ),
    [all, activeTeamId],
  )

  const lkp = records.find((r) => r.kind === 'lkp') ?? null
  const environment = records.find((r) => r.kind === 'environment') ?? null
  const markers = records.filter((r) => r.kind === 'drift_marker')
  const clues = records.filter((r) => r.kind === 'clue')
  const queued = pendingCount()

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">Search datum</h2>
        <p className="text-sm text-slate-300">
          Log the LKP, the conditions and what you find; the worksheet keeps
          the datum current. Everything works offline and syncs later.
        </p>
        {queued > 0 && (
          <p className="mt-1 text-xs text-sky-300">
            {queued} record{queued === 1 ? '' : 's'} waiting to sync
            {online ? '' : ' — offline'}.
          </p>
        )}
      </div>

      {failed.length > 0 && (
        <div className="rounded-xl bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
          <p>
            {failed.length} record{failed.length === 1 ? '' : 's'} the server
            refused — {failed[0].reason}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void retryFailed()}
              className="rounded-lg border border-amber-400/30 px-2.5 py-1 text-xs hover:bg-amber-500/10"
            >
              Retry
            </button>
            <button
              onClick={() => {
                if (!confirm('Discard the refused records for good?')) return
                discardFailed()
              }}
              className="rounded-lg border border-red-400/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/10"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      <IncidentCard />

      <LkpCard
        lkp={lkp}
        onSave={async (input) => {
          const created = await createRecord({
            ...input,
            team_id: activeTeamId,
            incident_id: incident?.id ?? null,
          })
          // The incident carries the LKP in RescueGPS's own columns, so the
          // handoff row is always current. incident_time is only set once —
          // it means "went into the water", and a corrected LKP later must
          // not restart the drift clock.
          if (created && incident) {
            await useIncidents.getState().updateIncident(incident.id, {
              lkp_lat: input.lat,
              lkp_lng: input.lon,
              lkp_time: input.recorded_at,
              lkp_source:
                input.payload.source === 'gps'
                  ? 'field_gps'
                  : input.payload.source,
              ...(incident.incident_time
                ? {}
                : { incident_time: input.recorded_at }),
            })
          }
          toast(
            created
              ? online
                ? 'LKP recorded'
                : 'LKP recorded offline — will sync later'
              : 'Could not record the LKP',
            created ? 'success' : 'error',
          )
        }}
        takeFix={once}
      />

      <ConditionsCard
        environment={environment}
        onSave={async (payload, note) => {
          const created = await createRecord({
            kind: 'environment',
            lat: null,
            lon: null,
            recorded_at: new Date().toISOString(),
            payload,
            note,
            team_id: activeTeamId,
            incident_id: incident?.id ?? null,
          })
          toast(
            created ? 'Conditions recorded' : 'Could not record conditions',
            created ? 'success' : 'error',
          )
        }}
      />

      <DriftMarkerCard
        markers={markers}
        onDeploy={async (markerType) => {
          const fix = await once()
          if (!fix) {
            toast(useTracker.getState().error ?? 'No GPS fix', 'error')
            return
          }
          const time = new Date(fix.timestamp).toISOString()
          const payload: DriftMarkerPayload = {
            marker_type: markerType,
            deploy: { lat: fix.lat, lon: fix.lon, time },
          }
          const created = await createRecord({
            kind: 'drift_marker',
            lat: fix.lat,
            lon: fix.lon,
            recorded_at: time,
            payload,
            note: '',
            team_id: activeTeamId,
            incident_id: incident?.id ?? null,
          })
          toast(
            created ? 'Marker deployed — position logged' : 'Could not log the marker',
            created ? 'success' : 'error',
          )
        }}
        onRetrieve={async (marker) => {
          const fix = await once()
          if (!fix) {
            toast(useTracker.getState().error ?? 'No GPS fix', 'error')
            return
          }
          const p = marker.payload as DriftMarkerPayload
          const obs = observedDrift(
            {
              lat: p.deploy.lat,
              lon: p.deploy.lon,
              time: new Date(p.deploy.time).getTime(),
            },
            { lat: fix.lat, lon: fix.lon, time: fix.timestamp },
          )
          if (!obs) {
            toast('Retrieve time is not after the deploy time', 'error')
            return
          }
          const patch: Partial<SarRecord> = {
            payload: {
              ...p,
              retrieve: {
                lat: fix.lat,
                lon: fix.lon,
                time: new Date(fix.timestamp).toISOString(),
              },
              set_deg: obs.setDeg,
              drift_kts: obs.driftKts,
              distance_nm: obs.distanceNM,
              hours: obs.hours,
            },
          }
          await updateRecord(marker.id, patch)
          toast(
            `Set ${Math.round(obs.setDeg)}°, drift ${obs.driftKts.toFixed(2)} kn observed`,
            'success',
          )
        }}
        onUseAsCurrent={async (p) => {
          const payload: EnvironmentPayload = {
            current_toward_deg: p.set_deg ?? null,
            current_kts: p.drift_kts ?? null,
          }
          const created = await createRecord({
            kind: 'environment',
            lat: null,
            lon: null,
            recorded_at: new Date().toISOString(),
            payload,
            note: 'From drift marker observation',
            team_id: activeTeamId,
            incident_id: incident?.id ?? null,
          })
          toast(
            created
              ? 'Observed set and drift now feed the worksheet'
              : 'Could not record it',
            created ? 'success' : 'error',
          )
        }}
      />

      <WorksheetCard lkp={lkp} environment={environment} markers={markers} clues={clues} />

      <ClueCard
        clues={clues}
        onLog={async (clueType, note) => {
          const fix = await once()
          const time = fix ? new Date(fix.timestamp).toISOString() : new Date().toISOString()
          const payload: CluePayload = { clue_type: clueType }
          const created = await createRecord({
            kind: 'clue',
            lat: fix?.lat ?? null,
            lon: fix?.lon ?? null,
            recorded_at: time,
            payload,
            note,
            team_id: activeTeamId,
            incident_id: incident?.id ?? null,
          })
          toast(
            created
              ? fix
                ? 'Clue logged with position'
                : 'Clue logged — no GPS fix, position blank'
              : 'Could not log the clue',
            created ? 'success' : 'error',
          )
        }}
        onRemove={async (id) => {
          await removeRecord(id)
          toast('Clue removed')
        }}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------
 * LKP
 * ---------------------------------------------------------------------- */

const SOURCES: { id: LkpSource; label: string }[] = [
  { id: 'gps', label: 'GPS fix' },
  { id: 'witness', label: 'Witness' },
  { id: 'estimated', label: 'Estimated' },
]

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function LkpCard({
  lkp,
  onSave,
  takeFix,
}: {
  lkp: SarRecord | null
  onSave: (input: {
    kind: 'lkp'
    lat: number
    lon: number
    recorded_at: string
    payload: LkpPayload
    note: string
  }) => Promise<void>
  takeFix: () => Promise<{ lat: number; lon: number } | null>
}) {
  const [editing, setEditing] = useState(false)
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [time, setTime] = useState(() => toLocalInput(new Date()))
  const [source, setSource] = useState<LkpSource>('witness')
  const [objectType, setObjectType] = useState('person_in_water')
  const [errorNM, setErrorNM] = useState(String(LKP_ERROR_NM.witness))
  const [note, setNote] = useState('')

  const payload = lkp?.payload as LkpPayload | undefined
  const showForm = editing || !lkp

  async function save() {
    const pLat = parseCoord(lat, 'lat')
    const pLon = parseCoord(lon, 'lon')
    if (!Number.isFinite(pLat) || !Number.isFinite(pLon)) {
      toast('Enter a valid last known position', 'error')
      return
    }
    const at = new Date(time)
    if (Number.isNaN(at.getTime())) {
      toast('Enter the time the victim was last seen', 'error')
      return
    }
    const err = parseFloat(errorNM)
    await onSave({
      kind: 'lkp',
      lat: pLat,
      lon: pLon,
      recorded_at: at.toISOString(),
      payload: {
        source,
        object_type: objectType,
        position_error_nm:
          Number.isFinite(err) && err >= 0 ? err : LKP_ERROR_NM[source],
      },
      note: note.trim(),
    })
    setEditing(false)
    setNote('')
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <Label>Last known position (LKP)</Label>
        {lkp && !showForm && (
          <button
            onClick={() => {
              setLat(toDD(lkp.lat ?? Number.NaN))
              setLon(toDD(lkp.lon ?? Number.NaN))
              setTime(toLocalInput(new Date(lkp.recorded_at)))
              if (payload) {
                setSource(payload.source)
                setObjectType(payload.object_type)
                setErrorNM(String(payload.position_error_nm))
              }
              setEditing(true)
            }}
            className="mb-1.5 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
          >
            Update LKP
          </button>
        )}
      </div>

      {!showForm && lkp ? (
        <div className="space-y-1 text-sm">
          <div className="tnum text-slate-100">
            {toDD(lkp.lat ?? Number.NaN)}, {toDD(lkp.lon ?? Number.NaN)}
          </div>
          <div className="tnum text-xs text-slate-400">
            {toDMS(lkp.lat ?? Number.NaN, 'lat')} {toDMS(lkp.lon ?? Number.NaN, 'lon')}
          </div>
          <div className="text-slate-300">
            Last seen {new Date(lkp.recorded_at).toLocaleString()}
          </div>
          {payload && (
            <div className="text-xs text-slate-400">
              {SOURCES.find((s) => s.id === payload.source)?.label} · ±
              {payload.position_error_nm} NM ·{' '}
              {searchObjectType(payload.object_type).label}
            </div>
          )}
          {lkp.note && <p className="text-xs text-slate-300">{lkp.note}</p>}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="Latitude"
              inputMode="decimal"
              aria-label="LKP latitude"
            />
            <Input
              value={lon}
              onChange={(e) => setLon(e.target.value)}
              placeholder="Longitude"
              inputMode="decimal"
              aria-label="LKP longitude"
            />
          </div>
          <Button
            variant="ghost"
            className="mt-2 w-full"
            onClick={async () => {
              const fix = await takeFix()
              if (!fix) {
                toast(useTracker.getState().error ?? 'No fix', 'error')
                return
              }
              setLat(toDD(fix.lat))
              setLon(toDD(fix.lon))
              setSource('gps')
              setErrorNM(String(LKP_ERROR_NM.gps))
            }}
          >
            Use my position (on scene at the LKP)
          </Button>

          <div className="mt-2">
            <span className="mb-1 block text-xs text-slate-300">
              When was the victim last seen here?
            </span>
            <Input
              type="datetime-local"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label="Time last seen"
            />
          </div>

          <div className="mt-2 flex gap-1">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setSource(s.id)
                  setErrorNM(String(LKP_ERROR_NM[s.id]))
                }}
                className={
                  'flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ' +
                  (source === s.id
                    ? 'border-sky-400/60 bg-sky-500/15 text-sky-300'
                    : 'border-white/10 text-slate-300 hover:bg-white/5')
                }
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <span className="mb-1 block text-xs text-slate-300">
                Search object
              </span>
              <select
                value={objectType}
                onChange={(e) => setObjectType(e.target.value)}
                className="min-h-11 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
                aria-label="Search object type"
              >
                {SEARCH_OBJECT_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="mb-1 block text-xs text-slate-300">
                Position error (NM)
              </span>
              <Input
                value={errorNM}
                onChange={(e) => setErrorNM(e.target.value)}
                inputMode="decimal"
                aria-label="LKP position error in nautical miles"
              />
            </div>
          </div>

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Notes — who saw them, what they were wearing, activity…"
            rows={2}
            aria-label="LKP notes"
            className="mt-2 w-full rounded-xl border border-white/10 bg-navy-950/60 px-3 py-2 text-slate-100 placeholder:text-slate-400 focus:border-sky-400/60 focus:outline-none"
          />

          <div className="mt-3 grid grid-cols-2 gap-2">
            {lkp ? (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : (
              <span />
            )}
            <Button variant="primary" onClick={() => void save()}>
              Record LKP
            </Button>
          </div>
          {lkp && (
            <p className="mt-1.5 text-xs text-slate-400">
              Recording again keeps the old LKP as history — the newest one
              drives the worksheet.
            </p>
          )}
        </>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------
 * Conditions
 * ---------------------------------------------------------------------- */

function ConditionsCard({
  environment,
  onSave,
}: {
  environment: SarRecord | null
  onSave: (payload: EnvironmentPayload, note: string) => Promise<void>
}) {
  const p = environment?.payload as EnvironmentPayload | undefined
  const [windFrom, setWindFrom] = useState('')
  const [windKts, setWindKts] = useState('')
  const [currentToward, setCurrentToward] = useState('')
  const [currentKts, setCurrentKts] = useState('')
  const [waterTemp, setWaterTemp] = useState('')

  useEffect(() => {
    setWindFrom(p?.wind_from_deg != null ? String(p.wind_from_deg) : '')
    setWindKts(p?.wind_kts != null ? String(p.wind_kts) : '')
    setCurrentToward(
      p?.current_toward_deg != null ? String(p.current_toward_deg) : '',
    )
    setCurrentKts(p?.current_kts != null ? String(p.current_kts) : '')
    setWaterTemp(p?.water_temp_c != null ? String(p.water_temp_c) : '')
  }, [environment?.id])

  const num = (s: string): number | null => {
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : null
  }

  const deg = (s: string): number | null => {
    const n = num(s)
    return n === null ? null : ((n % 360) + 360) % 360
  }

  return (
    <Card>
      <Label>On-scene conditions</Label>
      <p className="mb-2 text-xs text-slate-400">
        Wind is where it blows <em>from</em>; current is where it flows{' '}
        <em>toward</em> — the conventions RescueGPS uses. A retrieved drift
        marker beats any estimate; log one below.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="mb-1 block text-xs text-slate-300">
            Wind from (°T)
          </span>
          <Input
            value={windFrom}
            onChange={(e) => setWindFrom(e.target.value)}
            placeholder="e.g. 180"
            inputMode="numeric"
            aria-label="Wind direction from, degrees true"
          />
        </div>
        <div>
          <span className="mb-1 block text-xs text-slate-300">Wind (kn)</span>
          <Input
            value={windKts}
            onChange={(e) => setWindKts(e.target.value)}
            placeholder="e.g. 12"
            inputMode="decimal"
            aria-label="Wind speed, knots"
          />
        </div>
        <div>
          <span className="mb-1 block text-xs text-slate-300">
            Current toward (°T)
          </span>
          <Input
            value={currentToward}
            onChange={(e) => setCurrentToward(e.target.value)}
            placeholder="e.g. 045"
            inputMode="numeric"
            aria-label="Current direction toward, degrees true"
          />
        </div>
        <div>
          <span className="mb-1 block text-xs text-slate-300">Current (kn)</span>
          <Input
            value={currentKts}
            onChange={(e) => setCurrentKts(e.target.value)}
            placeholder="e.g. 1.5"
            inputMode="decimal"
            aria-label="Current speed, knots"
          />
        </div>
      </div>
      <div className="mt-2">
        <span className="mb-1 block text-xs text-slate-300">
          Water temp (°C, for the survival clock)
        </span>
        <Input
          value={waterTemp}
          onChange={(e) => setWaterTemp(e.target.value)}
          placeholder="optional"
          inputMode="decimal"
          aria-label="Water temperature, Celsius"
        />
      </div>

      <Button
        variant="primary"
        className="mt-3 w-full"
        onClick={() =>
          void onSave(
            {
              wind_from_deg: deg(windFrom),
              wind_kts: num(windKts),
              current_toward_deg: deg(currentToward),
              current_kts: num(currentKts),
              water_temp_c: num(waterTemp),
            },
            '',
          )
        }
      >
        Record conditions
      </Button>
      {environment && (
        <p className="mt-1.5 text-xs text-slate-400">
          Last recorded {new Date(environment.recorded_at).toLocaleString()}
          {environment.note ? ` · ${environment.note}` : ''}. Each recording is
          kept — conditions change and the history matters.
        </p>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------
 * Drift markers
 * ---------------------------------------------------------------------- */

const MARKER_TYPES: DriftMarkerPayload['marker_type'][] = [
  'orange',
  'smoke',
  'dye',
  'debris',
  'custom',
]

function DriftMarkerCard({
  markers,
  onDeploy,
  onRetrieve,
  onUseAsCurrent,
}: {
  markers: SarRecord[]
  onDeploy: (markerType: DriftMarkerPayload['marker_type']) => Promise<void>
  onRetrieve: (marker: SarRecord) => Promise<void>
  onUseAsCurrent: (payload: DriftMarkerPayload) => Promise<void>
}) {
  const [markerType, setMarkerType] =
    useState<DriftMarkerPayload['marker_type']>('orange')
  const [busy, setBusy] = useState(false)

  return (
    <Card>
      <Label>Drift marker</Label>
      <p className="mb-2 text-xs text-slate-400">
        Throw something that floats like the victim, log it, come back to it.
        The measured set and drift is the truest current you will get.
      </p>

      <div className="flex gap-2">
        <select
          value={markerType}
          onChange={(e) =>
            setMarkerType(e.target.value as DriftMarkerPayload['marker_type'])
          }
          className="min-h-11 flex-1 rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
          aria-label="Marker type"
        >
          {MARKER_TYPES.map((t) => (
            <option key={t} value={t}>
              {t === 'orange' ? 'Orange marker' : t[0].toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onDeploy(markerType)
            } finally {
              setBusy(false)
            }
          }}
        >
          Deploy here
        </Button>
      </div>

      {markers.length > 0 && (
        <ul className="mt-3 space-y-2">
          {markers.map((m) => {
            const p = m.payload as DriftMarkerPayload
            const retrieved = p.retrieve != null
            return (
              <li
                key={m.id}
                className="rounded-xl border border-white/10 px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-100 capitalize">
                    {p.marker_type} marker
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(p.deploy.time).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                {retrieved ? (
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="tnum text-xs text-slate-300">
                      Set {formatBearing(p.set_deg ?? Number.NaN)} · drift{' '}
                      {(p.drift_kts ?? 0).toFixed(2)} kn over{' '}
                      {formatDuration(p.hours ?? 0)}
                    </span>
                    <button
                      onClick={() => void onUseAsCurrent(p)}
                      className="shrink-0 rounded-lg border border-sky-400/40 px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/10"
                    >
                      Use as current
                    </button>
                  </div>
                ) : (
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="tnum text-xs text-slate-400">
                      In the water at {toDD(p.deploy.lat, 4)},{' '}
                      {toDD(p.deploy.lon, 4)}
                    </span>
                    <button
                      onClick={() => void onRetrieve(m)}
                      className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-xs text-slate-300 hover:bg-white/5"
                    >
                      Retrieve here
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------
 * The worksheet
 * ---------------------------------------------------------------------- */

function WorksheetCard({
  lkp,
  environment,
  markers,
  clues,
}: {
  lkp: SarRecord | null
  environment: SarRecord | null
  markers: SarRecord[]
  clues: SarRecord[]
}) {
  const now = useNow(30_000)
  const create = useWaypoints((s) => s.create)
  const activeTeamId = useTeams((s) => s.activeTeamId)
  const [email, setEmail] = useState('')

  const lkpPayload = lkp?.payload as LkpPayload | undefined
  const env = environment?.payload as EnvironmentPayload | undefined

  const result = useMemo(() => {
    if (!lkp || lkp.lat == null || lkp.lon == null || !lkpPayload) return null
    return computeDatum({
      lkp: {
        lat: lkp.lat,
        lon: lkp.lon,
        time: new Date(lkp.recorded_at).getTime(),
      },
      at: now.getTime(),
      objectType: searchObjectType(lkpPayload.object_type),
      windFromDeg: env?.wind_from_deg ?? null,
      windKts: env?.wind_kts ?? null,
      currentTowardDeg: env?.current_toward_deg ?? null,
      currentKts: env?.current_kts ?? null,
      lkpErrorNM: lkpPayload.position_error_nm,
    })
  }, [lkp, lkpPayload, env, now])

  function buildReport(): string | null {
    if (!lkp || !result || lkp.lat == null || lkp.lon == null || !lkpPayload)
      return null
    return datumReport({
      lkp: {
        lat: lkp.lat,
        lon: lkp.lon,
        time: new Date(lkp.recorded_at).getTime(),
        source: lkpPayload.source,
        errorNM: lkpPayload.position_error_nm,
        note: lkp.note,
      },
      objectTypeKey: lkpPayload.object_type,
      windFromDeg: env?.wind_from_deg ?? null,
      windKts: env?.wind_kts ?? null,
      currentTowardDeg: env?.current_toward_deg ?? null,
      currentKts: env?.current_kts ?? null,
      waterTempC: env?.water_temp_c ?? null,
      result,
      observations: markers
        .map((m) => m.payload as DriftMarkerPayload)
        .filter((p) => p.set_deg != null)
        .map((p) => ({
          setDeg: p.set_deg!,
          driftKts: p.drift_kts!,
          distanceNM: p.distance_nm!,
          hours: p.hours!,
          deployTime: new Date(p.deploy.time).getTime(),
        })),
      clues: clues.map((c) => ({
        type: (c.payload as CluePayload).clue_type,
        lat: c.lat,
        lon: c.lon,
        time: new Date(c.recorded_at).getTime(),
        note: c.note,
      })),
    })
  }

  if (!lkp || !result) {
    return (
      <Card>
        <Label>Datum worksheet</Label>
        <EmptyState>
          Record an LKP above and the worksheet computes the datum — where the
          victim most probably is now — and the radius to search around it.
        </EmptyState>
      </Card>
    )
  }

  const hasDrift = result.driftKts > 0

  return (
    <Card>
      <Label>Datum worksheet</Label>
      <p className="mb-2 text-xs text-slate-400">
        LKP carried {formatDuration(result.hoursAdrift)} by{' '}
        {hasDrift
          ? `${result.driftKts.toFixed(2)} kn toward ${formatBearing(result.driftBearingDeg)}`
          : 'no recorded wind or current'}
        {env?.wind_kts ? ` · leeway ${result.leewayKts.toFixed(2)} kn` : ''}.
        First-cut only — RescueGPS runs the full drift model from this same
        data.
      </p>

      <div className="rounded-xl border border-sky-400/30 bg-sky-500/5 px-3 py-2.5">
        <div className="text-[11px] font-semibold tracking-wide text-sky-300 uppercase">
          Datum — search around here
        </div>
        <div className="tnum mt-0.5 text-lg font-semibold text-slate-50">
          {toDD(result.datum.lat)}, {toDD(result.datum.lon)}
        </div>
        <div className="tnum text-xs text-slate-300">
          {toDMS(result.datum.lat, 'lat')} {toDMS(result.datum.lon, 'lon')}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat
          label="Drifted"
          value={formatDistance(result.driftDistanceNM, 'nm')}
        />
        <Stat
          label="Radius"
          value={formatDistance(result.searchRadiusNM, 'nm')}
          hint="1.1 × total error"
        />
        <Stat
          label="Error"
          value={formatDistance(result.totalErrorNM, 'nm')}
          hint="RSS, drift 30%"
        />
      </div>

      {hasDrift && result.leewayKts > 0 && (
        <p className="tnum mt-2 text-xs text-slate-400">
          Leeway divergence: also mark {toDD(result.datumLeft.lat, 4)},{' '}
          {toDD(result.datumLeft.lon, 4)} and {toDD(result.datumRight.lat, 4)},{' '}
          {toDD(result.datumRight.lon, 4)}.
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          onClick={async () => {
            const stamp = new Date().toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
            const saved = await create({
              name: `DATUM ${stamp}`,
              lat: result.datum.lat,
              lon: result.datum.lon,
              note:
                `Search datum computed ${new Date().toLocaleString()}. ` +
                `Radius ${result.searchRadiusNM.toFixed(2)} NM. ` +
                `LKP ${toDD(lkp.lat!)}, ${toDD(lkp.lon!)} at ${new Date(lkp.recorded_at).toLocaleString()}.`,
              team_id: activeTeamId,
            })
            toast(
              saved
                ? 'Datum saved as a waypoint — ETA, Compass and Track can use it now'
                : 'Could not save the waypoint',
              saved ? 'success' : 'error',
            )
          }}
        >
          Save as waypoint
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const report = buildReport()
            if (!report) return
            const stamp = new Date().toISOString().slice(0, 16).replace(':', '')
            download(`navmate-datum-${stamp}.json`, report, 'application/json')
            toast('Datum report exported', 'success')
          }}
        >
          Export report
        </Button>
      </div>

      <div className="mt-2 flex gap-2">
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email the report to…"
          inputMode="email"
          type="email"
          aria-label="Recipient email for the datum report"
        />
        <Button
          variant="ghost"
          onClick={() => {
            const report = buildReport()
            if (!report) return
            window.location.href =
              `mailto:${encodeURIComponent(email.trim())}` +
              `?subject=${encodeURIComponent('NavMate datum report')}` +
              `&body=${encodeURIComponent(report)}`
          }}
        >
          Email
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-slate-400">
        The report carries the LKP, conditions, observations and clues in
        RescueGPS's own field names, ready for its drift engine.
      </p>
    </Card>
  )
}

/* -------------------------------------------------------------------------
 * Clues
 * ---------------------------------------------------------------------- */

const CLUE_TYPES: { id: CluePayload['clue_type']; label: string }[] = [
  { id: 'debris', label: 'Debris' },
  { id: 'clothing', label: 'Clothing' },
  { id: 'vessel', label: 'Vessel' },
  { id: 'life_jacket', label: 'Life jacket' },
  { id: 'personal_item', label: 'Personal item' },
  { id: 'fuel_sheen', label: 'Fuel sheen' },
  { id: 'other', label: 'Other' },
]

function ClueCard({
  clues,
  onLog,
  onRemove,
}: {
  clues: SarRecord[]
  onLog: (type: CluePayload['clue_type'], note: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const [clueType, setClueType] = useState<CluePayload['clue_type']>('debris')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <Card>
      <Label>Clue log</Label>
      <p className="mb-2 text-xs text-slate-400">
        Anything found gets a position and a time — a clue is a datum in its
        own right, and RescueGPS back-drifts them to refine the origin. For
        photographs, stamp a waypoint at the clue too.
      </p>

      <div className="flex gap-2">
        <select
          value={clueType}
          onChange={(e) =>
            setClueType(e.target.value as CluePayload['clue_type'])
          }
          className="min-h-11 w-32 shrink-0 rounded-xl border border-white/10 bg-navy-950/60 px-3 text-slate-100 focus:border-sky-400/60 focus:outline-none"
          aria-label="Clue type"
        >
          {CLUE_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What did you find?"
          aria-label="Clue description"
        />
      </div>
      <Button
        variant="primary"
        className="mt-2 w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onLog(clueType, note.trim())
            setNote('')
          } finally {
            setBusy(false)
          }
        }}
      >
        Log clue at my position
      </Button>

      {clues.length > 0 && (
        <ul className="mt-3 space-y-2">
          {clues.map((c) => {
            const p = c.payload as CluePayload
            return (
              <li
                key={c.id}
                className="rounded-xl border border-white/10 px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-100">
                    {CLUE_TYPES.find((t) => t.id === p.clue_type)?.label ?? p.clue_type}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">
                      {new Date(c.recorded_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <button
                      onClick={() => {
                        if (!confirm('Remove this clue?')) return
                        void onRemove(c.id)
                      }}
                      className="rounded-lg border border-red-500/30 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/10"
                    >
                      ×
                    </button>
                  </div>
                </div>
                {c.lat != null && c.lon != null && (
                  <div className="tnum text-xs text-slate-400">
                    {toDD(c.lat)}, {toDD(c.lon)}
                  </div>
                )}
                {c.note && <p className="text-xs text-slate-300">{c.note}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
