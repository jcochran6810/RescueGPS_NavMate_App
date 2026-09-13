import { useEffect, useRef, useState } from 'react'
import {
  ddmParts,
  dmsParts,
  parseCoord,
  toDD,
  toDDM,
  toDMS,
  type Axis,
} from '@/lib/coords'
import {
  COORD_FORMATS,
  useCoordFormat,
  type CoordFormat,
} from '@/store/useCoordFormat'
import { Button, Input, Segmented } from '@/components/ui'

/**
 * One position, typed in whichever format the crew reads.
 *
 * The important thing about this component is what it does NOT do: it never
 * parses a coordinate itself. Each format lays out its own boxes, then joins
 * them into the one canonical string `parseCoord` already accepts — "29 18.03
 * N" for degrees and decimal minutes, "29 18 01.8 N" with seconds, a signed
 * decimal on its own for DD. So every rejection the strict parser makes still
 * fires: minutes at 60, a hemisphere from the wrong axis, a fractional degree
 * followed by minutes. Splitting the fields is a keyboard convenience, not a
 * second parser, and there is deliberately no second place for the rules to
 * drift to.
 *
 * DD is the one format with no hemisphere buttons. It takes a signed number,
 * the way the converter always has — offering both a minus sign and a W button
 * invites "-94.8 W", which means two contradictory things and which the parser
 * rightly refuses.
 *
 * Validity is shown per axis as you type. Everywhere else in this app a bad
 * coordinate was only discovered on save, as a toast, after the crew had
 * already moved on.
 */

interface Boxes {
  /** Degrees for every format; the whole signed value in DD. */
  a: string
  /** Minutes, where the format has them. */
  b: string
  /** Seconds, in DMS only. */
  c: string
  hemi: string
}

const EMPTY: Boxes = { a: '', b: '', c: '', hemi: '' }

const HEMIS: Record<Axis, { id: string; label: string }[]> = {
  lat: [
    { id: 'N', label: 'N' },
    { id: 'S', label: 'S' },
  ],
  lon: [
    { id: 'E', label: 'E' },
    { id: 'W', label: 'W' },
  ],
}

/** The boxes joined into something `parseCoord` understands. */
function compose(b: Boxes, format: CoordFormat): string {
  if (format === 'dd') return b.a.trim()
  if (b.a.trim() === '') return ''
  const parts = format === 'ddm' ? [b.a, b.b] : [b.a, b.b, b.c]
  return parts.map((p) => p.trim()).filter((p) => p !== '').join(' ') + ' ' + b.hemi
}

/** The boxes a value fills, in the format being shown. */
function explode(dd: number, axis: Axis, format: CoordFormat): Boxes {
  if (!Number.isFinite(dd)) {
    return { ...EMPTY, hemi: HEMIS[axis][0].id }
  }
  if (format === 'dd') {
    return { ...EMPTY, a: toDD(dd), hemi: HEMIS[axis][0].id }
  }
  if (format === 'ddm') {
    const p = ddmParts(dd, axis)
    if (!p) return { ...EMPTY, hemi: HEMIS[axis][0].id }
    return { a: String(p.deg), b: p.min.toFixed(3), c: '', hemi: p.hemi }
  }
  const p = dmsParts(dd, axis)
  if (!p) return { ...EMPTY, hemi: HEMIS[axis][0].id }
  return { a: String(p.deg), b: String(p.min), c: p.sec.toFixed(1), hemi: p.hemi }
}

