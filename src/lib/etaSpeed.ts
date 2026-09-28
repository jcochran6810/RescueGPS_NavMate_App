/**
 * Which speed the ETA is worked at — the crew's choice (2026-09-28: "show
 * eta at current speed, top speed (for that selected vessel), or a custom
 * speed. If the user is at a standstill the eta shows in days and is not
 * accurate").
 *
 * - `current` — the speed the boat is actually making good along the route;
 *   only while it IS making way. Stopped at the dock, drifting, or going the
 *   wrong way, an ETA from that speed is days away and means nothing, so the
 *   time is worked at cruise instead and the label says so plainly: "Not
 *   moving — ETA at cruise 25 kn".
 * - `cruise` — the selected boat's cruise speed.
 * - `top` — the selected boat's top speed (`max_speed_kn`).
 * - `custom` — a speed the crew typed, in their own speed unit, held here in
 *   knots.
 *
 * Pure: the store holds the choice, the card and the route preview call this.
 */

import { knotsIn, SPEED_SUFFIX, type SpeedUnit } from './units'

export type EtaSpeedMode = 'current' | 'cruise' | 'top' | 'custom'

export const ETA_SPEED_MODES: readonly EtaSpeedMode[] = ['current', 'cruise', 'top', 'custom']

/** Button labels. */
export const ETA_SPEED_LABEL: Record<EtaSpeedMode, string> = {
  current: 'Current',
  cruise: 'Cruise',
  top: 'Top',
  custom: 'Custom',
}

/**
 * Below this speed made good along the route, knots, the boat is "not moving"
 * for the ETA. Two knots, not one: a boat tied up or idling shows a knot or
 * more of GPS wander, and 12 NM at 1.2 kn is a ten-hour "ETA".
 */
export const MOVING_KN = 2

/** The most a custom speed may be, knots — anything above is a typo. */
export const MAX_CUSTOM_KN = 80

export interface EtaSpeedInput {
  mode: EtaSpeedMode
  /**
   * Speed made good along the route, knots (`routeSpeedKn`): the rate the
   * distance to go is actually coming down. Null when not known yet.
   */
  madeGoodKn?: number | null
  /** Smoothed speed over the ground, knots — used only until `madeGoodKn` is known. */
  sogKn?: number | null
  cruiseKn?: number | null
  topKn?: number | null
  /** The crew's custom speed, knots. */
  customKn?: number | null
  /** The crew's speed unit, for the label. Default knots. */
  unit?: SpeedUnit
}

export interface EtaSpeed {
  /** Knots to work the time at, or null when there is none to use. */
  speedKn: number | null
  /** What `speedKn` actually is — `cruise` for a `current` choice while not moving. */
  source: EtaSpeedMode
  /** `current` was chosen and the boat is not making way: this is the fallback. */
  notMoving: boolean
  /** "at 22 kn (top)", "at 14.2 kn (current)" — null without a speed. */
  label: string | null
  /**
   * The whole note, when there is more to say than the label: "Not moving —
   * ETA at cruise 25 kn", "No top speed set for this boat — ETA at cruise
   * 20 kn". Null when the label says it all.
   */
  note: string | null
}

function usable(kn: number | null | undefined): number | null {
  return kn != null && Number.isFinite(kn) && kn > 0 ? kn : null
}

/** "22 kn", "25.3 mph" — whole numbers without a decimal. */
export function speedText(kn: number, unit: SpeedUnit = 'kn'): string {
  const v = knotsIn(kn, unit)
  const r = Math.round(v * 10) / 10
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} ${SPEED_SUFFIX[unit]}`
}

/** The speed to work the ETA at, and how to say which it is. */
export function resolveEtaSpeed(input: EtaSpeedInput): EtaSpeed {
  const unit = input.unit ?? 'kn'
  const cruise = usable(input.cruiseKn)
  const top = usable(input.topKn)
  const custom = usable(input.customKn)
  const made = input.madeGoodKn
  const sog = usable(input.sogKn)

  const at = (kn: number, source: EtaSpeedMode) => `at ${speedText(kn, unit)} (${source === 'current' ? 'current' : ETA_SPEED_LABEL[source].toLowerCase()})`
  const result = (kn: number | null, source: EtaSpeedMode, notMoving: boolean, note: string | null): EtaSpeed => ({
    speedKn: kn,
    source,
    notMoving,
    label: kn != null ? at(kn, source) : null,
    note,
  })
  // A stand-in when the chosen speed is missing: cruise, else top.
  const fallback = (why: string): EtaSpeed => {
    if (cruise != null) return result(cruise, 'cruise', false, `${why} — ETA at cruise ${speedText(cruise, unit)}`)
    if (top != null) return result(top, 'top', false, `${why} — ETA at top speed ${speedText(top, unit)}`)
    return result(null, input.mode, false, `${why} — no ETA`)
  }

  switch (input.mode) {
    case 'current': {
      // Made good along the route when known; the speed over the ground only
      // until then. Either way, under MOVING_KN is not moving.
      const kn = made != null && Number.isFinite(made) ? made : sog
      if (kn != null && kn >= MOVING_KN) return result(kn, 'current', false, null)
      const why = 'Not moving'
      if (cruise != null) return { ...result(cruise, 'cruise', true, `${why} — ETA at cruise ${speedText(cruise, unit)}`) }
      if (top != null) return { ...result(top, 'top', true, `${why} — ETA at top speed ${speedText(top, unit)}`) }
      return result(null, 'current', true, `${why} — no ETA`)
    }
    case 'cruise':
      return cruise != null ? result(cruise, 'cruise', false, null) : fallback('No cruise speed set for this boat')
    case 'top':
      return top != null ? result(top, 'top', false, null) : fallback('No top speed set for this boat')
    case 'custom':
      return custom != null ? result(custom, 'custom', false, null) : fallback('No custom speed set')
  }
}

/**
 * A custom speed typed in the crew's unit, as knots — or the reason it
 * cannot be used. Accepts "18", "18.5", "18,5"; refuses zero, negatives,
 * words and anything over `MAX_CUSTOM_KN`.
 */
export function parseCustomSpeed(
  text: string,
  unit: SpeedUnit = 'kn',
): { kn: number; error: null } | { kn: null; error: string } {
  const t = text.trim().replace(',', '.')
  if (t === '') return { kn: null, error: 'Enter a speed.' }
  if (!/^\d+(\.\d+)?$/.test(t)) return { kn: null, error: 'Enter a speed as a number, e.g. 18.' }
  const v = Number(t)
  const perKn = knotsIn(1, unit)
  const kn = v / perKn
  if (!(kn > 0)) return { kn: null, error: 'The speed must be more than 0.' }
  if (kn < 1) return { kn: null, error: `That is under 1 kn — the ETA would be meaningless.` }
  if (kn > MAX_CUSTOM_KN) {
    return { kn: null, error: `That is over ${speedText(MAX_CUSTOM_KN, unit)} — check the number.` }
  }
  return { kn, error: null }
}
