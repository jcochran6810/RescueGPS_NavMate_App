/**
 * Web Mercator tile arithmetic, and the imagery the map draws.
 *
 * Everything here is the standard slippy-map scheme (EPSG:3857, 256 px tiles,
 * zoom 0 = one tile for the world). Written out rather than pulled in with a
 * mapping library because the map this app needs is small — pan, zoom, a
 * track, some markers — and a library would bring a second projection, a
 * second event model and a second offline story into an app that already has
 * opinions about all three.
 */

export const TILE_SIZE = 256

/**
 * The latitude where Mercator gives up. Beyond it the projection runs to
 * infinity, so the standard scheme squares the world off here.
 */
export const MAX_LAT = 85.05112878

export interface TileSource {
  id: string
  label: string
  /** Tile URL for a zoom and tile column/row. */
  url: (z: number, x: number, y: number) => string
  minZoom: number
  maxZoom: number
  attribution: string
  /**
   * Request the tiles with CORS. A CORS response can be cached and measured;
   * an opaque one counts many times its size against the storage quota and
   * cannot be inspected at all. Only set where the host is known to send
   * `Access-Control-Allow-Origin`.
   */
  crossOrigin: boolean
  /** Drawn over the base layer rather than instead of it. */
  overlay?: boolean
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services'

/**
 * Esri World Imagery — aerial and satellite, free to use with attribution and
 * no key, which is what makes it usable here: this app has no server to hide a
 * token behind, and a key compiled into a static bundle is a key given away.
 *
 * Note the tile path is `{z}/{y}/{x}` — row before column, unlike the
 * `{z}/{x}/{y}` of most other schemes. Getting that backwards yields imagery
 * of somewhere real, which is exactly why it is called out here.
 */
export const SATELLITE: TileSource = {
  id: 'satellite',
  label: 'Satellite',
  url: (z, x, y) => `${ESRI}/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  minZoom: 0,
  maxZoom: 19,
  attribution: 'Imagery: Esri, Maxar, Earthstar Geographics',
  crossOrigin: true,
}

/** Place names, boundaries and roads, drawn transparent over the imagery. */
export const LABELS: TileSource = {
  id: 'labels',
  label: 'Labels',
  url: (z, x, y) =>
    `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
  minZoom: 0,
  maxZoom: 19,
  attribution: 'Labels: Esri',
  crossOrigin: true,
  overlay: true,
}

/** Hosts the service worker is allowed to keep imagery from. */
export const TILE_HOSTS = ['server.arcgisonline.com']

export function clampLat(lat: number): number {
  return Math.min(MAX_LAT, Math.max(-MAX_LAT, lat))
}

/** Longitude to fractional tile column at a zoom. */
export function lonToTileX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 2 ** zoom
}

/** Latitude to fractional tile row at a zoom. */
export function latToTileY(lat: number, zoom: number): number {
  const p = (clampLat(lat) * Math.PI) / 180
  return (
    ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * 2 ** zoom
  )
}

export function tileXToLon(x: number, zoom: number): number {
  return (x / 2 ** zoom) * 360 - 180
}

export function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI - 2 * Math.PI * (y / 2 ** zoom)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

/**
 * Ground distance one screen pixel covers, in metres.
 *
 * This is what makes a scale bar and an accuracy circle true rather than
 * decorative: both are drawn from it. 156543.03 m is the equator divided by
 * the 256 pixels of the zoom-0 tile.
 */
export function metersPerPixel(lat: number, zoom: number): number {
  return (
    (156543.03392804097 * Math.cos((clampLat(lat) * Math.PI) / 180)) /
    2 ** zoom
  )
}

/** The zoom at which a span of metres fits inside a box of pixels. */
export function zoomForSpan(
  spanM: number,
  lat: number,
  pixels: number,
  max = 19,
): number {
  if (!(spanM > 0) || !(pixels > 0)) return max
  const needed = Math.log2(
    (156543.03392804097 * Math.cos((clampLat(lat) * Math.PI) / 180) * pixels) /
      spanM,
  )
  return Math.max(1, Math.min(max, Math.floor(needed)))
}

/** Wrap a tile column into range, so panning past the date line still paints. */
export function wrapTileX(x: number, zoom: number): number {
  const n = 2 ** zoom
  return ((x % n) + n) % n
}

/**
 * A round distance that fits inside `maxPx`, and how long it is on screen.
 *
 * Metres up to a kilometre, then nautical miles: the crew measures short legs
 * off a photograph in metres and long ones off a chart in miles, and a bar
 * labelled "0.05 NM" helps nobody.
 */
export function pickScaleBar(
  metersPerPx: number,
  maxPx: number,
): { px: number; label: string } {
  const steps: { m: number; label: string }[] = [
    { m: 1, label: '1 m' },
    { m: 2, label: '2 m' },
    { m: 5, label: '5 m' },
    { m: 10, label: '10 m' },
    { m: 25, label: '25 m' },
    { m: 50, label: '50 m' },
    { m: 100, label: '100 m' },
    { m: 250, label: '250 m' },
    { m: 500, label: '500 m' },
    { m: 926, label: '0.5 NM' },
    { m: 1852, label: '1 NM' },
    { m: 3704, label: '2 NM' },
    { m: 9260, label: '5 NM' },
    { m: 18520, label: '10 NM' },
    { m: 46300, label: '25 NM' },
    { m: 92600, label: '50 NM' },
    { m: 185200, label: '100 NM' },
    { m: 926000, label: '500 NM' },
  ]
  if (!(metersPerPx > 0) || !(maxPx > 0)) {
    return { px: 0, label: steps[0].label }
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    const px = steps[i].m / metersPerPx
    if (px <= maxPx) return { px, label: steps[i].label }
  }
  // Zoomed in past the shortest round step. Rather than draw a bar longer
  // than the box it sits in — which would measure wrong — fill the box and
  // label what it actually spans.
  const m = maxPx * metersPerPx
  return { px: maxPx, label: m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m` }
}

export interface TileRef {
  key: string
  /** Column and row to request — wrapped, and inside the world. */
  x: number
  y: number
  z: number
  /** Where the tile's top-left corner sits, in unscaled layer pixels. */
  left: number
  top: number
}

/**
 * Every tile needed to cover a viewport, with the pixel position of each.
 *
 * `width`/`height` are the layer's own pixels — that is, the viewport divided
 * by whatever fractional scale is being applied on top — so the caller gets
 * enough tiles to fill the screen when it is zoomed between two levels.
 */
export function tilesForView(
  center: { lat: number; lon: number },
  z: number,
  width: number,
  height: number,
): TileRef[] {
  const n = 2 ** z
  const cx = lonToTileX(center.lon, z)
  const cy = latToTileY(center.lat, z)
  const halfW = width / 2 / TILE_SIZE
  const halfH = height / 2 / TILE_SIZE

  const x0 = Math.floor(cx - halfW)
  const x1 = Math.floor(cx + halfW)
  const y0 = Math.max(0, Math.floor(cy - halfH))
  const y1 = Math.min(n - 1, Math.floor(cy + halfH))

  const out: TileRef[] = []
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      out.push({
        // The wrapped column is what gets requested, but the unwrapped one
        // places it — two copies of the same tile either side of the date
        // line are the same image in different places.
        key: `${z}/${tx}/${ty}`,
        x: wrapTileX(tx, z),
        y: ty,
        z,
        left: width / 2 + (tx - cx) * TILE_SIZE,
        top: height / 2 + (ty - cy) * TILE_SIZE,
      })
    }
  }
  return out
}
