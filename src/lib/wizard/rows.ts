/**
 * The new-incident wizard's answers → the database rows they become.
 *
 * This is NavMate's copy of RescueGPS's
 * `frontend/src/features/incident/wizardContract/wizardRows.js` (answers →
 * rows half). Both apps ask the same questions (wizardSchema.json) and must
 * save them identically, so an incident started on a boat opens in command
 * with every answer where command's own wizard puts it, and command can
 * reopen its wizard on it to fill in what is missing.
 *
 * It is held to the RescueGPS original by `wizardContract.fixtures.json`
 * (written by RescueGPS from its real code, copied here by its
 * `frontend/scripts/sync-wizard-contract.sh`): rows.test.ts runs every
 * fixture's answers through this file and expects the same rows. Change the
 * RescueGPS side first, sync, then make this file pass again.
 *
 * The answers are RescueGPS's wizard form fields (camelCase), not NavMate's
 * own types, so the two apps share one answer format end to end.
 */
import schema from './wizardSchema.json'

export type Answers = Record<string, unknown> & { victims?: Answers[] }
type Row = Record<string, unknown>

export const WIZARD_SCHEMA = schema

/** The production `victims` table's CHECK lists (RescueGPS utils/victimDbValues.js). */
const VICTIM_CHECKS: Record<string, string[]> = {
  gender: ['male', 'female', 'unknown'],
  clothing_type: ['none', 'light', 'heavy', 'immersion_suit'],
  swimming_ability: ['expert', 'strong', 'average', 'weak', 'non_swimmer', 'unknown'],
  consciousness: ['conscious', 'unconscious', 'unknown'],
  fatigue_level: ['exhausted', 'fatigued', 'normal', 'alert', 'unknown'],
  fitness_status: ['athletic', 'average', 'below_average', 'poor', 'unknown'],
  hypothermia_risk: ['high', 'medium', 'low', 'unknown'],
  intoxication_level: ['intoxicated', 'impaired', 'sober', 'unknown'],
  body_type: ['thin', 'average', 'heavy'],
  status: ['missing', 'located', 'rescued', 'recovered', 'self_rescued'],
}

const SYNONYMS: Record<string, Record<string, string>> = {
  swimming_ability: { excellent: 'expert', good: 'strong', poor: 'weak', none: 'non_swimmer', non: 'non_swimmer' },
  clothing_type: { swimsuit: 'none', minimal: 'none', survival_suit: 'immersion_suit', drysuit: 'immersion_suit' },
  hypothermia_risk: { moderate: 'medium' },
  fatigue_level: { tired: 'fatigued' },
}

/** The column value for an answer, or null when the table can't hold it. */
export function dbValue(column: string, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null
  const v = String(value).trim().toLowerCase()
  const allowed = VICTIM_CHECKS[column]
  if (!allowed) return value
  if (allowed.includes(v)) return v
  const mapped = SYNONYMS[column]?.[v]
  return mapped && allowed.includes(mapped) ? mapped : null
}

const MEDICAL_CODES = new Set(schema.options.MEDICAL_CONDITIONS.map((c) => c.value))

/** Only real medical-condition codes (free text like "none" is not a code). */
export function ontologyMedicalCodes(list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => MEDICAL_CODES.has(s))
}

/** RescueGPS utils/timestamps.validIsoOrNull. */
export function validIsoOrNull(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/\d{4}-\d{2}-\d{2}/.test(text)) return null
    return Number.isNaN(new Date(text).getTime()) ? null : text
  }
  if (typeof value !== 'number' && !(value instanceof Date)) return null
  const t = new Date(value)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}

