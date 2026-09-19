import { describe, it, expect } from 'vitest'
import {
  EMPTY_VICTIM,
  victimIsEmpty,
  victimRow,
  victimSummary,
  GENDERS,
  BODY_TYPES,
  CLOTHING_TYPES,
  SWIMMING_ABILITY,
  INTOXICATION,
  VICTIM_STATUS,
} from './victim'

describe('victimRow', () => {
  /*
   * Empty boxes must become SQL null, not empty strings. Two reasons, and the
   * second one is the dangerous one: their dashboard renders what is present
   * and `''` is present, and `''` satisfies none of the CHECK constraints on
   * gender, build, clothing weight, swimming ability or intoxication — so a
   * blank choice written as `''` is an insert the database refuses, which
   * stops the offline queue behind it.
   */
  it('writes an untouched form as nulls, not empty strings', () => {
    const row = victimRow(EMPTY_VICTIM, 'inc-1')
    for (const key of [
      'name', 'age', 'gender', 'height_ft', 'height_in', 'weight_lbs',
      'body_type', 'hair_color', 'upper_clothing', 'upper_clothing_color',
      'lower_clothing', 'lower_clothing_color', 'clothing_type',
      'life_jacket_color', 'swimming_ability', 'intoxication_level', 'injuries',
    ]) {
      expect(row[key], key).toBeNull()
    }
    expect(row.incident_id).toBe('inc-1')
    expect(row.status).toBe('missing')
    expect(row.has_life_jacket).toBe(false)
  })

  it('never invents a number from an empty or unreadable box', () => {
    // Number('') is 0 and Number('abc') is NaN — the same class of bug as the
    // import that turned a missing coordinate into a position off Africa.
    const row = victimRow({ ...EMPTY_VICTIM, age: '   ', weight_lbs: 'heavy' }, 'i')
    expect(row.age).toBeNull()
    expect(row.weight_lbs).toBeNull()
  })

  it('keeps feet, inches and pounds as the table’s own columns', () => {
    const row = victimRow(
      { ...EMPTY_VICTIM, height_ft: '5', height_in: '10', weight_lbs: '185' },
      'i',
    )
    expect(row.height_ft).toBe(5)
    expect(row.height_in).toBe(10)
    expect(row.weight_lbs).toBe(185)
  })

  it('carries every choice as a value the live CHECK constraints allow', () => {
    for (const [field, options] of [
      ['gender', GENDERS],
      ['body_type', BODY_TYPES],
      ['clothing_type', CLOTHING_TYPES],
      ['swimming_ability', SWIMMING_ABILITY],
      ['intoxication_level', INTOXICATION],
      ['status', VICTIM_STATUS],
    ] as const) {
      for (const option of options) {
        const row = victimRow({ ...EMPTY_VICTIM, [field]: option.value }, 'i')
        // Either the value itself, or null for "not recorded" — never ''.
        expect(row[field] === null || row[field] === option.value, `${field}=${option.value}`).toBe(true)
        expect(row[field]).not.toBe('')
      }
    }
  })
})

describe('victimIsEmpty', () => {
  it('is true for a form nobody has touched', () => {
    expect(victimIsEmpty(EMPTY_VICTIM)).toBe(true)
  })

  it('is false the moment anything at all is said', () => {
    expect(victimIsEmpty({ ...EMPTY_VICTIM, upper_clothing_color: 'red' })).toBe(false)
    expect(victimIsEmpty({ ...EMPTY_VICTIM, has_life_jacket: true })).toBe(false)
  })

  /* Status defaults to "missing" on a blank form, so it cannot count. */
  it('does not count the status that was never chosen', () => {
    expect(victimIsEmpty({ ...EMPTY_VICTIM, status: 'missing' })).toBe(true)
  })
})

describe('victimSummary', () => {
  it('reads like a radio call, clothing first', () => {
    const line = victimSummary({
      ...EMPTY_VICTIM,
      name: 'J. Doe',
      age: '34',
      gender: 'male',
      height_ft: '5',
      height_in: '10',
      upper_clothing_color: 'red',
      upper_clothing: 't-shirt',
      lower_clothing_color: 'blue',
      lower_clothing: 'jeans',
      has_life_jacket: true,
    })
    expect(line).toContain('J. Doe')
    expect(line).toContain("5'10\"")
    expect(line).toContain('red t-shirt')
    expect(line).toContain('blue jeans')
    expect(line).toContain('life jacket ON')
  })

  /*
   * "Nobody has said" is itself worth seeing: a search run assuming a life
   * jacket that was never reported is a search run on a survival window that
   * does not exist.
   */
  it('says plainly when no life jacket has been reported', () => {
    expect(victimSummary(EMPTY_VICTIM)).toContain('no life jacket recorded')
  })
})
