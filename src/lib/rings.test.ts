import { describe, it, expect } from 'vitest'
import {
  alongForward,
  forwardScreenDeg,
  pickRings,
  ringLabel,
  rulerLengthPx,
  unitInMeters,
} from './rings'

describe('pickRings', () => {
  it('fits its outermost ring inside the space it was given', () => {
    // 2 m per pixel, 300 px of room — the outermost must not overflow.
    const rings = pickRings(2, 300, 'nm')
    expect(rings.length).toBe(3)
    expect(rings[2].px).toBeLessThanOrEqual(300)
  })

  it('spaces them evenly, innermost first', () => {
    const rings = pickRings(2, 300, 'nm')
    expect(rings[1].meters).toBeCloseTo(rings[0].meters * 2, 6)
    expect(rings[2].meters).toBeCloseTo(rings[0].meters * 3, 6)
  })

  /*
   * The point of the fixed steps: a crew reads "0.5 NM" off a ring and says
   * it on the radio. Whatever the zoom happens to be, the label is a number
   * a person would use.
   */
  it('lands on distances people say out loud', () => {
    // The rings are the first three multiples of one spacing off the ladder,
    // so the labels read 100 / 200 / 300 ft, or 0.5 / 1 / 1.5 NM.
    for (const mpp of [0.5, 1, 2, 5, 17, 60, 240]) {
      const rings = pickRings(mpp, 300, 'nm')
      if (rings.length === 0) continue
      for (const r of rings) {
        expect(r.label, `${mpp} m/px`).toMatch(/^[\d.]+ (ft|NM)$/)
      }
      rings.forEach((r, i) => {
        expect(r.meters).toBeCloseTo(rings[0].meters * (i + 1), 6)
      })
    }
  })

  /*
   * The gap a browser found: a compass map is zoomed in close, and the
   * smallest whole-unit step — a twentieth of a nautical mile — needs 278 m
   * of screen for three rings where there is room for about 140. No rings
   * were drawn at all on the one screen they had been asked for.
   */
  it('has short steps for a map zoomed in close', () => {
    const rings = pickRings(1.2, 138, 'nm')
    expect(rings.length).toBeGreaterThanOrEqual(3)
    expect(rings[0].label).toMatch(/ft$/)
    expect(rings[rings.length - 1].px).toBeLessThanOrEqual(138)
  })

  /*
   * The contract changed when the rings became a ruler to the edge of the
   * screen: the count is no longer "three" but "as many as fit and can still
   * be read". A long scale divided into three is one nobody can interpolate
   * on, so the *finest* readable spacing wins rather than the coarsest that
   * fits three.
   */
  it('divides a long scale finely rather than into three', () => {
    const short = pickRings(1.2, 138, 'nm')
    const long = pickRings(1.2, 420, 'nm')
    expect(long.length).toBeGreaterThan(short.length)
    // And the last graduation still lands inside the length it was given.
    expect(long[long.length - 1].px).toBeLessThanOrEqual(420)
  })

  it('never crowds past six graduations', () => {
    for (const len of [138, 300, 420, 900, 2000]) {
      expect(pickRings(1.2, len, 'nm').length).toBeLessThanOrEqual(6)
    }
  })

  it('says metres to a crew that reads kilometres, feet to one that does not', () => {
    expect(pickRings(1.2, 138, 'km')[0].label).toMatch(/m$/)
    expect(pickRings(1.2, 138, 'mi')[0].label).toMatch(/ft$/)
  })

  it('writes the rings in the unit the crew reads, once they are far enough out', () => {
    expect(pickRings(40, 300, 'km')[0].label).toMatch(/km$/)
    expect(pickRings(40, 300, 'mi')[0].label).toMatch(/mi$/)
    expect(pickRings(40, 300, 'nm')[0].label).toMatch(/NM$/)
  })

  it('never writes a trailing zero on a ring', () => {
    for (const r of pickRings(2, 300, 'nm')) expect(r.label).not.toMatch(/\.\d*0 /)
  })

  /*
   * Refusing is the right answer when nothing fits: a ring drawn off the edge
   * of the screen is a ring nobody can read, and inventing a spacing to have
   * something to draw is the guess this app declines to make elsewhere.
   */
  it('draws nothing rather than inventing a spacing', () => {
    expect(pickRings(0, 300, 'nm')).toEqual([])
    expect(pickRings(2, 0, 'nm')).toEqual([])
    // Zoomed far enough out every step "fits" — as a circle a fraction of a
    // pixel across, drawn on top of the boat. That is not a ring either, and
    // this check is what made the code say so.
    expect(pickRings(1_000_000, 300, 'nm')).toEqual([])
  })

  it('never returns more graduations than it was allowed', () => {
    expect(pickRings(2, 300, 'nm', 1).length).toBeLessThanOrEqual(1)
    expect(pickRings(2, 300, 'nm', 2).length).toBeLessThanOrEqual(2)
  })
})

