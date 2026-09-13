/**
 * The boat — and the one number the chart plotter actually steers by.
 *
 * Charted depths on an ENC are in **metres below chart datum** (mean lower low
 * water in US waters), so everything stored here is metric and the feet a US
 * crew thinks in are a display conversion, not a second source of truth. A
 * draft kept in two units is a draft that will disagree with itself.
 *
 * The governing rule for routing is deliberately dull:
 *
 *     safeDepth = draft + underKeelMargin
 *
 * and water is usable when its charted minimum depth is at least that, at
 * chart datum. No tide is added — see `routing.ts` for why that is a refusal
 * rather than an omission.
 */

export const M_TO_FEET = 3.280839895
export const FEET_TO_M = 0.3048

export interface Vessel {
  id: string
  /** Offline-sync idempotency key. Equals id here. */
  client_id: string
  user_id: string
  /** null = private to this account; otherwise shared with that team. */
  team_id: string | null
  name: string
  callsign: string
  /** Deepest point of the hull below the waterline, metres. */
  draft_m: number
  /** Highest fixed point above the waterline, metres. 0 = not recorded. */
  air_draft_m: number
  beam_m: number
  length_m: number
  cruise_speed_kn: number
  max_speed_kn: number
  /** Gallons per hour at cruise. 0 = not recorded. */
  fuel_burn_gph: number
  /** Water the coxswain wants under the keel on top of the draft, metres. */
  under_keel_margin_m: number
  /** Lateral stand-off kept from any charted hazard, metres. */
  clearance_m: number
  created_at: string
  updated_at: string
}

export type NewVessel = Pick<
  Vessel,
  | 'name'
  | 'callsign'
  | 'draft_m'
  | 'air_draft_m'
  | 'beam_m'
  | 'length_m'
  | 'cruise_speed_kn'
  | 'max_speed_kn'
  | 'fuel_burn_gph'
  | 'under_keel_margin_m'
  | 'clearance_m'
> & { team_id?: string | null }

/**
 * Defaults sized for a typical inshore rescue boat rather than left at zero.
 * A zero draft would route a boat across a mudflat on its first use, which is
 * the one failure this file exists to prevent.
 */
export const VESSEL_DEFAULTS: NewVessel = {
  name: '',
  callsign: '',
  draft_m: 0.9,
  air_draft_m: 3.0,
  beam_m: 2.6,
  length_m: 7.6,
  cruise_speed_kn: 20,
  max_speed_kn: 35,
  fuel_burn_gph: 0,
  under_keel_margin_m: 0.6,
  clearance_m: 30,
}

/** Sensible bounds. Outside these the number is a typo, not a boat. */
export const VESSEL_LIMITS = {
  draft_m: { min: 0.05, max: 15 },
  air_draft_m: { min: 0, max: 60 },
  beam_m: { min: 0.5, max: 40 },
  length_m: { min: 1, max: 200 },
  cruise_speed_kn: { min: 0.5, max: 80 },
  max_speed_kn: { min: 0.5, max: 120 },
  fuel_burn_gph: { min: 0, max: 500 },
  under_keel_margin_m: { min: 0, max: 10 },
  clearance_m: { min: 0, max: 500 },
} as const

/**
 * The depth of water the boat needs, at chart datum, in metres.
 *
 * Draft plus the margin the coxswain asked for. Nothing else goes in here —
 * squat, swell and a following sea all eat into the same margin, which is
 * exactly why the margin is theirs to set rather than a constant in the code.
 */
export function safeDepthM(v: Pick<Vessel, 'draft_m' | 'under_keel_margin_m'>): number {
  const draft = Number.isFinite(v.draft_m) ? Math.max(0, v.draft_m) : 0
  const margin = Number.isFinite(v.under_keel_margin_m)
    ? Math.max(0, v.under_keel_margin_m)
    : 0
  return draft + margin
}

/**
 * Can the boat use water whose charted minimum depth is `chartedM`?
 *
 * `null` means no depth is charted there. That answers `false`: unsurveyed
 * water is not shallow, but it is not known to be deep either, and this app
 * does not guess at coordinates (`coords.ts`) or at depths.
 */
export function clearsDepth(chartedM: number | null, safeM: number): boolean {
  if (chartedM === null || !Number.isFinite(chartedM)) return false
  return chartedM >= safeM
}

/**
 * Does the boat fit under a bridge or cable of vertical clearance `verclrM`?
 *
 * ENC vertical clearances are above **mean high water**, so the charted figure
 * is the worst case and no tide correction makes it smaller. A missing
 * clearance is unknown, not unlimited.
 */
export function clearsHeight(
  verclrM: number | null,
  v: Pick<Vessel, 'air_draft_m'>,
): boolean {
  if (verclrM === null || !Number.isFinite(verclrM)) return false
  if (!Number.isFinite(v.air_draft_m) || v.air_draft_m <= 0) return true
  return verclrM > v.air_draft_m
}

export function metersToFeet(m: number): number {
  return m * M_TO_FEET
}

export function feetToMeters(ft: number): number {
  return ft * FEET_TO_M
}

/** "2.9 ft (0.9 m)" — feet first, because that is what the crew says aloud. */
export function formatDepth(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return '—'
  return `${metersToFeet(m).toFixed(1)} ft (${m.toFixed(1)} m)`
}

/** Short form for a dense list: "2.9 ft". */
export function formatFeet(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return '—'
  return `${metersToFeet(m).toFixed(1)} ft`
}

/** Fuel burned over `hours` at cruise, US gallons. null when not recorded. */
export function fuelForHours(
  v: Pick<Vessel, 'fuel_burn_gph'>,
  hours: number,
): number | null {
  if (!Number.isFinite(v.fuel_burn_gph) || v.fuel_burn_gph <= 0) return null
  if (!Number.isFinite(hours) || hours < 0) return null
  return v.fuel_burn_gph * hours
}

/** Clamp a typed number into its limit, or null when it is not a number. */
export function readVesselField(
  raw: string,
  field: keyof typeof VESSEL_LIMITS,
): number | null {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return null
  const { min, max } = VESSEL_LIMITS[field]
  if (n < min || n > max) return null
  return n
}

export function describeVessel(v: Vessel): string {
  const bits = [formatFeet(v.draft_m) + ' draft']
  if (v.cruise_speed_kn > 0) bits.push(`${v.cruise_speed_kn} kn cruise`)
  return bits.join(' · ')
}
