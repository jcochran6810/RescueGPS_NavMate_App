import { useState } from 'react'
import { parseCoord, toDD, toDMS, toDDM, toUTM } from '@/lib/coords'
import { useTracker } from '@/store/useTracker'
import { useWaypoints } from '@/store/useWaypoints'
import { useTeams } from '@/store/useTeams'
import { toast } from '@/store/useToast'
import { Button, Card, Input, Label } from '@/components/ui'

/** Which field group the user last typed in — that one is left alone while the
 *  others reformat, so editing does not fight the cursor. */
type Source = 'dd' | 'dms' | 'ddm' | null

export function ConvertTab() {
  const [lat, setLat] = useState(Number.NaN)
  const [lon, setLon] = useState(Number.NaN)
  // Tracked per axis. One shared source meant editing the latitude re-parsed
  // the longitude from raw text that might belong to a different group — or,
  // after "Use my location", from an empty string, which silently destroyed
  // the other coordinate.
  const [source, setSource] = useState<{ lat: Source; lon: Source }>({
    lat: null,
    lon: null,
  })
  const [raw, setRaw] = useState({ lat: '', lon: '' })

  const once = useTracker((s) => s.once)
  const create = useWaypoints((s) => s.create)
  const activeTeamId = useTeams((s) => s.activeTeamId)

  const valid = Number.isFinite(lat) && Number.isFinite(lon)

  function edit(group: Exclude<Source, null>, which: 'lat' | 'lon', value: string) {
    setRaw((r) => ({ ...r, [which]: value }))
    setSource((s) => ({ ...s, [which]: group }))
    // Only the axis being typed in is re-parsed; the other keeps its value.
    const parsed = parseCoord(value, which)
    if (which === 'lat') setLat(parsed)
    else setLon(parsed)
  }

  /** Value for a group: echo the user's own text in the group being edited. */
  function show(group: Exclude<Source, null>, which: 'lat' | 'lon'): string {
    if (source[which] === group) return raw[which]
    const v = which === 'lat' ? lat : lon
    const axis = which === 'lat' ? 'lat' : 'lon'
    if (!Number.isFinite(v)) return ''
    if (group === 'dd') return toDD(v)
    if (group === 'dms') return toDMS(v, axis)
    return toDDM(v, axis)
  }

  function setFrom(nLat: number, nLon: number) {
    setLat(nLat)
    setLon(nLon)
    setSource({ lat: null, lon: null })
    setRaw({ lat: '', lon: '' })
  }

  function clear() {
    setFrom(Number.NaN, Number.NaN)
  }

  const invalidLat =
    source.lat !== null && raw.lat.trim() !== '' && !Number.isFinite(lat)
  const invalidLon =
    source.lon !== null && raw.lon.trim() !== '' && !Number.isFinite(lon)

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-50">
          Coordinate converter
        </h2>
        <p className="text-sm text-slate-400">
          Type in any format — the others follow.
        </p>
      </div>

      <Card>
        <Label>Decimal degrees (DD)</Label>
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={show('dd', 'lat')}
            onChange={(e) => edit('dd', 'lat', e.target.value)}
            placeholder="27.98785"
            inputMode="decimal"
            aria-label="Latitude, decimal degrees"
            aria-invalid={source.lat === 'dd' && invalidLat}
            className={source.lat === 'dd' && invalidLat ? 'border-red-400/60' : ''}
          />
          <Input
            value={show('dd', 'lon')}
            onChange={(e) => edit('dd', 'lon', e.target.value)}
            placeholder="-82.44712"
            inputMode="decimal"
            aria-label="Longitude, decimal degrees"
            aria-invalid={source.lon === 'dd' && invalidLon}
            className={source.lon === 'dd' && invalidLon ? 'border-red-400/60' : ''}
          />
        </div>
      </Card>

      <Card>
        <Label>Degrees minutes seconds (DMS)</Label>
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={show('dms', 'lat')}
            onChange={(e) => edit('dms', 'lat', e.target.value)}
            placeholder={`27° 59' 16.3" N`}
            aria-label="Latitude, degrees minutes seconds"
          />
          <Input
            value={show('dms', 'lon')}
            onChange={(e) => edit('dms', 'lon', e.target.value)}
            placeholder={`82° 26' 49.6" W`}
            aria-label="Longitude, degrees minutes seconds"
          />
        </div>
      </Card>

      <Card>
        <Label>Degrees decimal minutes (DDM)</Label>
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={show('ddm', 'lat')}
            onChange={(e) => edit('ddm', 'lat', e.target.value)}
            placeholder={`27° 59.272' N`}
            aria-label="Latitude, degrees decimal minutes"
          />
          <Input
            value={show('ddm', 'lon')}
            onChange={(e) => edit('ddm', 'lon', e.target.value)}
            placeholder={`82° 26.827' W`}
            aria-label="Longitude, degrees decimal minutes"
          />
        </div>
      </Card>

      <Card>
        <Label>UTM (WGS-84)</Label>
        <Input
          readOnly
          value={valid ? toUTM(lat, lon) : ''}
          placeholder="17R 356421 3096502"
          className="tnum"
          aria-label="UTM coordinate"
        />
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <Button
          onClick={async () => {
            const fix = await once()
            if (fix) {
              setFrom(fix.lat, fix.lon)
              toast('Location loaded', 'success')
            } else {
              toast(useTracker.getState().error ?? 'No fix', 'error')
            }
          }}
        >
          Use my location
        </Button>
        <Button variant="ghost" onClick={clear}>
          Clear
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            if (!valid) return toast('Enter coordinates first', 'error')
            const text = `${toDD(lat)}, ${toDD(lon)}`
            try {
              await navigator.clipboard.writeText(text)
              toast(`Copied ${text}`, 'success')
            } catch {
              toast(text)
            }
          }}
        >
          Copy
        </Button>
        <Button
          variant="primary"
          onClick={async () => {
            if (!valid) return toast('Enter coordinates first', 'error')
            const saved = await create({
              name: `Waypoint ${new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}`,
              lat,
              lon,
              note: '',
              team_id: activeTeamId,
            })
            toast(saved ? 'Saved to waypoints' : 'Could not save', saved ? 'success' : 'error')
          }}
        >
          Save as waypoint
        </Button>
      </div>
    </div>
  )
}
