import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * "Keep ___ ft from shallows" (`shallow_margin_m`) is a new boat setting, and
 * the server's `vessels` table may not have the column yet (the migration is
 * written, not applied). PostgREST refuses a write that names a column it
 * does not have — so the boat's other settings must still sync, the setting
 * must still hold on this device, and the column is only sent once the
 * server's own rows show it exists.
 */

const upsertImpl = vi.fn<(row: Record<string, unknown>) => Promise<{ error: unknown }>>()
const updateImpl = vi.fn<(patch: Record<string, unknown>, id: unknown) => void>()
const getSessionImpl = vi.fn()
let rows: Record<string, unknown>[] = []

vi.mock('@/lib/supabase', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  supabase: {
    auth: { getSession: (...args: unknown[]) => getSessionImpl(...args) },
    from: () => ({
      upsert: (row: Record<string, unknown>) => upsertImpl(row),
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          updateImpl(patch, id)
          return Promise.resolve({ error: null })
        },
      }),
      select: () => ({
        is: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }),
      }),
    }),
  },
}))

import { useVessels } from './useVessels'
import { DEFAULT_SHALLOW_MARGIN_M, shallowMarginOf, VESSEL_DEFAULTS } from '@/lib/vessel'

function serverRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    client_id: id,
    team_id: null,
    name: 'Marine 1',
    callsign: '',
    draft_m: 0.9,
    air_draft_m: 3,
    beam_m: 2.6,
    length_m: 7.6,
    cruise_speed_kn: 20,
    max_speed_kn: 35,
    fuel_burn_gph: 0,
    under_keel_margin_m: 0.6,
    clearance_m: 30,
    created_by: 'u1',
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    ...extra,
  }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true })
  upsertImpl.mockReset().mockResolvedValue({ error: null })
  updateImpl.mockReset()
  getSessionImpl.mockReset().mockResolvedValue({ data: { session: { user: { id: 'u1' } } } })
  rows = []
  useVessels.getState().clearLocal()
})

describe('shallow_margin_m', () => {
  it('defaults to 100 ft for a boat that has none', () => {
    expect(shallowMarginOf({})).toBeCloseTo(30.48, 2)
    expect(shallowMarginOf({ shallow_margin_m: null })).toBe(DEFAULT_SHALLOW_MARGIN_M)
    expect(shallowMarginOf({ shallow_margin_m: 45 })).toBe(45)
    expect(shallowMarginOf({ shallow_margin_m: -3 })).toBe(DEFAULT_SHALLOW_MARGIN_M)
  })

  it('without the column on the server: never sent, kept on the device, the rest syncs', async () => {
    const v = await useVessels.getState().addVessel({ ...VESSEL_DEFAULTS, name: 'Marine 1', shallow_margin_m: 45 })
    expect(v).not.toBeNull()
    expect(upsertImpl).toHaveBeenCalledTimes(1)
    expect(upsertImpl.mock.calls[0][0]).not.toHaveProperty('shallow_margin_m')
    expect(upsertImpl.mock.calls[0][0]).toMatchObject({ name: 'Marine 1', clearance_m: 30 })

    // The server's rows come back without the column: the device's value holds.
    rows = [serverRow(v!.id)]
    await useVessels.getState().load()
    const seen = useVessels.getState().visible().find((x) => x.id === v!.id)
    expect(seen?.shallow_margin_m).toBe(45)

    // An edit of only the margin: nothing for the server, still held here.
    await useVessels.getState().updateVessel(v!.id, { shallow_margin_m: 60 })
    expect(updateImpl).not.toHaveBeenCalled()
    expect(useVessels.getState().pending).toEqual([])
    expect(useVessels.getState().visible().find((x) => x.id === v!.id)?.shallow_margin_m).toBe(60)

    // An edit with other settings: those are sent, the margin is not.
    await useVessels.getState().updateVessel(v!.id, { clearance_m: 40, shallow_margin_m: 70 })
    expect(updateImpl).toHaveBeenCalledTimes(1)
    expect(updateImpl.mock.calls[0][0]).toEqual({ clearance_m: 40 })
  })

  it('once the server shows the column, it is sent — and the server’s value wins', async () => {
    rows = [serverRow('b1', { shallow_margin_m: 50 })]
    await useVessels.getState().load()
    expect(useVessels.getState().serverHasShallowMargin).toBe(true)
    expect(useVessels.getState().visible()[0].shallow_margin_m).toBe(50)
    await useVessels.getState().updateVessel('b1', { shallow_margin_m: 80 })
    expect(updateImpl).toHaveBeenCalledTimes(1)
    expect(updateImpl.mock.calls[0][0]).toEqual({ shallow_margin_m: 80 })
  })
})
