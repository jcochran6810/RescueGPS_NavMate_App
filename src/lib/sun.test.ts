// Sun event times are read against the device's own timezone, so the tests
// pin one rather than inheriting whatever the machine happens to be set to.
process.env.TZ = 'America/Chicago'

import { describe, it, expect } from 'vitest'
import {
  sunEvents,
  nextSunEvent,
  formatCountdown,
  formatDayLength,
  formatSunClock,
  sunClockParts,
  isNextDay,
} from './sun'

/** Minutes between two instants, for tolerance assertions. */
const minutesApart = (a: Date, b: Date) =>
  Math.abs(a.getTime() - b.getTime()) / 60_000

describe('sunEvents', () => {
  it('gives an equinox at the equator that straddles 06:00 and 18:00 UTC', () => {
    // The classic hand check, with two caveats it is easy to forget: the sun
    // is timed by its upper limb through a refracting atmosphere, so the day
    // runs about seven minutes long; and the equation of time offsets solar
    // noon from 12:00 by a few minutes in March. Both shift the pair together,
    // so the tolerance is loose but the symmetry below is tight.
    const e = sunEvents(new Date('2026-03-20T12:00:00Z'), 0, 0)
    expect(e.sunrise).not.toBeNull()
    expect(e.sunset).not.toBeNull()
    expect(minutesApart(e.sunrise!, new Date('2026-03-20T06:00:00Z'))).toBeLessThan(15)
    expect(minutesApart(e.sunset!, new Date('2026-03-20T18:00:00Z'))).toBeLessThan(15)
    expect(e.dayLengthH).toBeGreaterThan(12.05)
    expect(e.dayLengthH).toBeLessThan(12.2)
  })

  it('matches published times for Houston (30.013 N, 95.186 W) on 2026-08-06', () => {
    // The reference figures a crew would read off a printed almanac:
    // dawn 06:17, sunrise 06:43, sunset 20:12, dusk 20:38 CDT.
    const e = sunEvents(new Date('2026-08-06T12:00:00-05:00'), 30.01306, -95.185534)
    expect(minutesApart(e.dawn!, new Date('2026-08-06T06:17:00-05:00'))).toBeLessThan(4)
    expect(minutesApart(e.sunrise!, new Date('2026-08-06T06:43:00-05:00'))).toBeLessThan(4)
    expect(minutesApart(e.sunset!, new Date('2026-08-06T20:12:00-05:00'))).toBeLessThan(4)
    expect(minutesApart(e.dusk!, new Date('2026-08-06T20:38:00-05:00'))).toBeLessThan(4)
  })

  it('orders dawn before sunrise before noon before sunset before dusk', () => {
    const e = sunEvents(new Date('2026-08-06T12:00:00-05:00'), 30.01306, -95.185534)
    const t = [e.dawn!, e.sunrise!, e.solarNoon, e.sunset!, e.dusk!].map((d) =>
      d.getTime(),
    )
    expect(t).toEqual([...t].sort((a, b) => a - b))
  })

  it('is symmetric about solar noon', () => {
    const e = sunEvents(new Date('2026-05-14T12:00:00Z'), 45, -70)
    const before = e.solarNoon.getTime() - e.sunrise!.getTime()
    const after = e.sunset!.getTime() - e.solarNoon.getTime()
    expect(Math.abs(before - after)).toBeLessThan(1000)
  })

  it('puts solar noon within the equation of time of 12:00 UTC on the meridian', () => {
    // The equation of time never exceeds about 17 minutes either way.
    for (const iso of [
      '2026-01-15T12:00:00Z',
      '2026-04-15T12:00:00Z',
      '2026-07-15T12:00:00Z',
      '2026-11-03T12:00:00Z',
    ]) {
      const e = sunEvents(new Date(iso), 0, 0)
      expect(minutesApart(e.solarNoon, new Date(iso))).toBeLessThan(17)
    }
  })

  it('gives roughly twelve hours of day at the equator all year', () => {
    for (const iso of ['2026-01-10T12:00:00Z', '2026-06-21T12:00:00Z']) {
      const e = sunEvents(new Date(iso), 0, 20)
      expect(e.dayLengthH).toBeGreaterThan(11.7)
      expect(e.dayLengthH).toBeLessThan(12.3)
    }
  })

  it('shifts events by an hour for every 15 degrees of longitude', () => {
    const a = sunEvents(new Date('2026-06-01T12:00:00Z'), 40, 0)
    const b = sunEvents(new Date('2026-06-01T12:00:00Z'), 40, -15)
    const shiftH = (b.sunrise!.getTime() - a.sunrise!.getTime()) / 3_600_000
    expect(shiftH).toBeGreaterThan(0.95)
    expect(shiftH).toBeLessThan(1.05)
  })

  it('reports midnight sun above the Arctic circle in June', () => {
    const e = sunEvents(new Date('2026-06-21T12:00:00Z'), 78.22, 15.65) // Svalbard
    expect(e.sunrise).toBeNull()
    expect(e.sunset).toBeNull()
    expect(e.alwaysUp).toBe(true)
    expect(e.alwaysDown).toBe(false)
    expect(e.dayLengthH).toBe(24)
  })

  it('reports polar night above the Arctic circle in December', () => {
    const e = sunEvents(new Date('2026-12-21T12:00:00Z'), 78.22, 15.65)
    expect(e.sunrise).toBeNull()
    expect(e.alwaysUp).toBe(false)
    expect(e.alwaysDown).toBe(true)
    expect(e.dayLengthH).toBe(0)
  })

  it('still reports a solar noon when the sun never rises', () => {
    const e = sunEvents(new Date('2026-12-21T12:00:00Z'), 78.22, 15.65)
    expect(e.solarNoon).toBeInstanceOf(Date)
    expect(Number.isNaN(e.solarNoon.getTime())).toBe(false)
  })

  it('resolves the local day correctly the other side of the date line', () => {
    // Fiji: UTC+12. Its solar noon on a given local date lands on the previous
    // UTC date, which is where a naive UTC-day calculation goes wrong.
    const e = sunEvents(new Date('2026-08-06T12:00:00+12:00'), -18.14, 178.44)
    expect(e.sunrise!.getTime()).toBeLessThan(e.solarNoon.getTime())
    expect(minutesApart(e.solarNoon, new Date('2026-08-06T12:00:00+12:00'))).toBeLessThan(60)
  })
})