/** The wizard's types are canonical codes; anything else is `other`. */
const CANONICAL = new Set([
  'missing_person_piw', 'missing_vessel', 'vessel_in_distress', 'found_watercraft', 'debris_found',
  'medical_emergency', 'missing_person_land', 'mass_rescue', 'other',
])
const normalizeIncidentType = (v: unknown): string => {
  const k = String(v ?? '').trim().toLowerCase()
  return CANONICAL.has(k) ? k : 'other'
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const truthy = (v: unknown): boolean => !!v

/** Approximate-area boundaries in decimal degrees (DD / DDM / DMS), or null. */
export function areaBoundsFromFormData(fd: Answers) {
  const format = s(fd.coordinateFormat) || 'DD'
  const num = (x: unknown) => {
    const n = parseFloat(s(x))
    return Number.isFinite(n) ? Math.abs(n) : null
  }
  const v = (prefix: string) => {
    let deg: number | null
    if (format === 'DDM') {
      const d = num(fd[`${prefix}Deg`])
      const m = num(fd[`${prefix}Min`])
      deg = d == null ? null : d + (m ?? 0) / 60
    } else if (format === 'DMS') {
      const d = num(fd[`${prefix}Deg`])
      const m = num(fd[`${prefix}Min`])
      const sec = num(fd[`${prefix}Sec`])
      deg = d == null ? null : d + (m ?? 0) / 60 + (sec ?? 0) / 3600
    } else {
      deg = num(fd[prefix])
    }
    if (deg == null) return null
    const dir = fd[`${prefix}Dir`]
    return dir === 'S' || dir === 'W' ? -deg : deg
  }
  const north = v('areaNorthLat')
  const south = v('areaSouthLat')
  const east = v('areaEastLng')
  const west = v('areaWestLng')
  return north != null && south != null && east != null && west != null ? { north, south, east, west } : null
}

/** The LKP from the format-specific fields, else the direct lkpLat/lkpLng. */
export function getCoordinatesFromFormData(fd: Answers): { lat: number | null; lng: number | null } {
  const format = s(fd.coordinateFormat) || 'DD'
  const pf = (x: unknown) => parseFloat(s(x))
  let lat: number | null = null
  let lng: number | null = null
  if (format === 'DD') {
    if (truthy(fd.lkpLatDeg)) {
      lat = pf(fd.lkpLatDeg)
      if (fd.lkpLatDir === 'S') lat = -lat
    }
    if (truthy(fd.lkpLngDeg)) {
      lng = pf(fd.lkpLngDeg)
      if (fd.lkpLngDir === 'W') lng = -lng
    }
  } else if (format === 'DDM') {
    if (truthy(fd.lkpLatDegDDM) && truthy(fd.lkpLatMin)) {
      lat = pf(fd.lkpLatDegDDM) + pf(fd.lkpLatMin) / 60
      if (fd.lkpLatDir === 'S') lat = -lat
    }
    if (truthy(fd.lkpLngDegDDM) && truthy(fd.lkpLngMin)) {
      lng = pf(fd.lkpLngDegDDM) + pf(fd.lkpLngMin) / 60
      if (fd.lkpLngDir === 'W') lng = -lng
    }
  } else if (format === 'DMS') {
    if (truthy(fd.lkpLatDegDMS) && truthy(fd.lkpLatMinDMS) && truthy(fd.lkpLatSec)) {
      lat = pf(fd.lkpLatDegDMS) + pf(fd.lkpLatMinDMS) / 60 + pf(fd.lkpLatSec) / 3600
      if (fd.lkpLatDir === 'S') lat = -lat
    }
    if (truthy(fd.lkpLngDegDMS) && truthy(fd.lkpLngMinDMS) && truthy(fd.lkpLngSec)) {
      lng = pf(fd.lkpLngDegDMS) + pf(fd.lkpLngMinDMS) / 60 + pf(fd.lkpLngSec) / 3600
      if (fd.lkpLngDir === 'W') lng = -lng
    }
  }
  if (!lat && truthy(fd.lkpLat)) lat = pf(fd.lkpLat)
  if (!lng && truthy(fd.lkpLng)) lng = pf(fd.lkpLng)
  return { lat, lng }
}

/** The wizard's date + hour + minute fields (device clock) as an ISO time, or null. */
export function assembleWizardDateTime(date: unknown, hour: unknown, minute: unknown): string | null {
  if (!date || hour === '' || minute === '' || hour == null || minute == null) return null
  const h = String(hour).padStart(2, '0')
  const m = String(minute).padStart(2, '0')
  const d = new Date(`${s(date)}T${h}:${m}:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const typeLabel = (id: unknown) => schema.incidentTypes.find((t) => t.id === id)?.label || null

/** The incident object RescueGPS's wizard saves (IncidentWizard.handleSubmit). */
export function wizardIncidentFromAnswers(
  fd: Answers,
  { incidentNumber = null, clientId = null }: { incidentNumber?: string | null; clientId?: string | null } = {},
): Answers {
  const nameFromNumber = fd.incidentName ? null : typeLabel(fd.incidentType) || 'Incident'
  const incidentName = fd.incidentName || `${nameFromNumber} ${incidentNumber}`
  let { lat, lng } = getCoordinatesFromFormData(fd)
  const bounds = areaBoundsFromFormData(fd)
  if ((lat == null || lng == null) && bounds) {
    lat = (bounds.north + bounds.south) / 2
    lng = (bounds.east + bounds.west) / 2
  }
  const incidentTime = assembleWizardDateTime(fd.incidentDate, fd.incidentTimeHour, fd.incidentTimeMinute) || validIsoOrNull(fd.incidentTime)
  const lastSeenTime = assembleWizardDateTime(fd.lastSeenDate, fd.lastSeenTimeHour, fd.lastSeenTimeMinute) || validIsoOrNull(fd.lastSeenTime)
  const reportedTime = assembleWizardDateTime(fd.reportedDate, fd.reportedTimeHour, fd.reportedTimeMinute) || validIsoOrNull(fd.reportedTime)
  const or = (v: unknown, d: unknown) => v || d
  return {
    incidentNumber,
    clientId,
    nameFromNumber,
    name: incidentName,
    incidentType: fd.incidentType,
    status: 'active',
    lkpLat: lat,
    lkpLng: lng,
    positionKnown: fd.positionKnown,
    positionSource: fd.positionSource,
    confidenceLevel: fd.confidenceLevel,
    areaDescription: fd.areaDescription,
    victims: fd.victims || [],
    incidentTime,
    lastSeenTime,
    reportedTime,
    incidentTimeEstimated: or(fd.incidentTimeEstimate, false),
    lastSeenTimeEstimated: or(fd.lastSeenTimeEstimate, false),
    watercraftType: fd.watercraftType,
    watercraftName: fd.watercraftName,
    watercraftColor: fd.watercraftColor,
    watercraftLength: fd.watercraftLength,
    watercraftRegistration: fd.registrationNumber,
    vesselName: fd.watercraftName,
    vesselType: fd.watercraftType,
    vesselColor: fd.watercraftColor,
    vesselLength: fd.watercraftLength,
    vesselRegistration: fd.registrationNumber,
    activityAtIncident: fd.activityAtIncident || fd.activity,
    possiblyInjured: fd.possiblyInjured,
    fallFromHeight: or(fd.fallFromHeight, false),
    fallHeight: or(fd.fallHeight, null),
    fallHeightEstimated: or(fd.fallHeightEstimated, false),
    fallSource: or(fd.fallSource, null),
    impactPosition: or(fd.impactPosition, null),
    waterType: or(fd.waterType, 'salt'),
    depthCalculation: or(fd.depthCalculation, null),
    activityDescription: or(fd.activityDescription, ''),
    eyewitnessName: or(fd.eyewitnessName, ''),
    eyewitnessContact: or(fd.eyewitnessContact, ''),
    areaBounds: bounds,
    watercraftDescription: or(fd.watercraftDescription, ''),
    departureLocation: or(fd.departureLocation, ''),
    departureLat: fd.departureLat === '' ? undefined : fd.departureLat,
    departureLng: fd.departureLng === '' ? undefined : fd.departureLng,
    departureTime: or(fd.departureTime, ''),
    bearing: or(fd.bearing, ''),
    speed: or(fd.speed, ''),
    expectedArrivalTime: or(fd.expectedArrivalTime, ''),
    destinationKnown: fd.destinationKnown,
    destinationLat: fd.destinationLat === '' ? undefined : fd.destinationLat,
    destinationLng: fd.destinationLng === '' ? undefined : fd.destinationLng,
    destinationDescription: or(fd.destinationDescription, ''),
    destinationAreaDescription: or(fd.destinationAreaDescription, ''),
    foundVesselType: or(fd.foundWatercraftType, ''),
    foundCondition: or(fd.foundCondition, ''),
    debrisType: or(fd.debrisType, ''),
    datumTypes: fd.debrisType ? [fd.debrisType] : [],
    debrisDescription: or(fd.debrisDescription, ''),
    debrisQuantity: or(fd.debrisQuantity, ''),
    debrisSpread: or(fd.debrisSpread, ''),
    reportingSource: or(fd.reportingSource, ''),
    reporterContact: or(fd.reporterContact, ''),
    searchPriority: or(fd.searchPriority, ''),
    searchPattern: or(fd.searchPattern, ''),
    searchNotes: or(fd.searchNotes, ''),
    description: or(fd.description, ''),
    piwPossibility: fd.piwPossibility,
    piwDetails: fd.piwDetails,
  }
}

/** Answers with no column of their own, kept in incidents.details (RescueGPS INCIDENT_DETAIL_KEYS). */
export const INCIDENT_DETAIL_KEYS = [
  'positionKnown', 'positionSource', 'confidenceLevel', 'eyewitnessName', 'eyewitnessContact',
  'areaDescription', 'areaBounds',
  'reportedTime', 'lastSeenTime', 'lastSeenTimeEstimated', 'incidentTimeEstimated',
  'activityAtIncident', 'activityDescription', 'possiblyInjured',
  'fallFromHeight', 'fallHeight', 'fallHeightEstimated', 'fallSource', 'impactPosition', 'waterType', 'depthCalculation',
  'piwPossibility', 'piwDetails',
  'watercraftType', 'watercraftName', 'watercraftDescription', 'watercraftColor', 'watercraftLength', 'watercraftRegistration',
  'departureLocation', 'departureLat', 'departureLng', 'departureTime', 'bearing', 'speed', 'expectedArrivalTime',
  'destinationKnown', 'destinationLat', 'destinationLng', 'destinationDescription', 'destinationAreaDescription',
  'foundVesselType', 'foundCondition', 'datumTypes', 'debrisType', 'debrisDescription', 'debrisQuantity', 'debrisSpread',
  'reportingSource', 'reporterContact', 'searchPriority', 'searchPattern', 'searchNotes', 'description',
  'channelSpeed',
  'submerged',
] as const

export function incidentDetails(incident: Answers): Row {
  const out: Row = {}
  for (const key of INCIDENT_DETAIL_KEYS) {
    const v = incident[key]
    if (v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) continue
    out[key] = v
  }
  return out
}

const bool = (v: unknown) => (v === true ? true : v === false ? false : null)
const finiteOrNull = (v: unknown) => (Number.isFinite(parseFloat(s(v))) ? parseFloat(s(v)) : null)

/** RescueGPS toDbIncident: the incidents row (without created_by / join / organisation). */
export function toDbIncident(incident: Answers): Row {
  return {
    incident_number: incident.incidentNumber || null,
    incident_type: normalizeIncidentType(incident.incidentType),
    incident_sub_type: incident.incidentSubType || incident.foundVesselType || null,
    incident_name: incident.incidentName || incident.name || null,
    urgency_level: incident.urgencyLevel || 'medium',
    status: incident.status || 'active',
    lkp_lat: finiteOrNull(incident.lkpLat),
    lkp_lng: finiteOrNull(incident.lkpLng),
    lkp_time: validIsoOrNull(incident.lkpTime) || validIsoOrNull(incident.incidentTime),
    incident_time: validIsoOrNull(incident.incidentTime),
    incident_time_estimated: bool(incident.incidentTimeEstimated),
    time_last_alive: validIsoOrNull(incident.lastSeenTime),
    time_last_alive_estimated: bool(incident.lastSeenTimeEstimated),
    activity_at_incident: incident.activityAtIncident || incident.activity || null,
    possibly_injured: bool(incident.possiblyInjured),
    lkp_is_exact: bool(incident.positionKnown),
    lkp_confidence: incident.confidenceLevel || null,
    witness_name: incident.eyewitnessName || null,
    witness_phone: incident.eyewitnessContact || null,
    lkp_source: incident.lkpSource || incident.positionSource || null,
    details: incidentDetails(incident),
    reporter_name: incident.reportedBy || incident.reporterName || null,
    reporter_phone: incident.reporterPhone || null,
    reporter_relation: incident.reporterRelation || null,
    vessel_name: incident.vesselName || null,
    vessel_type: incident.vesselType || null,
    vessel_length: incident.vesselLength ? parseFloat(s(incident.vesselLength)) : null,
    vessel_color: incident.vesselColor || null,
    vessel_registration: incident.vesselRegistration || null,
  }
}

const VICTIM_DATA_KEYS = ['name', 'age', 'gender', 'weight', 'heightFeet', 'upperClothing', 'lowerClothing', 'lifeJacketType', 'hasLifeJacket', 'medicalConditions']

/** A person counts as entered when anything about them was filled in. */
export function victimHasData(v: Answers = {}): boolean {
  return VICTIM_DATA_KEYS.some((k) => {
    const x = v[k]
    return x !== undefined && x !== null && x !== '' && !(Array.isArray(x) && !x.length) && x !== false
  })
}

/** RescueGPS toDbVictim: the victims row for a person (no id / incident_id). */
export function toDbVictim(victim: Answers): Row {
  const heightFt = victim.heightFt ?? victim.heightFeet
  const heightIn = victim.heightIn ?? victim.heightInches
  const weightLbs = victim.weightLbs ?? victim.weight
  const heightTotalIn = parseFloat(s(victim.height))
  const heightCm = heightFt
    ? Math.round((parseInt(s(heightFt)) * 12 + parseInt(s(heightIn || 0))) * 2.54)
    : Number.isFinite(heightTotalIn) && heightTotalIn > 0
      ? Math.round(heightTotalIn * 2.54)
      : (victim.heightCm ?? null)
  const weightKg = weightLbs ? Math.round(parseInt(s(weightLbs)) * 0.453592) : (victim.weightKg ?? null)
  const pick = (a: unknown, b: unknown) => (a ?? b)
  const heightEst = pick(victim.heightEstimate, victim.heightEstimated)
  const weightEst = pick(victim.weightEstimate, victim.weightEstimated)
  const reflective = pick(victim.lifeJacketReflective, victim.lifeJacketHasReflective)
  const codes = Array.isArray(victim.medicalConditionCodes) ? (victim.medicalConditionCodes as unknown[]) : []
  return {
    name: victim.name || null,
    age: victim.age ? parseInt(s(victim.age)) : null,
    gender: dbValue('gender', victim.gender) || 'unknown',
    height_cm: heightCm,
    weight_kg: weightKg,
    clothing_description: victim.clothingDescription || [
      victim.upperClothing && `Upper: ${s(victim.upperClothing)} (${String(victim.upperClothingColor)})`,
      victim.lowerClothing && `Lower: ${s(victim.lowerClothing)} (${String(victim.lowerClothingColor)})`,
    ].filter(Boolean).join('; ') || null,
    clothing_type: dbValue('clothing_type', victim.clothingType),
    upper_clothing: victim.upperClothing || null,
    upper_clothing_color: victim.upperClothingColor || null,
    lower_clothing: victim.lowerClothing || null,
    lower_clothing_color: victim.lowerClothingColor || null,
    has_life_jacket: victim.hasLifeJacket || false,
    life_jacket_color: victim.lifeJacketColor || null,
    life_jacket_type: victim.lifeJacketType || null,
    victim_state: victim.victimState || null,
    water_activity: victim.waterActivity || null,
    sea_state: victim.seaState || null,
    swimming_ability: dbValue('swimming_ability', victim.swimmingAbility) || 'unknown',
    injuries: victim.injuries || null,
    hypothermia_risk: dbValue('hypothermia_risk', victim.hypothermiaRisk),
    fatigue_level: dbValue('fatigue_level', victim.fatigue ?? victim.fatigueLevel),
    fitness_status: dbValue('fitness_status', victim.fitnessStatus),
    height_estimated: typeof heightEst === 'boolean' ? heightEst : null,
    weight_estimated: typeof weightEst === 'boolean' ? weightEst : null,
    life_jacket_has_reflective: typeof reflective === 'boolean' ? reflective : null,
    medical_condition_codes: ontologyMedicalCodes(victim.medicalConditionCodes),
    medical_conditions: (() => {
      const arr: unknown[] = codes.length > 0 ? [...codes] : victim.medicalConditions ? [victim.medicalConditions] : []
      if (victim.medicalNotes) arr.push(`notes: ${s(victim.medicalNotes)}`)
      return arr
    })(),
  }
}

/**
 * The database rows the answers become: the incidents row (columns and
 * details; id, created_by, team and the join password are the caller's) and
 * one victims row per person with any answer, in the order entered.
 */
export function wizardRowsFromAnswers(
  fd: Answers,
  keys: { incidentNumber?: string | null; clientId?: string | null } = {},
): { incident: Row; victims: Row[] } {
  const incident = wizardIncidentFromAnswers(fd, keys)
  const victims = (fd.victims || []).filter((v) => victimHasData(v)).map((v) => toDbVictim(v))
  return { incident: toDbIncident(incident), victims }
}
