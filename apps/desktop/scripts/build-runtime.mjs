// 组装自包含的 harness 运行时到 ./runtime，供 electron-builder 的 extraResources
// 映射到安装包的 resources/harness。打包态下 electron.main.cjs 会以
// resources/harness 作为 repoRoot，并优先用构建后的 apps/cli/lib/bin.js 启动后端。
//
// ⚠️ 必须在以下命令成功之后运行：
//     pnpm install
//     pnpm build                                  # 产出 apps/cli/lib、packages/*/lib
//     pnpm --filter @deepseek-ai/dsh-web-frontend run build   # 产出 apps/web/dist
//
// 运行： node scripts/build-runtime.mjs
//
// 该脚本只是「把已构建产物 + node_modules 物理搬运到 runtime/」的最简实现。
// 若安装包体积或原生依赖解析出问题，更稳妥的做法是改用 `pnpm deploy`
// （为 @deepseek-ai/dsh-cli 产出扁平、无符号链接的 node_modules），再叠加
// apps/web/dist 与 packages/*/lib。两种方案都需要在 Windows 桌面环境实测验证。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, '..')
const root = path.resolve(desktopDir, '..', '..')
const outDir = path.join(desktopDir, 'runtime')

function log(msg) {
  console.log(`[build-runtime] ${msg}`)
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) {
    log(`跳过（缺失）：${path.relative(root, src)}`)
    return false
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, dereference: false })
  log(`已复制：${path.relative(root, src)} → ${path.relative(root, dest)}`)
  return true
}

function copyNodeModulesDereferenced(src, dest) {
  if (!fs.existsSync(src)) {
    log(`跳过（缺失）：${path.relative(root, src)}`)
    return false
  }
  fs.mkdirSync(dest, { recursive: true })

  if (process.platform === 'win32') {
    // Windows 下用 robocopy 解引用符号链接，把真实文件拷进 runtime。
    // 默认行为就是 follow symlinks（复制目标文件），不加 /SL 即可；
    // /E 包含空目录，/COPY:DAT 复制数据+属性+时间戳，/XJ 跳过 junction 循环，
    // /R:2 /W:1 失败重试 2 次、间隔 1 秒。
    log(`开始复制 node_modules（解引用符号链接，可能较慢）...`)
    const result = spawnSync(
      'robocopy',
      [src, dest, '/E', '/COPY:DAT', '/XJ', '/R:2', '/W:1'],
      { stdio: 'pipe', windowsHide: true }
    )
    const stdout = result.stdout?.toString('utf8')?.trim() || ''
    const stderr = result.stderr?.toString('utf8')?.trim() || ''
    if (stdout) log(stdout)
    if (stderr) log(stderr)
    // robocopy 退出码 0~7 通常都算成功；8 及以上才是错误。
    if (result.status !== null && result.status >= 8) {
      throw new Error(`robocopy 复制 node_modules 失败，exit code ${result.status}`)
    }
  } else {
    // 非 Windows fallback：直接解引用复制
    fs.cpSync(src, dest, { recursive: true, dereference: true })
  }
  log(`已复制（已解引用符号链接）：${path.relative(root, src)} → ${path.relative(root, dest)}`)
  return true
}

log(`清理旧 runtime：${outDir}`)
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

// 1. 构建后的 CLI 入口
copyIfExists(path.join(root, 'apps', 'cli', 'lib'), path.join(outDir, 'apps', 'cli', 'lib'))
// 2. 前端静态资源
copyIfExists(path.join(root, 'apps', 'web', 'dist'), path.join(outDir, 'apps', 'web', 'dist'))
// 3. 各 workspace 包构建产物
const packagesDir = path.join(root, 'packages')
if (fs.existsSync(packagesDir)) {
  for (const group of fs.readdirSync(packagesDir)) {
    const groupDir = path.join(packagesDir, group)
    if (!fs.statSync(groupDir).isDirectory()) continue
    for (const pkg of fs.readdirSync(groupDir)) {
      const libDir = path.join(groupDir, pkg, 'lib')
      if (fs.existsSync(libDir)) {
        copyIfExists(libDir, path.join(outDir, 'packages', group, pkg, 'lib'))
      }
    }
  }
}
// 4. 整个 node_modules（解引用符号链接，确保打包到安装包后还能用）
copyNodeModulesDereferenced(path.join(root, 'node_modules'), path.join(outDir, 'node_modules'))
// 5. 锁文件 / workspace 配置（供后端运行期解析用）
copyIfExists(path.join(root, 'pnpm-lock.yaml'), path.join(outDir, 'pnpm-lock.yaml'))
copyIfExists(path.join(root, 'pnpm-workspace.yaml'), path.join(outDir, 'pnpm-workspace.yaml'))

// 6. 生成一个不含 workspaces 字段的 package.json（避免 Node 误判为 npm-workspaces）
const runtimePkg = {
  name: 'dsh-desktop-runtime',
  version: '0.0.0',
  private: true,
  type: 'module',
}
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify(runtimePkg, null, 2) + '\n',
)
log('已生成 runtime/package.json')

log(`运行时已组装到 ${outDir}`)
log('下一步：pnpm desktop:pack （electron-builder 会把它作为 extraResources 打包）')