describe('nextSunEvent', () => {
  it('counts to dawn from late in the evening', () => {
    const now = new Date('2026-08-05T22:24:00-05:00')
    const next = nextSunEvent(now, 30.01306, -95.185534)
    expect(next?.name).toBe('dawn')
    expect(minutesApart(next!.at, new Date('2026-08-06T06:17:00-05:00'))).toBeLessThan(4)
    // Roughly the 07:53 the crew would see on the panel.
    expect(next!.msUntil / 3_600_000).toBeGreaterThan(7.5)
    expect(next!.msUntil / 3_600_000).toBeLessThan(8.2)
  })

  it('counts to sunset in the middle of the afternoon', () => {
    const now = new Date('2026-08-06T15:00:00-05:00')
    expect(nextSunEvent(now, 30.01306, -95.185534)?.name).toBe('sunset')
  })

  it('counts to sunrise between dawn and sunrise', () => {
    const now = new Date('2026-08-06T06:30:00-05:00')
    expect(nextSunEvent(now, 30.01306, -95.185534)?.name).toBe('sunrise')
  })

  it('always returns a time in the future', () => {
    const now = new Date('2026-08-06T20:12:30-05:00')
    const next = nextSunEvent(now, 30.01306, -95.185534)
    expect(next!.at.getTime()).toBeGreaterThan(now.getTime())
    expect(next!.msUntil).toBeGreaterThan(0)
  })

  it('returns null rather than inventing one inside a polar night', () => {
    expect(nextSunEvent(new Date('2026-12-21T12:00:00Z'), 78.22, 15.65)).toBeNull()
  })
})

describe('formatting', () => {
  it('renders a countdown as HH:MM:SS', () => {
    expect(formatCountdown(7 * 3_600_000 + 53 * 60_000 + 24_000)).toBe('07:53:24')
    expect(formatCountdown(0)).toBe('00:00:00')
    expect(formatCountdown(59_000)).toBe('00:00:59')
  })

  it('prefixes days past twenty-four hours', () => {
    expect(formatCountdown(26 * 3_600_000)).toBe('1d 02:00:00')
  })

  it('refuses to render a negative or unknown countdown', () => {
    expect(formatCountdown(-1)).toBe('—')
    expect(formatCountdown(Number.NaN)).toBe('—')
  })

  it('renders day length in hours and minutes', () => {
    expect(formatDayLength(13.7)).toBe('13h 42m')
    expect(formatDayLength(9)).toBe('9h 00m')
  })

  it('renders a missing sun event as an em dash', () => {
    expect(formatSunClock(null)).toBe('—')
  })
})

describe('sunClockParts', () => {
  it('splits the clock and the suffix so neither can wrap away from the other', () => {
    const at = new Date('2026-08-06T11:19:00Z')
    const parts = sunClockParts(at)
    // The suffix is whatever the runtime locale uses, or absent on a 24-hour
    // clock — but rejoining the two halves must reproduce the single-string
    // formatter exactly, or the tiles would disagree with the countdown row.
    const rejoined = parts.suffix
      ? `${parts.time} ${parts.suffix}`
      : parts.time
    expect(rejoined).toBe(formatSunClock(at))
  })

  it('never leaves the suffix stuck to the digits', () => {
    const { time } = sunClockParts(new Date('2026-08-06T23:45:00Z'))
    expect(time).toMatch(/^\d{1,2}:\d{2}$/)
  })

  it('renders a missing sun event as an em dash with no suffix', () => {
    expect(sunClockParts(null)).toEqual({ time: '—', suffix: null })
  })
})

describe('isNextDay', () => {
  it('is true across local midnight', () => {
    expect(
      isNextDay(new Date('2026-08-06T06:17:00-05:00'), new Date('2026-08-05T22:24:00-05:00')),
    ).toBe(true)
  })

  it('is false within the same local day', () => {
    expect(
      isNextDay(new Date('2026-08-05T20:12:00-05:00'), new Date('2026-08-05T15:00:00-05:00')),
    ).toBe(false)
  })
})