describe('forwardScreenDeg', () => {
  /*
   * The whole reason for a heading-up map: what is ahead of the boat is ahead
   * on the screen, with no rotation left for the crew to do in their head.
   */
  it('is straight up the screen once the map is turned to the heading', () => {
    expect(forwardScreenDeg(137, 137)).toBe(0)
    expect(forwardScreenDeg(0, 0)).toBe(0)
  })

  it('is the heading itself on a north-up map', () => {
    expect(forwardScreenDeg(90, 0)).toBe(90)
  })

  it('wraps the short way round rather than going negative', () => {
    expect(forwardScreenDeg(10, 350)).toBe(20)
    expect(forwardScreenDeg(350, 10)).toBe(340)
  })

  it('has nothing to say without a direction', () => {
    expect(forwardScreenDeg(null, 0)).toBeNull()
    expect(forwardScreenDeg(undefined, 0)).toBeNull()
    expect(forwardScreenDeg(Number.NaN, 0)).toBeNull()
  })
})

describe('alongForward', () => {
  /* Screen y grows downward, so "ahead" has to come out negative. */
  it('puts straight ahead above the boat, not below it', () => {
    const { dx, dy } = alongForward(0, 100)
    expect(dx).toBeCloseTo(0, 6)
    expect(dy).toBeCloseTo(-100, 6)
  })

  it('puts east to the right and south below', () => {
    expect(alongForward(90, 100).dx).toBeCloseTo(100, 6)
    expect(alongForward(180, 100).dy).toBeCloseTo(100, 6)
  })
})

describe('ringLabel and unitInMeters', () => {
  it('converts a distance in metres into the crew’s unit', () => {
    expect(ringLabel(1852, 'nm')).toBe('1 NM')
    expect(ringLabel(1000, 'km')).toBe('1 km')
  })

  it('knows how many metres are in one of each', () => {
    expect(unitInMeters('nm')).toBe(1852)
    expect(unitInMeters('km')).toBe(1000)
    expect(unitInMeters('mi')).toBeCloseTo(1609.344, 3)
  })
})

describe('rulerLengthPx', () => {
  /*
   * The scale has to reach the edge of the screen. Straight up from the
   * middle of a 300×400 box, that is 200 px less the margin that keeps the
   * arrow head and the last label inside.
   */
  it('measures to the edge along the way the crew is facing', () => {
    expect(rulerLengthPx(150, 200, 300, 400, 0, 18)).toBeCloseTo(182, 6)
    expect(rulerLengthPx(150, 200, 300, 400, 180, 18)).toBeCloseTo(182, 6)
    expect(rulerLengthPx(150, 200, 300, 400, 90, 18)).toBeCloseTo(132, 6)
  })

  it('shortens as the boat approaches the edge it is facing', () => {
    expect(rulerLengthPx(150, 40, 300, 400, 0, 18)).toBeCloseTo(22, 6)
  })

  /* Off the edge already: nothing to draw, rather than a negative ruler. */
  it('never returns a negative length', () => {
    expect(rulerLengthPx(150, 5, 300, 400, 0, 18)).toBe(0)
  })

  it('handles a diagonal by whichever edge comes first', () => {
    /*
     * 45° up and to the right from (150, 200) in a 300 × 260 box: 150 px of
     * room to the right and 200 to the top, so the *side* is reached first at
     * 150·√2. The first version of this check said the top wins and was
     * simply wrong about its own geometry — the code was right.
     */
    expect(rulerLengthPx(150, 200, 300, 260, 45, 0)).toBeCloseTo(150 * Math.SQRT2, 6)
  })
})
