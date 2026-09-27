import { describe, it, expect, vi, afterEach } from 'vitest'
import { sharedClock } from './useNow'
import { gpsChip, navCardView } from '@/lib/navView'
import { projectPosition } from '@/lib/sar'

/*
 * UI-6: the header's GPS chip and the steering card each ran their own
 * one-second timer, so for up to a second after the fix went stale one said
 * "GPS lost" while the other still showed live numbers. Both now read one
 * shared tick (`useClock`), so on every tick they judge the same fix at the
 * same moment.
 */
describe('the shared clock (UI-6)', () => {
  afterEach(() => vi.useRealTimers())

  it('gives every subscriber the same moment, once a second, and stops with the last', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const seen: number[][] = [[], []]
    const offA = sharedClock.subscribe(() => seen[0].push(sharedClock.read()))
    vi.advanceTimersByTime(400)
    const offB = sharedClock.subscribe(() => seen[1].push(sharedClock.read()))
    vi.advanceTimersByTime(3000)
    // B subscribed 0.4 s after A, yet both were told of exactly the same
    // ticks — not two clocks 0.4 s apart.
    expect(seen[0]).toEqual([1_001_000, 1_002_000, 1_003_000])
    expect(seen[1]).toEqual(seen[0])
    offA()
    offB()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('so the chip and the card agree on a fix going stale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    const A = { lat: 29.3, lon: -94.8 }
    const B = projectPosition(A.lat, A.lon, 0, 1)
    const fix = { ...projectPosition(A.lat, A.lon, 0, 0.5), accuracy: 5, heading: 0, timestamp: 2_000_000 - 14_600 }
    const verdicts: [boolean, boolean][] = []
    const off = sharedClock.subscribe(() => {
      const now = sharedClock.read()
      const chipLost = gpsChip(true, fix, now).kind === 'lost'
      const cardStale = navCardView({
        plan: { points: [A, B], arrivalFt: [150, 150] },
        status: 'navigating',
        targetIdx: 1,
        fix,
        now,
        speedKn: 10,
        cruiseKn: 20,
        arrivalFt: 150,
        bearingPref: 'true',
        declination: null,
        gpsPoor: false,
        rerouting: false,
        offCourseSince: null,
      }).stale
      verdicts.push([chipLost, cardStale])
    })
    vi.advanceTimersByTime(3000)
    off()
    expect(verdicts.map(([a]) => a)).toEqual([true, true, true])
    for (const [chip, card] of verdicts) expect(chip).toBe(card)
  })
})
