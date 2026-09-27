import { describe, it, expect, vi, beforeEach } from 'vitest'

const setDestination = vi.hoisted(() => vi.fn(async () => {}))
const nav = vi.hoisted(() => ({
  state: { status: 'idle', dest: null as { label: string } | null },
}))
vi.mock('@/store/useNavigation', () => ({
  useNavigation: { getState: () => ({ ...nav.state, setDestination }) },
}))

import { navigateTo } from './navigateTo'

beforeEach(() => {
  setDestination.mockClear()
  nav.state = { status: 'idle', dest: null }
})

describe('navigateTo — "Navigate here" from anywhere', () => {
  it('plans to the place from my live position, at once', async () => {
    await expect(navigateTo({ lat: 29.31, lon: -94.79, label: 'Datum' })).resolves.toBe(true)
    expect(setDestination).toHaveBeenCalledTimes(1)
    // origin null = my location, even if a start was set by hand earlier:
    // "navigate here" means from where the boat is.
    expect(setDestination).toHaveBeenCalledWith(
      { lat: 29.31, lon: -94.79, label: 'Datum' },
      null,
    )
  })

  it('asks before replacing a route being steered — and leaves it alone when the crew says no', async () => {
    nav.state = { status: 'navigating', dest: { label: 'Galveston Bay' } }
    const ask = vi.fn(() => false)
    await expect(navigateTo({ lat: 29.31, lon: -94.79, label: 'Dropped pin' }, ask)).resolves.toBe(false)
    expect(ask).toHaveBeenCalledWith(expect.stringMatching(/Stop the route to Galveston Bay and go to Dropped pin/))
    expect(setDestination).not.toHaveBeenCalled()
  })

  it('replaces it when the crew says yes', async () => {
    nav.state = { status: 'navigating', dest: { label: 'Galveston Bay' } }
    await expect(navigateTo({ lat: 29.31, lon: -94.79, label: 'Datum' }, () => true)).resolves.toBe(true)
    expect(setDestination).toHaveBeenCalledTimes(1)
  })

  it('does not ask when nothing is being steered', async () => {
    nav.state = { status: 'preview', dest: { label: 'Galveston Bay' } }
    const ask = vi.fn(() => false)
    await navigateTo({ lat: 29.31, lon: -94.79, label: 'Datum' }, ask)
    expect(ask).not.toHaveBeenCalled()
    expect(setDestination).toHaveBeenCalledTimes(1)
  })
})