export function CoordInput({
  value,
  onChange,
  label,
  onUseFix,
  fixLabel = 'Use my location',
}: {
  /** Decimal degrees. NaN on an axis means "not set". */
  value: { lat: number; lon: number }
  onChange: (v: { lat: number; lon: number }) => void
  /** What this position is, for screen readers: 'Destination', 'LKP', … */
  label: string
  /** Renders a one-tap fill from the current GPS fix when given. */
  onUseFix?: () => void
  fixLabel?: string
}) {
  const format = useCoordFormat((s) => s.format)
  const setFormat = useCoordFormat((s) => s.setFormat)

  const [boxes, setBoxes] = useState<{ lat: Boxes; lon: Boxes }>(() => ({
    lat: explode(value.lat, 'lat', format),
    lon: explode(value.lon, 'lon', format),
  }))
  /** Which axes have been typed in — an untouched empty box is not an error. */
  const [touched, setTouched] = useState({ lat: false, lon: false })

  /**
   * What we last told the parent. Re-seeding the boxes from `value` on every
   * render would fight the cursor; re-seeding only when the value arrived from
   * somewhere else — a map tap, a GPS fix, a waypoint — does not.
   */
  const emitted = useRef(value)
  const shownFormat = useRef(format)

  useEffect(() => {
    const foreign =
      !same(value.lat, emitted.current.lat) || !same(value.lon, emitted.current.lon)
    if (!foreign && shownFormat.current === format) return
    emitted.current = value
    shownFormat.current = format
    setBoxes({
      lat: explode(value.lat, 'lat', format),
      lon: explode(value.lon, 'lon', format),
    })
    if (foreign) setTouched({ lat: false, lon: false })
  }, [value, format])

  function edit(axis: Axis, patch: Partial<Boxes>) {
    const next = { ...boxes, [axis]: { ...boxes[axis], ...patch } }
    setBoxes(next)
    setTouched((t) => ({ ...t, [axis]: true }))
    const out = {
      lat: parseCoord(compose(next.lat, format), 'lat'),
      lon: parseCoord(compose(next.lon, format), 'lon'),
    }
    emitted.current = out
    onChange(out)
  }

  const invalid = (axis: Axis): boolean => {
    if (!touched[axis]) return false
    if (compose(boxes[axis], format).trim() === '') return false
    return !Number.isFinite(axis === 'lat' ? value.lat : value.lon)
  }

  const both = Number.isFinite(value.lat) && Number.isFinite(value.lon)

  return (
    <div className="space-y-2">
      <Segmented
        label={`${label} coordinate format`}
        value={format}
        onChange={setFormat}
        options={COORD_FORMATS}
      />

      <AxisRow
        axis="lat"
        boxes={boxes.lat}
        format={format}
        label={label}
        invalid={invalid('lat')}
        onEdit={(patch) => edit('lat', patch)}
      />
      <AxisRow
        axis="lon"
        boxes={boxes.lon}
        format={format}
        label={label}
        invalid={invalid('lon')}
        onEdit={(patch) => edit('lon', patch)}
      />

      {/* The same position in the formats you are not typing in. A crew
          reading a number off a radio in one format and entering it in
          another has one place to check they meant the same spot. */}
      {both ? (
        <div className="tnum space-y-0.5 rounded-xl border border-white/10 bg-navy-950/40 px-3 py-2 text-xs text-slate-300">
          {format !== 'ddm' ? (
            <div>
              <span className="text-slate-400">DDM </span>
              {toDDM(value.lat, 'lat')}, {toDDM(value.lon, 'lon')}
            </div>
          ) : null}
          {format !== 'dms' ? (
            <div>
              <span className="text-slate-400">DMS </span>
              {toDMS(value.lat, 'lat')}, {toDMS(value.lon, 'lon')}
            </div>
          ) : null}
          {format !== 'dd' ? (
            <div>
              <span className="text-slate-400">DD </span>
              {toDD(value.lat)}, {toDD(value.lon)}
            </div>
          ) : null}
        </div>
      ) : null}

      {onUseFix ? (
        <Button variant="ghost" className="w-full" onClick={onUseFix}>
          {fixLabel}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * One axis, laid out for the format in force.
 *
 * Module level, not nested inside `CoordInput`. A component declared inside
 * another is a new type on every render, so React unmounts and remounts it —
 * which for a text field means losing focus after every character typed.
 */
function AxisRow({
  axis,
  boxes: b,
  format,
  label,
  invalid,
  onEdit,
}: {
  axis: Axis
  boxes: Boxes
  format: CoordFormat
  label: string
  invalid: boolean
  onEdit: (patch: Partial<Boxes>) => void
}) {
  const name = axis === 'lat' ? 'Latitude' : 'Longitude'
  const ring = invalid ? 'border-red-400/60' : ''

  return (
    <div>
      <span className="mb-1 block text-xs text-slate-300">{name}</span>
      <div className="flex items-start gap-1.5">
        {format === 'dd' ? (
          <Input
            value={b.a}
            onChange={(e) => onEdit({ a: e.target.value })}
            placeholder={axis === 'lat' ? '29.300500' : '-94.820000'}
            inputMode="decimal"
            aria-label={`${label} ${name.toLowerCase()}, decimal degrees`}
            aria-invalid={invalid}
            className={'tnum ' + ring}
          />
        ) : (
          <>
            <Input
              value={b.a}
              onChange={(e) => onEdit({ a: e.target.value })}
              placeholder={axis === 'lat' ? '29' : '94'}
              inputMode="numeric"
              aria-label={`${label} ${name.toLowerCase()}, degrees`}
              aria-invalid={invalid}
              className={'tnum ' + ring}
            />
            <Input
              value={b.b}
              onChange={(e) => onEdit({ b: e.target.value })}
              placeholder={format === 'ddm' ? '18.030' : '18'}
              inputMode="decimal"
              aria-label={`${label} ${name.toLowerCase()}, minutes`}
              aria-invalid={invalid}
              className={'tnum ' + ring}
            />
            {format === 'dms' ? (
              <Input
                value={b.c}
                onChange={(e) => onEdit({ c: e.target.value })}
                placeholder="01.8"
                inputMode="decimal"
                aria-label={`${label} ${name.toLowerCase()}, seconds`}
                aria-invalid={invalid}
                className={'tnum ' + ring}
              />
            ) : null}
            <Segmented
              label={`${label} ${name.toLowerCase()} hemisphere`}
              value={b.hemi}
              onChange={(hemi) => onEdit({ hemi })}
              options={HEMIS[axis]}
              className="w-20 shrink-0"
            />
          </>
        )}
      </div>
      {invalid ? (
        <p className="mt-1 text-xs text-red-300">
          That is not a {name.toLowerCase()} this app will guess at — check the{' '}
          {format === 'dd' ? 'number' : 'degrees and minutes'}.
        </p>
      ) : null}
    </div>
  )
}

/** NaN is a value here — "not set" — so it has to compare equal to itself. */
function same(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true
  return a === b
}
