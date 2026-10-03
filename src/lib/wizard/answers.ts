/**
 * The new-incident wizard's answers on this phone: where they start, which
 * questions show given the others, and which required answers are still
 * missing — the same rules as RescueGPS's wizard (wizardSchema.json and its
 * `missingAnswers`, held to it by wizardContract.fixtures.json).
 *
 * A crew rarely knows everything at the moment a search starts. Nothing here
 * blocks: what is missing is shown, the incident opens anyway, and command
 * reopens the same wizard in RescueGPS to fill it in.
 */
import { WIZARD_SCHEMA as schema, type Answers } from './rows'

export type FieldKind =
  | 'choice' | 'yesno' | 'position' | 'select' | 'text' | 'tel' | 'number' | 'textarea'
  | 'datetime' | 'dateparts' | 'victims' | 'password' | 'checkbox' | 'height' | 'multiselect'

export interface WizardField {
  key: string
  label: string
  kind: FieldKind
  options?: string
  required?: boolean
  requiredFor?: string[]
  requiredAnyOf?: string[]
  onlyFor?: string[]
  when?: Record<string, unknown>
  lat?: string
  lng?: string
  date?: string
  hour?: string
  minute?: string
  estimate?: string
  feet?: string
  inches?: string
  yes?: string
  no?: string
  optOut?: string
}

export interface WizardStep {
  id: string
  label: string
}

export interface Option {
  value: string
  label: string
  description?: string
}

export const INCIDENT_TYPE_CHOICES = schema.incidentTypes
export const stepsFor = (type: unknown): WizardStep[] =>
  (schema.steps as Record<string, WizardStep[]>)[String(type)] ?? [{ id: 'type', label: 'Incident Type' }]
export const fieldsFor = (stepId: string): WizardField[] =>
  ((schema.stepFields as Record<string, WizardField[]>)[stepId] ?? [])
export const VICTIM_FIELDS = schema.victimFields as WizardField[]
export const optionsFor = (name: string | undefined): Option[] =>
  name ? ((schema.options as Record<string, Option[]>)[name] ?? []) : []

const pad2 = (n: number) => String(n).padStart(2, '0')
/** Today on this phone's clock, as the date inputs use it. */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** A person with nothing entered (RescueGPS createEmptyVictim). */
export function emptyVictim(): Answers {
  return {
    name: '', age: '', ageEstimate: false, gender: '', weight: '', weightEstimate: false,
    heightFeet: '', heightInches: '', heightEstimate: false,
    upperClothing: '', upperClothingColor: '', lowerClothing: '', lowerClothingColor: '',
    hasLifeJacket: false, lifeJacketType: '', lifeJacketColor: '', lifeJacketReflective: false,
    victimState: '', waterActivity: '', seaState: '',
    medicalConditions: '', medicalConditionCodes: [], medicalNotes: '', injuries: '',
    hypothermiaRisk: '', fatigue: '', fitnessStatus: '', swimmingAbility: '',
  }
}

/** The answers a new wizard starts with (RescueGPS getInitialFormData, the parts asked here). */
export function initialAnswers(): Answers {
  const today = localDateString()
  return {
    incidentName: '',
    incidentType: '',
    positionKnown: null,
    coordinateFormat: 'DD',
    lkpLat: '', lkpLng: '',
    lkpLatDeg: '', lkpLatDir: 'N', lkpLngDeg: '', lkpLngDir: 'W',
    positionSource: '', confidenceLevel: '',
    eyewitnessName: '', eyewitnessContact: '',
    areaDescription: '',
    watercraftType: '', watercraftName: '', watercraftDescription: '', watercraftColor: '',
    watercraftLength: '', registrationNumber: '',
    departureLat: '', departureLng: '', departureLocation: '', departureTime: '',
    bearing: '', speed: '', expectedArrivalTime: '',
    destinationKnown: null, destinationLat: '', destinationLng: '',
    destinationDescription: '', destinationAreaDescription: '',
    foundWatercraftType: '', foundCondition: '',
    debrisType: '', debrisDescription: '', debrisQuantity: '', debrisSpread: '',
    reportingSource: '', reporterContact: '',
    victims: [emptyVictim()],
    fallFromHeight: false, fallHeight: '', fallHeightEstimated: false, fallSource: '',
    impactPosition: '', waterType: 'salt', depthCalculation: null,
    activity: '', activityDescription: '',
    piwPossibility: null, piwDetails: '',
    incidentDate: today, incidentTimeHour: '', incidentTimeMinute: '', incidentTimeEstimate: false,
    lastSeenDate: today, lastSeenTimeHour: '', lastSeenTimeMinute: '', lastSeenTimeEstimate: false,
    reportedDate: today, reportedTimeHour: '', reportedTimeMinute: '',
    searchPriority: '', searchPattern: '', searchNotes: '',
    description: '',
    incidentPassword: '',
  }
}

