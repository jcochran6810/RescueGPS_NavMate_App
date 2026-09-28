import type { ChartFeatures, Ring } from '../routing'
import type { LatLon } from '../search'

/*
 * An independent shortest compliant path, for the router's property tests.
 *
 * Shares nothing with routing.ts / routeGeometry.ts: its own raster (scanline
 * fill at cell centres, finest chart wins, land over depth within a chart),
 * its own exact Euclidean distance transform, its own 16-neighbour Dijkstra
 * and string-pull. The rules are the router's, read PERMISSIVELY so that the
 * answer is (up to the grid) a lower bound on the shortest route that keeps
 * them: depth at least `safeDepthM` at the cell centre; at least the
 * stand-off from land and hazards, less half a cell; shallow water no closer
 * than the least margin the router ever keeps (5 m outside a marked channel,
 * 3 m inside one), less half a cell; within `approachM` of either end,
 * anything not land or a hazard.
 */

export interface ShortestRules {
  safeDepthM: number
  clearanceM: number
  approachM?: number
  /** Least margin from shallow water outside / inside a marked channel, metres. */
  marginOutM?: number
  marginInM?: number
  cellM?: number
}

export interface ShortestResult {
  lengthM: number
  path: LatLon[]
}

const LAND = -Infinity

export function independentShortest(
  f: ChartFeatures,
  from: LatLon,
  to: LatLon,
  rules: ShortestRules,
): ShortestResult | null {
  const cell = rules.cellM ?? 12
  const approach = rules.approachM ?? 120
  const midLat = (from.lat + to.lat) / 2
  const mLat = 111_132.954 - 559.822 * Math.cos((2 * midLat * Math.PI) / 180)
  const mLon = (Math.PI / 180) * 6_378_137 * Math.cos((midLat * Math.PI) / 180)
  const dist = Math.hypot((to.lat - from.lat) * mLat, (to.lon - from.lon) * mLon)
  const margin = Math.max(2000, 0.6 * dist)
  const lat0 = Math.min(from.lat, to.lat) - margin / mLat
  const lon0 = Math.min(from.lon, to.lon) - margin / mLon
  const W = Math.abs(to.lon - from.lon) * mLon + 2 * margin
  const H = Math.abs(to.lat - from.lat) * mLat + 2 * margin
  const cols = Math.ceil(W / cell)
  const rows = Math.ceil(H / cell)
  const n = cols * rows
  const X = (lon: number) => (lon - lon0) * mLon
  const Y = (lat: number) => (lat - lat0) * mLat

  // --- raster: state (depth, LAND, NaN), level, hazard, channel
  const state = new Float64Array(n).fill(NaN)
  const level = new Float64Array(n).fill(-Infinity)
  const hazard = new Uint8Array(n)
  const channel = new Uint8Array(n)
  const fill = (rings: Ring[], paint: (i: number) => void) => {
    const rowsX = new Map<number, number[]>()
    for (const ring of rings) {
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const ax = X(ring[b][0])
        const ay = Y(ring[b][1])
        const bx = X(ring[a][0])
        const by = Y(ring[a][1])
        const r0 = Math.max(0, Math.ceil(Math.min(ay, by) / cell - 0.5))
        const r1 = Math.min(rows - 1, Math.floor(Math.max(ay, by) / cell - 0.5))
        for (let r = r0; r <= r1; r++) {
          const yc = (r + 0.5) * cell
          if (ay <= yc === by <= yc) continue
          const x = ax + ((yc - ay) / (by - ay)) * (bx - ax)
          let xs = rowsX.get(r)
          if (!xs) rowsX.set(r, (xs = []))
          xs.push(x)
        }
      }
    }
    for (const [r, xs] of rowsX) {
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] / cell - 0.5))
        const c1 = Math.min(cols - 1, Math.floor(xs[k + 1] / cell - 0.5))
        for (let c = c0; c <= c1; c++) paint(r * cols + c)
      }
    }
  }
  const combine = (i: number, lvl: number, v: number) => {
    if (lvl > level[i]) {
      level[i] = lvl
      state[i] = v
    } else if (lvl === level[i]) {
      state[i] = v === LAND || state[i] === LAND ? LAND : Math.min(state[i], v)
    }
  }
  for (const p of f.depthAreas) {
    if (!Number.isFinite(p.minDepthM)) continue
    fill(p.rings, (i) => combine(i, p.level ?? 0, p.minDepthM))
  }
  for (const p of f.land) {
    if (p.hazard) fill(p.rings, (i) => (hazard[i] = 1))
    else fill(p.rings, (i) => combine(i, p.level ?? 0, LAND))
  }
  for (const c of f.channels) fill(c.rings, (i) => (channel[i] = 1))
  const disc = (x: number, y: number, r: number) => {
    const c0 = Math.max(0, Math.floor((x - r) / cell))
    const c1 = Math.min(cols - 1, Math.floor((x + r) / cell))
    const r0 = Math.max(0, Math.floor((y - r) / cell))
    const r1 = Math.min(rows - 1, Math.floor((y + r) / cell))
    for (let rr = r0; rr <= r1; rr++) {
      for (let cc = c0; cc <= c1; cc++) {
        if (Math.hypot((cc + 0.5) * cell - x, (rr + 0.5) * cell - y) <= r) hazard[rr * cols + cc] = 1
      }
    }
  }
  for (const h of f.hazards) disc(X(h.lon), Y(h.lat), h.radiusM)
  for (const l of f.lines ?? []) {
    for (const path of l.paths) {
      for (let k = 1; k < path.length; k++) {
        const ax = X(path[k - 1][0])
        const ay = Y(path[k - 1][1])
        const bx = X(path[k][0])
        const by = Y(path[k][1])
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (cell / 2)))
        for (let s = 0; s <= steps; s++) disc(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, l.widthM / 2)
      }
    }
  }

  // --- distances (exact EDT, metres, centre to centre)
  const edt = (src: (i: number) => boolean): Float64Array => {
    const INF = 1e20
    const g = new Float64Array(n)
    for (let i = 0; i < n; i++) g[i] = src(i) ? 0 : INF
    const oneD = (get: (k: number) => number, set: (k: number, v: number) => void, len: number) => {
      const v = new Int32Array(len)
      const z = new Float64Array(len + 1)
      const fvals = new Float64Array(len)
      for (let q = 0; q < len; q++) fvals[q] = get(q)
      let k = 0
      v[0] = 0
      z[0] = -INF
      z[1] = INF
      for (let q = 1; q < len; q++) {
        let s = (fvals[q] + q * q - (fvals[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
        while (s <= z[k]) {
          k--
          s = (fvals[q] + q * q - (fvals[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
        }
        k++
        v[k] = q
        z[k] = s
        z[k + 1] = INF
      }
      k = 0
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++
        set(q, (q - v[k]) * (q - v[k]) + fvals[v[k]])
      }
    }
    for (let r = 0; r < rows; r++) oneD((c) => g[r * cols + c], (c, val) => (g[r * cols + c] = val), cols)
    for (let c = 0; c < cols; c++) oneD((r) => g[r * cols + c], (r, val) => (g[r * cols + c] = val), rows)
    for (let i = 0; i < n; i++) g[i] = Math.sqrt(g[i]) * cell
    return g
  }
  const toBlocked = edt((i) => state[i] === LAND || hazard[i] === 1)
  const toShallow = edt((i) => Number.isFinite(state[i]) && state[i] < rules.safeDepthM && hazard[i] === 0)

  // --- usable cells
  const fx = X(from.lon)
  const fy = Y(from.lat)
  const tx = X(to.lon)
  const ty = Y(to.lat)
  const usable = new Uint8Array(n)
  const half = cell / 2
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (state[i] === LAND || hazard[i]) continue
      const x = (c + 0.5) * cell
      const y = (r + 0.5) * cell
      if (Math.hypot(x - fx, y - fy) <= approach || Math.hypot(x - tx, y - ty) <= approach) {
        usable[i] = 1
        continue
      }
      if (!(state[i] >= rules.safeDepthM)) continue
      if (toBlocked[i] < rules.clearanceM - half) continue
      const m = channel[i] ? (rules.marginInM ?? 3) : (rules.marginOutM ?? 5)
      if (toShallow[i] < m - half) continue
      usable[i] = 1
    }
  }
  const cellOf = (x: number, y: number) => {
    const c = Math.floor(x / cell)
    const r = Math.floor(y / cell)
    return c >= 0 && r >= 0 && c < cols && r < rows ? r * cols + c : -1
  }
  const si = cellOf(fx, fy)
  const gi = cellOf(tx, ty)
  if (si < 0 || gi < 0 || !usable[si] || !usable[gi]) return null

  // --- line of sight over usable cells (supercover of the centre-to-centre line)
  const sees = (a: number, b: number): boolean => {
    let x = a % cols
    let y = (a - x) / cols
    const x1 = b % cols
    const y1 = (b - x1) / cols
    const dx = Math.abs(x1 - x)
    const dy = Math.abs(y1 - y)
    const sx = x < x1 ? 1 : -1
    const sy = y < y1 ? 1 : -1
    let nx = 0
    let ny = 0
    while (nx < dx || ny < dy) {
      const d = (0.5 + nx) / dx - (0.5 + ny) / dy
      if (d === 0) {
        if (!usable[y * cols + x + sx] || !usable[(y + sy) * cols + x]) return false
        x += sx
        y += sy
        nx++
        ny++
      } else if (d < 0) {
        x += sx
        nx++
      } else {
        y += sy
        ny++
      }
      if (!usable[y * cols + x]) return false
    }
    return true
  }

  // --- 16-neighbour Dijkstra
  const moves: [number, number][] = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      if ((dx === 0 && dy === 0) || (Math.abs(dx) === 2 && Math.abs(dy) !== 1) || (Math.abs(dy) === 2 && Math.abs(dx) !== 1)) continue
      moves.push([dx, dy])
    }
  }
  const distTo = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const heapK: number[] = []
  const heapV: number[] = []
  const push = (k: number, v: number) => {
    let i = heapK.length
    heapK.push(k)
    heapV.push(v)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heapK[p] <= k) break
      heapK[i] = heapK[p]
      heapV[i] = heapV[p]
      i = p
    }
    heapK[i] = k
    heapV[i] = v
  }
  const pop = (): number => {
    const top = heapV[0]
    const k = heapK.pop() as number
    const v = heapV.pop() as number
    if (heapK.length > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= heapK.length) break
        const r = l + 1
        const m = r < heapK.length && heapK[r] < heapK[l] ? r : l
        if (heapK[m] >= k) break
        heapK[i] = heapK[m]
        heapV[i] = heapV[m]
        i = m
      }
      heapK[i] = k
      heapV[i] = v
    }
    return top
  }
  distTo[si] = 0
  push(0, si)
  const done = new Uint8Array(n)
  while (heapK.length > 0) {
    const cur = pop()
    if (done[cur]) continue
    done[cur] = 1
    if (cur === gi) break
    const c = cur % cols
    const r = (cur - c) / cols
    for (const [dx, dy] of moves) {
      const nc = c + dx
      const nr = r + dy
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue
      const ni = nr * cols + nc
      if (done[ni] || !usable[ni] || !sees(cur, ni)) continue
      const d = distTo[cur] + Math.hypot(dx, dy) * cell
      if (d < distTo[ni]) {
        distTo[ni] = d
        prev[ni] = cur
        push(d, ni)
      }
    }
  }
  if (!Number.isFinite(distTo[gi])) return null
  const cells: number[] = []
  for (let i = gi; i !== -1; i = prev[i]) cells.push(i)
  cells.reverse()

  // --- string-pull
  const pulled = [cells[0]]
  let anchor = 0
  while (anchor < cells.length - 1) {
    let best = anchor + 1
    for (let j = cells.length - 1; j > anchor + 1; j--) {
      if (sees(cells[anchor], cells[j])) {
        best = j
        break
      }
    }
    pulled.push(cells[best])
    anchor = best
  }
  const xy = pulled.map((i) => {
    const c = i % cols
    const r = (i - c) / cols
    return [(c + 0.5) * cell, (r + 0.5) * cell] as const
  })
  // The exact ends stand in for their cells' centres.
  const pts = [[fx, fy] as const, ...xy.slice(1, -1), [tx, ty] as const]
  let lengthM = 0
  for (let k = 1; k < pts.length; k++) lengthM += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
  return {
    lengthM,
    path: pts.map(([x, y]) => ({ lat: lat0 + y / mLat, lon: lon0 + x / mLon })),
  }
}

/** The chart's state at a point, independently: finest chart wins, land over depth; NaN unsurveyed, −∞ land. */
export function stateAtPoint(f: ChartFeatures, p: LatLon): number {
  const inRings = (rings: Ring[]) => {
    let inside = false
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > p.lat !== yj > p.lat && p.lon < xi + ((p.lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside
      }
    }
    return inside
  }
  let level = -Infinity
  let land = false
  let depth = Infinity
  for (const a of f.depthAreas) {
    if (!Number.isFinite(a.minDepthM) || !inRings(a.rings)) continue
    const l = a.level ?? 0
    if (l > level) {
      level = l
      land = false
      depth = a.minDepthM
    } else if (l === level) depth = Math.min(depth, a.minDepthM)
  }
  for (const a of f.land) {
    if (a.hazard || !inRings(a.rings)) continue
    const l = a.level ?? 0
    if (l > level) {
      level = l
      land = true
    } else if (l === level) land = true
  }
  if (level === -Infinity) return NaN
  return land ? LAND : depth
}
