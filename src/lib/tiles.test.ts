import { describe, it, expect } from 'vitest'
import {
  LABELS,
  MAX_LAT,
  SATELLITE,
  clampLat,
  latToTileY,
  lonToTileX,
  metersPerPixel,
  pickScaleBar,
  tileXToLon,
  tileYToLat,
  tilesForView,
  wrapTileX,
  zoomForSpan,
} from './tiles'

describe('projection', () => {
  // Reference values computed from the Web Mercator definition itself, not
  // from this code — the whole point is to catch a sign or a factor of two.
  it('places London at zoom 12', () => {
    expect(lonToTileX(-0.1246, 12)).toBeCloseTo(2046.5823289, 5)
    expect(latToTileY(51.5007, 12)).toBeCloseTo(1362.1470083, 5)
  })

  it('places Houston at zoom 16', () => {
    expect(lonToTileX(-95.3698, 16)).toBeCloseTo(15406.4577422, 4)
    expect(latToTileY(29.7604, 16)).toBeCloseTo(27088.8340815, 4)
  })

  it('places Sydney in the southern hemisphere at zoom 10', () => {
    expect(lonToTileX(151.2093, 10)).toBeCloseTo(942.1064533, 5)
    expect(latToTileY(-33.8688, 10)).toBeCloseTo(614.4944655, 5)
  })

  it('puts the null island at the middle of the zoom-1 world', () => {
    expect(lonToTileX(0, 1)).toBe(1)
    expect(latToTileY(0, 1)).toBeCloseTo(1, 12)
  })

  it('round-trips through the inverse', () => {
    for (const [lat, lon, z] of [
      [51.5007, -0.1246, 12],
      [29.7604, -95.3698, 18],
      [-33.8688, 151.2093, 6],
      [70.1, -140.9, 9],
    ] as const) {
      expect(tileXToLon(lonToTileX(lon, z), z)).toBeCloseTo(lon, 9)
      expect(tileYToLat(latToTileY(lat, z), z)).toBeCloseTo(lat, 9)
    }
  })

  it('squares the world off where Mercator runs away', () => {
    expect(clampLat(89)).toBe(MAX_LAT)
    expect(clampLat(-91)).toBe(-MAX_LAT)
    // Not NaN or Infinity, which is what an unclamped tan() would give.
    expect(Number.isFinite(latToTileY(90, 4))).toBe(true)
  })
})

describe('ground scale', () => {
  it('is 156 km per pixel at the equator on zoom 0', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.034, 2)
  })

  it('shrinks with the cosine of the latitude', () => {
    expect(metersPerPixel(29.7604, 16)).toBeCloseTo(2.0736141, 6)
    expect(metersPerPixel(60, 10)).toBeCloseTo(metersPerPixel(0, 10) / 2, 3)
  })

  it('picks the closest zoom that still fits the span', () => {
    // 200 m across a 320 px box: zoom 18 covers only 166 m, so 17 it is.
    const z = zoomForSpan(200, 29.76, 320)
    expect(z).toBe(17)
    expect(metersPerPixel(29.76, z) * 320).toBeGreaterThanOrEqual(200)
    expect(metersPerPixel(29.76, z + 1) * 320).toBeLessThan(200)
  })

  it('never proposes a zoom the source cannot serve', () => {
    expect(zoomForSpan(0.5, 0, 320)).toBe(19)
    expect(zoomForSpan(20_000_000, 0, 320)).toBe(1)
    expect(zoomForSpan(0, 0, 320)).toBe(19)
  })
})

describe('scale bar', () => {
  it('measures what it claims', () => {
    const bar = pickScaleBar(2, 120)
    expect(bar.px).toBeLessThanOrEqual(120)
    // 100 m at 2 m per pixel is 50 px.
    expect(bar).toEqual({ px: 50, label: '100 m' })
  })

  it('moves to nautical miles when zoomed out', () => {
    expect(pickScaleBar(100, 120).label).toBe('5 NM')
    expect(pickScaleBar(5000, 120).label).toBe('100 NM')
  })

  it('never draws a bar longer than the box it measures', () => {
    // Zoomed in past the shortest round step: fill the box and label what it
    // really spans, rather than drawing 1000 px of bar inside 40 px of map.
    const bar = pickScaleBar(0.01, 40)
    expect(bar.px).toBe(40)
    expect(bar.label).toBe('0.4 m')
  })

  it('uses metre steps at the closest zoom a source will serve', () => {
    // Zoom 19 at the equator is about 0.3 m per pixel.
    expect(pickScaleBar(metersPerPixel(0, 19), 120).label).toBe('25 m')
  })

  it('survives a map that has not been measured yet', () => {
    expect(pickScaleBar(0, 100).px).toBe(0)
    expect(pickScaleBar(2, 0).px).toBe(0)
  })
})

describe('tile cover', () => {
  const center = { lat: 29.7604, lon: -95.3698 }

  it('covers the viewport and no more', () => {
    const tiles = tilesForView(center, 16, 400, 300)
    // 400x300 px of 256 px tiles spans at most 3x3 once the centre offset is
    // taken into account.
    expect(tiles.length).toBeGreaterThanOrEqual(4)
    expect(tiles.length).toBeLessThanOrEqual(9)
  })

  it('lands the centre tile under the middle of the box', () => {
    const w = 512
    const h = 512
    const tiles = tilesForView(center, 16, w, h)
    const cx = lonToTileX(center.lon, 16)
    const cy = latToTileY(center.lat, 16)
    const mid = tiles.find(
      (t) => t.x === Math.floor(cx) && t.y === Math.floor(cy),
    )
    expect(mid).toBeDefined()
    // The centre of the map must fall inside that tile's 256 px box.
    expect(w / 2 - (mid as { left: number }).left).toBeGreaterThanOrEqual(0)
    expect(w / 2 - (mid as { left: number }).left).toBeLessThan(256)
    expect(h / 2 - (mid as { top: number }).top).toBeGreaterThanOrEqual(0)
    expect(h / 2 - (mid as { top: number }).top).toBeLessThan(256)
  })

  it('wraps across the date line instead of asking for tile -1', () => {
    const tiles = tilesForView({ lat: 0, lon: -179.99 }, 4, 512, 256)
    expect(tiles.every((t) => t.x >= 0 && t.x < 16)).toBe(true)
    // The tiles either side of the seam are both present, in their own places.
    expect(tiles.some((t) => t.x === 15)).toBe(true)
    expect(tiles.some((t) => t.x === 0)).toBe(true)
    expect(wrapTileX(-1, 4)).toBe(15)
    expect(wrapTileX(16, 4)).toBe(0)
  })

  it('does not ask for rows off the top or bottom of the world', () => {
    const tiles = tilesForView({ lat: 84.9, lon: 0 }, 3, 512, 512)
    expect(tiles.every((t) => t.y >= 0 && t.y < 8)).toBe(true)
  })
})

describe('imagery sources', () => {
  it('builds Esri URLs row-before-column', () => {
    // Getting this backwards returns imagery of somewhere else entirely, which
    // is why it is asserted rather than trusted.
    expect(SATELLITE.url(16, 15406, 27088)).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/16/27088/15406',
    )
    expect(LABELS.url(4, 1, 2)).toContain(
      '/Reference/World_Boundaries_and_Places/MapServer/tile/4/2/1',
    )
  })

  it('names its attribution and marks the overlay', () => {
    expect(SATELLITE.attribution).toMatch(/Esri/)
    expect(SATELLITE.overlay).toBeUndefined()
    expect(LABELS.overlay).toBe(true)
  })
})
