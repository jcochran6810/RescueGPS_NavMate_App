import { describe, expect, it } from 'vitest'
import { AltitudeFilter } from './altitude'

/** Seeded so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r())
}

describe('AltitudeFilter', () => {
  it('holds a third-floor height steady through indoor noise and outliers', () => {
    const r = rng(7)
    const f = new AltitudeFilter()
    const truth = 14
    const shown: number[] = []
    for (let i = 0; i < 120; i++) {
      // ±25 m noise, and one reading in six a wild multipath outlier (+60…+100 m).
      const outlier = r() < 1 / 6
      const z = truth + (outlier ? 60 + 40 * r() : 25 * gauss(r))
      const est = f.push(z, outlier ? 20 : 25, i * 1000)
      if (i >= 20 && est) shown.push(est.altitude)
    }
    const lo = Math.min(...shown)
    const hi = Math.max(...shown)
    // Raw readings span ~-100…+330 ft. The shown value stays within ~20 m —
    // one-sided multipath leaves some upward bias no phone can remove.
    expect(lo).toBeGreaterThan(truth - 12)
    expect(hi).toBeLessThan(truth + 22)
    expect(hi - lo).toBeLessThan(25)
  })

  it('ignores readings that claim to be hopeless', () => {
    const f = new AltitudeFilter()
    f.push(10, 5, 0)
    const est = f.push(300, 150, 1000)
    expect(est!.altitude).toBeCloseTo(10, 5)
  })

  it('is not dragged up by one-sided multipath (reflections read high)', () => {
    const r = rng(3)
    const f = new AltitudeFilter()
    let est = null
    const shownSigma: number[] = []
    // 25 % of readings are reflections 30–95 m high, claiming better accuracy.
    for (let i = 0; i < 90; i++) {
      const out = r() < 0.25
      est = f.push(14 + (out ? 30 + 65 * r() : 25 * gauss(r)), out ? 20 : 25, i * 1000)
      shownSigma.push(est!.sigma)
    }
    expect(Math.abs(est!.altitude - 14)).toBeLessThan(15)
    // And it admits to it: the uncertainty covers the error it is left with.
    expect(2 * est!.sigma).toBeGreaterThan(Math.abs(est!.altitude - 14))
  })

  it('follows a real change in height within about a minute', () => {
    const f = new AltitudeFilter()
    for (let i = 0; i < 90; i++) f.push(5, 5, i * 1000)
    // Up a cliff path: a steady +40 m, every reading agreeing.
    let est = f.estimate!
    for (let i = 90; i < 150; i++) est = f.push(45, 5, i * 1000)!
    expect(est.altitude).toBeGreaterThan(40)
  })

  it('reports its own uncertainty, and never better than 5 m', () => {
    const f = new AltitudeFilter()
    const first = f.push(10, 40, 0)!
    expect(first.sigma).toBeCloseTo(40, 0)
    let est = first
    for (let i = 1; i < 60; i++) est = f.push(10, 5, i * 1000)!
    expect(est.sigma).toBe(5)
  })

  it('assumes ±30 m when the receiver gives no accuracy', () => {
    const est = new AltitudeFilter().push(10, null, 0)!
    expect(est.sigma).toBeCloseTo(30, 0)
  })

  it('is not shown until enough readings have arrived', () => {
    const f = new AltitudeFilter()
    for (let i = 0; i < 7; i++) expect(f.push(10, 10, i * 1000)!.settled).toBe(false)
    expect(f.push(10, 10, 7000)!.settled).toBe(true)
  })

  it('starts again after a long gap', () => {
    const f = new AltitudeFilter()
    f.push(10, 5, 0)
    const est = f.push(200, 5, 10 * 60 * 1000)!
    expect(est.altitude).toBe(200)
  })
})

import { formatHeight } from './units'
describe('formatHeight', () => {
  it('shows height with its uncertainty in feet', () => {
    expect(formatHeight(14, 9, 'ft')).toBe('46 ft (±30 ft)')
  })
  it('says settling rather than printing noise', () => {
    expect(formatHeight(14, 60, 'ft')).toBe('settling…')
  })
})
