/**
 * Who is being looked for.
 *
 * This is the command system's `victims` table, written from the field. Every
 * option below was read off that table's **live CHECK constraints** before it
 * was offered, for the reason CLAUDE.md records about incident types: a value
 * the database refuses fails at sync, and a failed op stops the whole offline
 * queue behind it. Adding a plausible-sounding option here is how a crew loses
 * a waypoint queued an hour later.
 *
 * The subset is deliberate. That table has 40 columns; a phone in a wheelhouse
 * gets the ones that change how the search is run:
 *
 *   - **what they look like**, because that is what the searchers are scanning
 *     for — clothing colours above all, which is the single most useful thing
 *     anyone on a boat can be told;
 *   - **what keeps them up**, because a life jacket is the difference between
 *     a search and a recovery, and the survival model reads it;
 *   - **what the water is doing to them** — clothing weight, build, swimming
 *     ability, intoxication — which is what the command side's survivability
 *     model takes.
 *
 * Height and weight are stored in **feet/inches and pounds**, which are the
 * table's own `height_ft`/`height_in`/`weight_lbs` columns, not a conversion
 * of the metric ones. The metric pair is left null rather than filled with a
 * rounded round-trip: two columns disagreeing by a rounding step is worse than
 * one column being empty.
 */

export interface VictimOption {
  value: string
  label: string
}

export const GENDERS: VictimOption[] = [
  { value: '', label: 'Not recorded' },
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'unknown', label: 'Unknown' },
]

export const BODY_TYPES: VictimOption[] = [
  { value: '', label: 'Not recorded' },
  { value: 'thin', label: 'Thin' },
  { value: 'average', label: 'Average' },
  { value: 'heavy', label: 'Heavy' },
]

/** How much the clothing weighs in the water — a survivability input. */
export const CLOTHING_TYPES: VictimOption[] = [
  { value: '', label: 'Not recorded' },
  { value: 'none', label: 'Little or none' },
  { value: 'light', label: 'Light clothing' },
  { value: 'heavy', label: 'Heavy clothing' },
  { value: 'immersion_suit', label: 'Immersion suit' },
]

export const SWIMMING_ABILITY: VictimOption[] = [
  { value: '', label: 'Not recorded' },
  { value: 'expert', label: 'Expert' },
  { value: 'strong', label: 'Strong' },
  { value: 'average', label: 'Average' },
  { value: 'weak', label: 'Weak' },
  { value: 'non_swimmer', label: 'Non-swimmer' },
  { value: 'unknown', label: 'Unknown' },
]

export const INTOXICATION: VictimOption[] = [
  { value: '', label: 'Not recorded' },
  { value: 'sober', label: 'Sober' },
  { value: 'impaired', label: 'Impaired' },
  { value: 'intoxicated', label: 'Intoxicated' },
  { value: 'unknown', label: 'Unknown' },
]

export const VICTIM_STATUS: VictimOption[] = [
  { value: 'missing', label: 'Missing' },
  { value: 'located', label: 'Located' },
  { value: 'rescued', label: 'Rescued' },
  { value: 'recovered', label: 'Recovered' },
  { value: 'self_rescued', label: 'Self-rescued' },
]

/** What the form holds. Every field optional — a crew types what it knows. */
export interface VictimDraft {
  name: string
  age: string
  gender: string
  height_ft: string
  height_in: string
  height_estimated: boolean
  weight_lbs: string
  weight_estimated: boolean
  body_type: string
  hair_color: string
  upper_clothing: string
  upper_clothing_color: string
  lower_clothing: string
  lower_clothing_color: string
  clothing_type: string
  has_life_jacket: boolean
  life_jacket_color: string
  life_jacket_has_reflective: boolean
  swimming_ability: string
  intoxication_level: string
  injuries: string
  status: string
}

export const EMPTY_VICTIM: VictimDraft = {
  name: '',
  age: '',
  gender: '',
  height_ft: '',
  height_in: '',
  height_estimated: false,
  weight_lbs: '',
  weight_estimated: false,
  body_type: '',
  hair_color: '',
  upper_clothing: '',
  upper_clothing_color: '',
  lower_clothing: '',
  lower_clothing_color: '',
  clothing_type: '',
  has_life_jacket: false,
  life_jacket_color: '',
  life_jacket_has_reflective: false,
  swimming_ability: '',
  intoxication_level: '',
  injuries: '',
  status: 'missing',
}

/** Is there anything here worth writing a row for? */
export function victimIsEmpty(v: VictimDraft): boolean {
  return (
    Object.entries(v).filter(([k, value]) => {
      if (k === 'status') return false
      return typeof value === 'string' ? value.trim() !== '' : value === true
    }).length === 0
  )
}

function num(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  // `Number('')` is 0 and `Number('abc')` is NaN — an empty box must not
  // become a five-year-old, which is the same refusal `parseCoord` makes.
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

function text(value: string): string | null {
  const t = value.trim()
  return t === '' ? null : t
}

/**
 * The row the command system reads.
 *
 * Empty boxes become SQL null rather than empty strings: their dashboard
 * renders what is present, and `''` is present. A choice left at "Not
 * recorded" is likewise null, never the literal — which is also the only way
 * to satisfy the CHECK constraints, since `''` is not one of the values they
 * allow.
 */
export function victimRow(
  v: VictimDraft,
  incidentId: string,
): Record<string, unknown> {
  return {
    incident_id: incidentId,
    name: text(v.name),
    age: num(v.age),
    gender: text(v.gender),
    height_ft: num(v.height_ft),
    height_in: num(v.height_in),
    height_estimated: v.height_estimated,
    weight_lbs: num(v.weight_lbs),
    weight_estimated: v.weight_estimated,
    body_type: text(v.body_type),
    hair_color: text(v.hair_color),
    upper_clothing: text(v.upper_clothing),
    upper_clothing_color: text(v.upper_clothing_color),
    lower_clothing: text(v.lower_clothing),
    lower_clothing_color: text(v.lower_clothing_color),
    clothing_type: text(v.clothing_type),
    has_life_jacket: v.has_life_jacket,
    life_jacket_color: text(v.life_jacket_color),
    life_jacket_has_reflective: v.life_jacket_has_reflective,
    swimming_ability: text(v.swimming_ability),
    intoxication_level: text(v.intoxication_level),
    injuries: text(v.injuries),
    status: v.status || 'missing',
  }
}

/** One line for the card: what a crew would say over the radio. */
export function victimSummary(v: VictimDraft): string {
  const bits: string[] = []
  if (v.name.trim()) bits.push(v.name.trim())
  const who = [v.age.trim() ? `${v.age.trim()}` : '', v.gender].filter(Boolean)
  if (who.length > 0) bits.push(who.join(' '))
  if (v.height_ft.trim()) {
    bits.push(`${v.height_ft.trim()}'${v.height_in.trim() || '0'}"`)
  }
  if (v.weight_lbs.trim()) bits.push(`${v.weight_lbs.trim()} lb`)
  const wearing = [
    [v.upper_clothing_color, v.upper_clothing].filter((s) => s.trim()).join(' '),
    [v.lower_clothing_color, v.lower_clothing].filter((s) => s.trim()).join(' '),
  ].filter(Boolean)
  if (wearing.length > 0) bits.push(wearing.join(', '))
  // Said last and said plainly, because it is the thing that changes how the
  // search is run.
  bits.push(v.has_life_jacket ? 'life jacket ON' : 'no life jacket recorded')
  return bits.join(' · ')
}
