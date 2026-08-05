/**
 * Generates the app icons from brand/icon-master.png.
 *
 * The master is the RescueGPS emblem — the Maltese cross with the boat and the
 * position pin — cropped tight and squared on the brand navy. Every icon the
 * app ships is derived from it here rather than exported by hand, so there is
 * one file to replace when the artwork changes and no chance of the sizes
 * drifting apart.
 *
 * Written without an image library on purpose: this runs in the Vercel build,
 * and a native dependency there is a whole class of deployment failure for
 * something that is, in the end, a decode, a box filter and an encode. Run with
 * `node scripts/make-icons.mjs`.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'public')
// The master lives outside public/ deliberately: it is a build input, and
// anything under public/ is published and precached by the service worker.
const MASTER = join(ROOT, 'brand', 'icon-master.png')

/** The navy the logo sits on, sampled from the artwork. */
const NAVY = [0x00, 0x0d, 0x70]

/**
 * What the emblem should span, as a fraction of the tile.
 *
 * `any` leaves a hair of margin so the cross does not appear to be cut off by
 * a rounded launcher tile. `maskable` has to survive being cropped to a circle
 * of 80% diameter, so it sits well inside that — Android crops maskable icons
 * to whatever shape the launcher likes, and an emblem drawn to the edge would
 * lose the tips of its arms.
 */
const INSET = { any: 0.96, maskable: 0.72 }

// --- PNG decoding ---------------------------------------------------------

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Undo one scanline's filter, in place. `bpp` is bytes per pixel. */
function unfilter(type, line, previous, bpp) {
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0
    const b = previous ? previous[i] : 0
    const c = previous && i >= bpp ? previous[i - bpp] : 0
    switch (type) {
      case 0:
        break
      case 1:
        line[i] = (line[i] + a) & 0xff
        break
      case 2:
        line[i] = (line[i] + b) & 0xff
        break
      case 3:
        line[i] = (line[i] + ((a + b) >> 1)) & 0xff
        break
      case 4:
        line[i] = (line[i] + paeth(a, b, c)) & 0xff
        break
      default:
        throw new Error(`unknown PNG filter ${type}`)
    }
  }
}

/** Read an 8-bit RGB or RGBA PNG into { width, height, rgba }. */
function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')

  let width = 0
  let height = 0
  let channels = 0
  const idat = []

  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at)
    const type = buf.subarray(at + 4, at + 8).toString('ascii')
    const data = buf.subarray(at + 8, at + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colour = data[9]
      if (depth !== 8) throw new Error(`expected 8-bit, got ${depth}`)
      if (colour !== 2 && colour !== 6) {
        throw new Error(`expected RGB or RGBA, got colour type ${colour}`)
      }
      if (data[12] !== 0) throw new Error('interlaced PNG not supported')
      channels = colour === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let previous = null

  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1)
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride))
    unfilter(raw[start], line, previous, channels)
    previous = line
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      rgba[d] = line[s]
      rgba[d + 1] = line[s + 1]
      rgba[d + 2] = line[s + 2]
      rgba[d + 3] = channels === 4 ? line[s + 3] : 0xff
    }
  }

  return { width, height, rgba }
}

// --- resampling and compositing ------------------------------------------

/**
 * Box-filter resize. Averaging every source pixel that falls inside a
 * destination pixel is what keeps the thin silver outline on the cross from
 * breaking up when the emblem is taken down to 192 px — a nearest-neighbour
 * sample drops whole stretches of a one-pixel line.
 */
function resize(src, w, h) {
  const out = Buffer.alloc(w * h * 4)
  const xScale = src.width / w
  const yScale = src.height / h

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * yScale)
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.ceil((y + 1) * yScale)))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * xScale)
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.ceil((x + 1) * xScale)))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4
          const alpha = src.rgba[i + 3] / 255
          // Weight colour by alpha so transparent pixels do not drag the hue.
          r += src.rgba[i] * alpha
          g += src.rgba[i + 1] * alpha
          b += src.rgba[i + 2] * alpha
          a += src.rgba[i + 3]
          n++
        }
      }
      const i = (y * w + x) * 4
      const weight = a / 255 || 1
      out[i] = Math.round(r / weight)
      out[i + 1] = Math.round(g / weight)
      out[i + 2] = Math.round(b / weight)
      out[i + 3] = Math.round(a / n)
    }
  }
  return { width: w, height: h, rgba: out }
}

/** Draw `src` centred on a `size`-square navy tile, scaled to `inset`. */
function tile(src, size, inset) {
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = NAVY[0]
    out[i * 4 + 1] = NAVY[1]
    out[i * 4 + 2] = NAVY[2]
    out[i * 4 + 3] = 0xff
  }

  const inner = Math.round(size * inset)
  const scaled = resize(src, inner, Math.round((inner * src.height) / src.width))
  const dx = Math.round((size - scaled.width) / 2)
  const dy = Math.round((size - scaled.height) / 2)

  for (let y = 0; y < scaled.height; y++) {
    for (let x = 0; x < scaled.width; x++) {
      const s = (y * scaled.width + x) * 4
      const alpha = scaled.rgba[s + 3] / 255
      if (alpha === 0) continue
      const d = ((dy + y) * size + dx + x) * 4
      for (let c = 0; c < 3; c++) {
        out[d + c] = Math.round(
          scaled.rgba[s + c] * alpha + out[d + c] * (1 - alpha),
        )
      }
      out[d + 3] = 0xff
    }
  }
  return { width: size, height: size, rgba: out }
}

// --- PNG encoding --------------------------------------------------------

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

function encodePNG({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  // 10..12: compression, filter, interlace — all zero

  // Filter type 4 (Paeth) on every scanline. The emblem is large flat areas
  // and soft edges from the resize, and predicting each byte from its
  // neighbours compresses that several times better than storing it raw.
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y++) {
    const line = rgba.subarray(y * stride, (y + 1) * stride)
    const at = y * (stride + 1)
    raw[at] = 4
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? line[i - 4] : 0
      const b = previous[i]
      const c = i >= 4 ? previous[i - 4] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      raw[at + 1 + i] = (line[i] - predictor) & 0xff
    }
    previous = line
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- go ------------------------------------------------------------------

const master = decodePNG(readFileSync(MASTER))
console.log(`master ${master.width}x${master.height}`)

const targets = [
  { name: 'icon-192.png', size: 192, inset: INSET.any },
  { name: 'icon-512.png', size: 512, inset: INSET.any },
  { name: 'icon-maskable-512.png', size: 512, inset: INSET.maskable },
]

for (const { name, size, inset } of targets) {
  const png = encodePNG(tile(master, size, inset))
  writeFileSync(join(PUBLIC, name), png)
  console.log(
    `wrote ${name} — ${size}px, emblem at ${Math.round(inset * 100)}%, ${png.length} bytes`,
  )
}
