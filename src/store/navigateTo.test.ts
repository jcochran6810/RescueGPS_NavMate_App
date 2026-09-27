import { describe, it, expect, vi } from 'vitest'

const setDestination = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/store/useNavigation', () => ({
  useNavigation: { getState: () => ({ setDestination }) },
}))

import { navigateTo } from './navigateTo'

describe('navigateTo — "Navigate here" from anywhere', () => {
  it('plans to the place from my live position, at once', async () => {
    await navigateTo({ lat: 29.31, lon: -94.79, label: 'Datum' })
    expect(setDestination).toHaveBeenCalledTimes(1)
    // origin null = my location, even if a start was set by hand earlier:
    // "navigate here" means from where the boat is.
    expect(setDestination).toHaveBeenCalledWith(
      { lat: 29.31, lon: -94.79, label: 'Datum' },
      null,
    )
  })
})
