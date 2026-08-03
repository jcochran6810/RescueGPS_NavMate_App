/**
 * Generates the PWA icon PNGs from the same geometry as public/icon.svg.
 *
 * Written by hand rather than pulling in a rasteriser: the icon is a handful of
 * circles and a triangle, and this keeps the toolchain free of a native
 * image dependency. Run with `node scripts/make-icons.mjs`.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const SS = 4 // supersampling factor, for antialiasing

const NAVY = [0x0b, 0x1f, 0x33]
const RING = [0x1b, 0x3a, 0x56]
const SKY = [0x38, 0xbd, 0xf8]

// --- geometry helpers, all in the SVG's 512-unit space -------------------

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy)

/** Signed coverage test for a rounded rectangle. */
function inRoundedRect(x, y, w, h, r) {
  const dx = Math.max(r - x, 0, x - (w - r))
  const dy = Math.max(r - y, 0, y - (h - r))
  if (dx === 0 || dy === 0) return x >= 0 && x <= w && y >= 0 && y <= h
  return Math.hypot(dx, dy) <= r
}

const inRing = (x, y, cx, cy, radius, width) =>
  Math.abs(dist(x, y, cx, cy) - radius) <= width / 2

/** Distance from point to segment, for stroked ticks with round caps. */
function inThickSegment(x, y, x1, y1, x2, y2, width) {
  const vx = x2 - x1
  const vy = y2 - y1
  const len2 = vx * vx + vy * vy
  let t = len2 === 0 ? 0 : ((x - x1) * vx + (y - y1) * vy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)) <= width / 2
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  if (s < 0 !== t < 0 && s !== 0 && t !== 0) return false
  const d = (cx - bx) * (py - by) - (cy - by) * (px - bx)
  return d === 0 || d < 0 === s + t <= 0
}

/** Colour at a point in 512-space, or null for transparent. */
function sample(x, y) {
  if (!inRoundedRect(x, y, 512, 512, 112)) return null

  // Needle: arrow from the top, notched at the bottom.
  if (inTriangle(x, y, 256, 138, 322, 322, 256, 286)) return SKY
  if (inTriangle(x, y, 256, 138, 256, 286, 190, 322)) return SKY

  if (dist(x, y, 256, 256) <= 14) return NAVY

  if (inRing(x, y, 256, 256, 150, 16)) return RING
  if (inRing(x, y, 256, 256, 96, 10)) return RING

  const ticks = [
    [256, 92, 256, 132],
    [256, 380, 256, 420],
    [92, 256, 132, 256],
    [380, 256, 420, 256],
  ]
  for (const [x1, y1, x2, y2] of ticks) {
    if (inThickSegment(x, y, x1, y1, x2, y2, 16)) return SKY
  }

  return NAVY
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4)
  const scale = 512 / size

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale
          const y = (py + (sy + 0.5) / SS) * scale
          const c = sample(x, y)
          if (c) {
            r += c[0]
            g += c[1]
            b += c[2]
            a += 255
          }
        }
      }
      const n = SS * SS
      const i = (py * size + px) * 4
      // Un-premultiply so edge pixels keep their colour as alpha falls off.
      const cov = a / (255 * n)
      buf[i] = cov > 0 ? Math.round(r / (n * cov)) : 0
      buf[i + 1] = cov > 0 ? Math.round(g / (n * cov)) : 0
      buf[i + 2] = cov > 0 ? Math.round(b / (n * cov)) : 0
      buf[i + 3] = Math.round(a / n)
    }
  }
  return buf
}

// --- minimal PNG encoder -------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  // 10..12: compression, filter, interlace — all zero

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
for (const size of [192, 512]) {
  const file = join(OUT, `icon-${size}.png`)
  writeFileSync(file, encodePNG(render(size), size))
  console.log('wrote', file)
}
