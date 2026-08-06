/**
 * Cold-water survival clock — the field cut of RescueGPS's USCG/NOAA-aligned
 * survivability model (v3.0, three clocks: airway, functional capability,
 * hypothermia).
 *
 * Simplified on purpose to the three things a coxswain actually knows:
 * water temperature, how long the person has been in, and whether they had a
 * life jacket. The full model's other multipliers (age, body, clothing, sea
 * state, activity) need answers a field crew rarely has; leaving them out
 * keeps the clock honest instead of precise-looking.
 *
 * The governing rule carries over verbatim: drowning kills faster than
 * hypothermia, so airway risk — cold shock, then swim failure — always
 * outranks the temperature clock. That is why the phase line is shown above
 * the time estimate.
 */

export type PfdStatus = 'yes' | 'no' | 'unknown'

/**
 * USCG baseline exhaustion/survival windows by water temperature, minutes.
 * Rows are upper bounds in °F, matched first-fit — RescueGPS's
 * SURVIVAL_TABLE, carried unchanged.
 */
const BASELINE: {
  maxTempF: number
  exhaustionMin: number
  exhaustionMax: number
  survivalMin: number
  survivalMax: number
}[] = [
  { maxTempF: 32.5, exhaustionMin: 0, exhaustionMax: 15, survivalMin: 15, survivalMax: 45 },
  { maxTempF: 40, exhaustionMin: 15, exhaustionMax: 30, survivalMin: 30, survivalMax: 90 },
  { maxTempF: 50, exhaustionMin: 30, exhaustionMax: 60, survivalMin: 60, survivalMax: 180 },
  { maxTempF: 60, exhaustionMin: 60, exhaustionMax: 120, survivalMin: 60, survivalMax: 360 },
  { maxTempF: 70, exhaustionMin: 120, exhaustionMax: 420, survivalMin: 120, survivalMax: 2400 },
  { maxTempF: 80, exhaustionMin: 120, exhaustionMax: 720, survivalMin: 180, survivalMax: 4320 },
]

/**
 * PFD multipliers from the same model: a confirmed life jacket buys survival
 * time (type II figure); confirmed none halves it and cuts functional time
 * to 0.55; unknown stays neutral rather than guessing either way.
 */
const PFD_MULT: Record<PfdStatus, { functional: number; survival: number }> = {
  yes: { functional: 1.0, survival: 1.2 },
  no: { functional: 0.55, survival: 0.5 },
  unknown: { functional: 1.0, survival: 1.0 },
}

export type ImmersionPhase =
  | 'cold_shock'
  | 'swim_failure'
  | 'hypothermia'
  | 'beyond_estimate'

export interface SurvivalEstimate {
  waterTempF: number
  /** Cold shock applies below 77 °F (25 °C). */
  coldWater: boolean
  phase: ImmersionPhase
  phaseLabel: string
  /** What kills first right now. */
  primaryThreat: 'drowning' | 'hypothermia' | 'exposure'
  /** Time until the person can no longer help themselves, minutes. */
  functionalMin: number
  functionalMax: number
  survivalMin: number
  survivalMax: number
  /** Midpoint survival estimate, minutes — the countdown number. */
  estimateMinutes: number
  /** Minutes left of the midpoint estimate. ≤ 0 means past it — which is a
   *  reason to keep searching with urgency, not to stop. */
  remainingMinutes: number
}

const PHASE_LABELS: Record<ImmersionPhase, string> = {
  cold_shock: 'Cold shock (0–3 min) — gasping and panic; drowning risk peaks',
  swim_failure: 'Swim failure (3–30 min) — limbs fail long before core cools',
  hypothermia: 'Hypothermia phase (30 min +) — core temperature now falling',
  beyond_estimate: 'Beyond the estimate — people have survived far longer',
}

/**
 * The survival clock. `elapsedMinutes` is time since the person went in —
 * normally now minus the LKP time.
 */
export function survivalEstimate(input: {
  waterTempC: number
  elapsedMinutes: number
  pfd: PfdStatus
}): SurvivalEstimate {
  const waterTempF = (input.waterTempC * 9) / 5 + 32
  const coldWater = waterTempF < 77

  const row =
    BASELINE.find((r) => waterTempF <= r.maxTempF) ?? {
      maxTempF: Number.POSITIVE_INFINITY,
      exhaustionMin: Number.POSITIVE_INFINITY,
      exhaustionMax: Number.POSITIVE_INFINITY,
      survivalMin: Number.POSITIVE_INFINITY,
      survivalMax: Number.POSITIVE_INFINITY,
    }

  const mult = PFD_MULT[input.pfd]
  const functionalMin = Math.round(row.exhaustionMin * mult.functional)
  const functionalMax = Math.round(row.exhaustionMax * mult.functional)
  const survivalMin = Math.round(row.survivalMin * mult.survival)
  const survivalMax = Math.round(row.survivalMax * mult.survival)
  const estimateMinutes = Math.round((survivalMin + survivalMax) / 2)

  const elapsed = Math.max(0, input.elapsedMinutes)
  let phase: ImmersionPhase
  if (elapsed > estimateMinutes && Number.isFinite(estimateMinutes)) {
    phase = 'beyond_estimate'
  } else if (coldWater && elapsed <= 3) {
    phase = 'cold_shock'
  } else if (coldWater && elapsed <= 30) {
    phase = 'swim_failure'
  } else {
    phase = 'hypothermia'
  }

  // Drowning beats hypothermia: in the early phases — and any time there is
  // confirmed no PFD in cold water — the airway is the primary threat.
  const primaryThreat: SurvivalEstimate['primaryThreat'] =
    phase === 'cold_shock' ||
    phase === 'swim_failure' ||
    (coldWater && input.pfd === 'no')
      ? 'drowning'
      : waterTempF >= 80
        ? 'exposure'
        : 'hypothermia'

  return {
    waterTempF,
    coldWater,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    primaryThreat,
    functionalMin,
    functionalMax,
    survivalMin,
    survivalMax,
    estimateMinutes,
    remainingMinutes: Number.isFinite(estimateMinutes)
      ? estimateMinutes - elapsed
      : Number.POSITIVE_INFINITY,
  }
}

/** Minutes as "about 2 h", "45 min", "no practical limit". */
export function formatSurvivalMinutes(min: number): string {
  if (!Number.isFinite(min)) return 'no practical limit'
  if (min < 60) return `${Math.max(0, Math.round(min))} min`
  const h = min / 60
  if (h < 10) return `${h.toFixed(h < 3 ? 1 : 0)} h`
  return `${Math.round(h)} h`
}