/**
 * Set a position in the answers the way RescueGPS's map picker does: the
 * decimal pair and the DD fields, so its wizard reopens on the same numbers.
 */
export function withPosition(fd: Answers, field: WizardField, lat: number | null, lng: number | null): Answers {
  const latKey = field.lat ?? 'lkpLat'
  const lngKey = field.lng ?? 'lkpLng'
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    const cleared: Answers = { ...fd, [latKey]: '', [lngKey]: '' }
    if (latKey === 'lkpLat') Object.assign(cleared, { lkpLatDeg: '', lkpLngDeg: '' })
    return cleared
  }
  const la = Number(lat.toFixed(6))
  const ln = Number(lng.toFixed(6))
  const out: Answers = { ...fd, [latKey]: la, [lngKey]: ln }
  if (latKey === 'lkpLat') {
    Object.assign(out, {
      coordinateFormat: 'DD',
      lkpLatDeg: Math.abs(la).toFixed(6), lkpLatDir: la >= 0 ? 'N' : 'S',
      lkpLngDeg: Math.abs(ln).toFixed(6), lkpLngDir: ln >= 0 ? 'E' : 'W',
    })
  }
  return out
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)

function fieldValue(fd: Answers, field: WizardField): unknown {
  switch (field.kind) {
    case 'position': return filled(fd[field.lat!]) && filled(fd[field.lng!]) ? [fd[field.lat!], fd[field.lng!]] : null
    case 'dateparts': return filled(fd[field.date!]) && filled(fd[field.hour!]) && filled(fd[field.minute!]) ? 'set' : null
    case 'height': return filled(fd[field.feet!]) ? 'set' : null
    case 'yesno': return typeof fd[field.key] === 'boolean' ? fd[field.key] : null
    default: return filled(fd[field.key]) ? fd[field.key] : null
  }
}

/** Is a field asked, given the other answers (its `when`, `onlyFor`)? */
export function fieldShown(fd: Answers, field: WizardField, incidentType: unknown = fd.incidentType): boolean {
  if (field.onlyFor && !field.onlyFor.includes(String(incidentType))) return false
  if (!field.when) return true
  return Object.entries(field.when).every(([k, v]) => fd[k] === v)
}

function fieldRequired(field: WizardField, incidentType: unknown): boolean {
  return field.required === true || (Array.isArray(field.requiredFor) && field.requiredFor.includes(String(incidentType)))
}

export interface MissingAnswer {
  step: string
  stepLabel: string
  key: string
  label: string
  victim?: number
}

/** The answers the wizard requires that are still missing, in step order. */
export function missingAnswers(fd: Answers): MissingAnswer[] {
  const type = fd.incidentType
  if (!type) return [{ step: 'type', stepLabel: 'Incident Type', key: 'incidentType', label: 'Incident type' }]
  const out: MissingAnswer[] = []
  for (const step of stepsFor(type)) {
    for (const field of fieldsFor(step.id)) {
      if (!fieldShown(fd, field, type)) continue
      if (field.kind === 'victims') {
        ;(fd.victims ?? []).forEach((v, i) => {
          for (const vf of VICTIM_FIELDS) {
            if (!fieldShown(v, vf, type) || !fieldRequired(vf, type)) continue
            if (fieldValue(v, vf) == null) out.push({ step: step.id, stepLabel: step.label, key: vf.key, label: `Person ${i + 1}: ${vf.label}`, victim: i })
          }
        })
        continue
      }
      if (field.requiredAnyOf) {
        const any = field.requiredAnyOf.some((k) => {
          const f = fieldsFor(step.id).find((x) => x.key === k) ?? ({ key: k, kind: 'text' } as WizardField)
          return fieldValue(fd, f) != null
        })
        if (!any) out.push({ step: step.id, stepLabel: step.label, key: field.key, label: field.label })
        continue
      }
      if (!fieldRequired(field, type)) continue
      if (fieldValue(fd, field) == null) out.push({ step: step.id, stepLabel: step.label, key: field.key, label: field.label })
    }
  }
  return out
}
