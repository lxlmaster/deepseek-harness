// Generates a minimal valid 64x64 RGBA PNG tray icon (solid rounded-ish square).
// Run once: `node scripts/gen-icon.mjs`. Output: assets/tray-icon.png
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(__dirname, '..', 'assets', 'tray-icon.png')
fs.mkdirSync(path.dirname(out), { recursive: true })

const W = 64
const H = 64
const R = 14 // corner radius for a rounded square look

function inRoundRect(x, y) {
  if (x >= R && x < W - R) return true
  if (y >= R && y < H - R) return true
  const cx = x < R ? R : W - R - 1
  const cy = y < R ? R : H - R - 1
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R
}

const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) {
  const row = y * (W * 4 + 1)
  raw[row] = 0 // filter type: none
  for (let x = 0; x < W; x++) {
    const p = row + 1 + x * 4
    if (inRoundRect(x, y)) {
      raw[p] = 0x2b; raw[p + 1] = 0x6c; raw[p + 2] = 0xff; raw[p + 3] = 0xff // #2b6cff
    } else {
      raw[p] = 0; raw[p + 1] = 0; raw[p + 2] = 0; raw[p + 3] = 0 // transparent
    }
  }
}

// CRC32
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const idat = zlib.deflateSync(raw, { level: 9 })

const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
fs.writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes, ${W}x${H})`)
