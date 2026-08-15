// 无头后端握手冒烟测试：复刻 electron.main.cjs 的 startBackend 逻辑
// （spawn `dsh web` 子进程 → 轮询动态端口就绪），但不创建 BrowserWindow，
// 专门供 Docker / CI 等无 GUI 环境验证「后端能起来、端口握手成立」。
//
// 运行： node apps/desktop/scripts/smoke-backend.mjs
// 前置： pnpm install && pnpm build && pnpm --filter @deepseek-ai/dsh-web-frontend run build
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

// 只要服务在监听（fetch 不抛网络错误，不论 HTTP 状态码），即视为就绪。
function waitForListen(url, timeoutMs) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        await fetch(url)
        return resolve(true) // 服务已监听
      } catch {
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for backend'))
        setTimeout(tick, 500)
      }
    }
    tick()
  })
}

async function main() {
  const port = await findFreePort()
  const binByLib = path.join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
  let cmd
  let args
  if (fs.existsSync(binByLib)) {
    cmd = process.execPath
    args = [binByLib, 'web', '--host', '127.0.0.1', '--port', String(port)]
  } else {
    cmd = process.execPath
    args = [
      '--import', 'tsx/esm',
      path.join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'),
      'web', '--host', '127.0.0.1', '--port', String(port),
    ]
  }

  console.log(`[smoke] repoRoot=${repoRoot}`)
  console.log(`[smoke] spawning: ${cmd} ${args.join(' ')}`)
  const child = spawn(cmd, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.stdout.write(`[dsh] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[dsh-err] ${d}`))

  let ok = false
  try {
    await waitForListen(`http://127.0.0.1:${port}/`, 60000)
    console.log(`[smoke] BACKEND OK — listening on http://127.0.0.1:${port}/`)
    ok = true
  } catch (e) {
    console.error(`[smoke] BACKEND FAILED: ${e.message}`)
  } finally {
    child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(ok ? 0 : 1), 800)
}

main()
