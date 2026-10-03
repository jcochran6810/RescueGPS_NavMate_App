/**
 * The new-incident wizard saves exactly what RescueGPS's wizard saves.
 *
 * wizardContract.fixtures.json is written by RescueGPS from its real save
 * path (frontend/src/__tests__/wizardContract.test.js) and copied here by its
 * frontend/scripts/sync-wizard-contract.sh. Every case's answers go through
 * this app's copy (rows.ts, answers.ts) and must give the same incidents row,
 * the same victims rows and the same list of what is still missing.
 */
process.env.TZ = 'UTC'

import { describe, expect, it } from 'vitest'
import fixtures from './wizardContract.fixtures.json'
import schema from './wizardSchema.json'
import { wizardRowsFromAnswers, type Answers } from './rows'
import { initialAnswers, missingAnswers, stepsFor, withPosition, fieldsFor } from './answers'

type Case = (typeof fixtures.cases)[number]

describe('wizard contract (RescueGPS fixtures)', () => {
  it('is the schema version the fixtures were written for', () => {
    expect(fixtures.version).toBe(schema.version)
    expect(fixtures.cases.length).toBeGreaterThan(5)
  })

  for (const c of fixtures.cases as Case[]) {
    it(`${c.id}: the same incidents row, victims rows and missing answers`, () => {
      const rows = wizardRowsFromAnswers(c.answers as Answers, c.keys)
      expect(rows.incident).toEqual(c.incident)
      expect(rows.victims).toEqual(c.victims)
      expect(missingAnswers(c.answers as Answers)).toEqual(c.missing)
    })
  }
})

describe('the wizard on this phone', () => {
  it('starts with every answer the schema asks, empty', () => {
    const a = initialAnswers()
    for (const t of schema.incidentTypes) {
      for (const s of stepsFor(t.id)) {
        for (const f of fieldsFor(s.id)) {
          for (const k of [f.lat, f.lng, f.date, f.hour, f.minute, f.estimate].filter(Boolean) as string[]) {
            expect(k in a, `${s.id}.${k}`).toBe(true)
          }
          if (!['position', 'dateparts', 'victims', 'password'].includes(f.kind)) expect(f.key in a, `${s.id}.${f.key}`).toBe(true)
        }
      }
    }
  })

  it('a GPS position is stored the way command\'s map picker stores it', () => {
    const field = fieldsFor('position').find((f) => f.kind === 'position')!
    const a = withPosition(initialAnswers(), field, 29.70353829, -95.0162608)
    expect(a).toMatchObject({
      lkpLat: 29.703538, lkpLng: -95.016261, coordinateFormat: 'DD',
      lkpLatDeg: '29.703538', lkpLatDir: 'N', lkpLngDeg: '95.016261', lkpLngDir: 'W',
    })
    const rows = wizardRowsFromAnswers({ ...a, incidentType: 'missing_person_piw' }, { incidentNumber: 'INC-1', clientId: 'c' })
    expect(rows.incident.lkp_lat).toBe(29.703538)
    expect(rows.incident.lkp_lng).toBe(-95.016261)
  })

  it('opens with only a type: nothing invented, everything required listed as missing', () => {
    const a = { ...initialAnswers(), incidentType: 'missing_person_piw', victims: [] }
    const rows = wizardRowsFromAnswers(a, { incidentNumber: 'INC-1', clientId: 'c' })
    expect(rows.incident.lkp_lat).toBeNull()
    expect(rows.incident.incident_time).toBeNull()
    expect(rows.victims).toEqual([])
    expect(missingAnswers(a).map((m) => m.key)).toEqual(
      expect.arrayContaining(['positionKnown', 'positionSource', 'activity', 'incidentTime', 'lastSeenTime']),
    )
  })
})
