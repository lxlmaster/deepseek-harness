// 由 assets/tray-icon.png 生成 Windows 安装包所需的 build/icon.ico。
// 纯 Node 实现（无 imagemagick 依赖）：把 PNG 直接嵌进 ICO 容器。
// 运行：`node scripts/gen-icon-ico.mjs` → 产出 build/icon.ico
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pngPath = path.join(__dirname, '..', 'assets', 'tray-icon.png')
const outDir = path.join(__dirname, '..', 'build')
const outPath = path.join(outDir, 'icon.ico')

const png = fs.readFileSync(pngPath)

// ICONDIR
const dir = Buffer.alloc(6)
dir.writeUInt16LE(0, 0) // reserved
dir.writeUInt16LE(1, 2) // image type: icon
dir.writeUInt16LE(1, 4) // image count

// ICONDIRENTRY (16 bytes)
const entry = Buffer.alloc(16)
entry.writeUInt8(64, 0) // width  (<=255 → 实际值)
entry.writeUInt8(64, 1) // height
entry.writeUInt8(0, 2) // color count (0 = >256)
entry.writeUInt8(0, 3) // reserved
entry.writeUInt16LE(1, 4) // color planes
entry.writeUInt16LE(32, 6) // bits per pixel
entry.writeUInt32LE(png.length, 8) // bytes in this resource
entry.writeUInt32LE(6 + 16, 12) // offset to this resource (after header)

const ico = Buffer.concat([dir, entry, png])
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outPath, ico)
console.log(`wrote ${outPath} (${ico.length} bytes, embedded ${png.length}-byte PNG)`)
