import { describe, it, expect } from 'vitest'
import { TrackFilter } from './track'
import type { Fix } from './types'

/*
 * rc5 F7 (hostile GPS): the filter believed multipath when the receiver
 * under-reported its error — 178 m off while claiming ±4 m. A reflection
 * moves the position, not the Doppler course and speed: the fixes' own
 * velocity, integrated from the last position believed, is now what a run
 * of refused fixes (or the first fix after a dropout) must agree with before
 * it is believed. And a receiver whose fixes scatter wider than it claims
 * has its claim scaled up to match (normalised innovation squared).
 */

const M_LAT = 110850
const M_LON = 97000
const O = { lat: 29.3, lon: -94.8 }
const T0 = 1_800_000_000_000

function fixAt(t: number, x: number, y: number, acc: number, speed: number | null, heading: number | null): Fix {
  return {
    lat: O.lat + y / M_LAT,
    lon: O.lon + x / M_LON,
    accuracy: acc,
    speed,
    heading,
    altitude: null,
    timestamp: T0 + t * 1000,
    receivedAt: T0 + t * 1000,
  } as Fix
}

/** A tiny deterministic noise, metres. */
function noise(i: number): number {
  return Math.sin(i * 12.9898) * 1.5
}

function errOf(f: Fix, x: number, y: number): number {
  return Math.hypot((f.lon - O.lon) * M_LON - x, (f.lat - O.lat) * M_LAT - y)
}

describe('F7: a reflection is not believed against the receiver\'s own velocity', () => {
  it('a six-fix excursion 120 m off, claiming ±4 m, while the Doppler says straight on at 10 m/s', () => {
    const f = new TrackFilter({ maxAccuracyM: 25 })
    let worstClaimed = 0
    for (let t = 1; t <= 90; t++) {
      const y = 10 * t
      const mp = t >= 40 && t < 46
      const raw = fixAt(t, (mp ? 120 : 0) + noise(t), y + noise(t + 99), 4, 10, 0)
      const res = f.push(raw)
      if (!res.accepted) continue
      const e = errOf(res.fix, 0, y)
      const acc = res.fix.accuracy ?? 0
      // Never a position far off while claiming to be good.
      if (e > 20) worstClaimed = Math.max(worstClaimed, e / Math.max(acc, 1))
      if (mp) {
        // Refused or dead-reckoned: the boat's own track, not the reflection.
        expect(e).toBeLessThan(25)
      }
    }
    expect(worstClaimed).toBeLessThan(1)
  })

  it('the first fix after a dropout, 170 m off with the Doppler straight on, is refused', () => {
    const f = new TrackFilter({ maxAccuracyM: 25 })
    for (let t = 1; t <= 30; t++) f.push(fixAt(t, noise(t), 14 * t + noise(t + 7), 4, 14, 0))
    // 12 s of nothing, then a reflection 170 m east.
    const res = f.push(fixAt(43, 170, 14 * 43, 5, 14, 0))
    expect(res.accepted && !res.fix.estimate && errOf(res.fix, 0, 14 * 43) > 50).toBe(false)
    // …and the true fixes that follow are taken, on the track.
    let last: Fix | null = null
    for (let t = 44; t <= 50; t++) {
      const r = f.push(fixAt(t, noise(t), 14 * t, 4, 14, 0))
      if (r.accepted) last = r.fix
    }
    expect(last).not.toBeNull()
    expect(errOf(last as Fix, 0, 14 * 50)).toBeLessThan(10)
  })

  it('a real turn, reported by the receiver itself, is still followed', () => {
    const f = new TrackFilter({ maxAccuracyM: 25 })
    let x = 0
    let y = 0
    let h = 0
    let worst = 0
    for (let t = 1; t <= 60; t++) {
      if (t > 20 && t <= 29) h += 20 // 180° at 20°/s, 9 m/s
      x += 9 * Math.sin((h * Math.PI) / 180)
      y += 9 * Math.cos((h * Math.PI) / 180)
      const res = f.push(fixAt(t, x + noise(t), y + noise(t + 3), 4, 9, h % 360))
      if (res.accepted && t > 32) worst = Math.max(worst, errOf(res.fix, x, y))
    }
    expect(worst).toBeLessThan(15)
  })
})

describe('F7: a receiver that under-reports its error has its claim scaled up', () => {
  it('±10 m scatter claimed as ±3 m: the reported accuracy grows toward the truth; an honest one does not', () => {
    const scatter = (i: number) => 10 * Math.sin(i * 7.77) * Math.cos(i * 3.1)
    const liar = new TrackFilter({ maxAccuracyM: 25 })
    const honest = new TrackFilter({ maxAccuracyM: 25 })
    let liarAcc = 0
    let honestAcc = 0
    for (let t = 1; t <= 80; t++) {
      const y = 5 * t
      const a = liar.push(fixAt(t, scatter(t), y + scatter(t + 50), 3, 5, 0))
      const b = honest.push(fixAt(t, noise(t), y + noise(t + 50), 4, 5, 0))
      if (a.accepted) liarAcc = a.fix.accuracy ?? 0
      if (b.accepted) honestAcc = b.fix.accuracy ?? 0
    }
    expect(liarAcc).toBeGreaterThan(5)
    expect(honestAcc).toBeLessThanOrEqual(4.5)
  })
})
