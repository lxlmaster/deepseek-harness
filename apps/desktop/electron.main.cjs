'use strict'

/**
 * DeepSeek Harness desktop shell (Electron main process).
 *
 * 一体式策略：本进程只负责把现有的 `dsh web` 后端作为子进程拉起来，
 * 等它在本机空闲端口就绪后，把前端（由后端同源托管）加载进 BrowserWindow。
 * 后端本身零改动 —— 桌面端只是它的一个原生窗口外壳。
 *
 * 后端启动命令（与 `pnpm dsh web` 完全一致）：
 *   - 若 apps/cli/lib/bin.js 已存在（pnpm build 之后）：直接 `node <built> web ...`
 *   - 否则（源码态）：`node --import tsx/esm apps/cli/src/bin.ts web ...`
 */

const { app, BrowserWindow, shell, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

const isDev = !app.isPackaged

// 仓库根：开发态下 electron.main.cjs 位于 apps/desktop，上溯三级即根；
// 打包态下 harness 应随 extraResources 落到 resources/harness。
const repoRoot =
  process.env.DSH_REPO_ROOT ||
  (isDev
    ? path.resolve(__dirname, '..', '..', '..')
    : path.join(process.resourcesPath, 'harness'))

let backend = null
let mainWindow = null
let backendPort = 0
let quitInitiated = false

/** 找一个本机 127.0.0.1 上的空闲端口，避免和已运行的 `dsh web`(默认 3080) 冲突。 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 根据仓库状态决定后端启动方式（构建态 vs 源码态）。 */
function backendLaunch(port) {
  const builtBin = path.join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
  const srcBin = path.join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')
  const node = process.env.DSH_NODE || 'node'
  if (fs.existsSync(builtBin)) {
    return { cmd: node, args: [builtBin, 'web', '--host', '127.0.0.1', '--port', String(port)] }
  }
  return {
    cmd: node,
    args: ['--import', 'tsx/esm', srcBin, 'web', '--host', '127.0.0.1', '--port', String(port)],
  }
}

function startBackend(port) {
  const { cmd, args } = backendLaunch(port)
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, DSH_DESKTOP: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => console.log('[dsh]', d.toString().trim()))
  child.stderr?.on('data', (d) => console.error('[dsh]', d.toString().trim()))
  child.on('exit', (code, signal) => {
    console.log(`[dsh] backend exited code=${code} signal=${signal}`)
    backend = null
    if (!quitInitiated && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-crash', { code, signal })
    }
  })
  return child
}

/** 轮询后端直到返回非 5xx 响应，或超时。 */
function waitForBackend(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 1500 },
        (res) => {
          res.resume()
          if (res.statusCode && res.statusCode < 500) return resolve(true)
          retry()
        },
      )
      req.on('error', retry)
      req.on('timeout', () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('后端启动超时（60s）'))
      setTimeout(probe, 500)
    }
    probe()
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  // 让前端里 window.open / 外链落到系统浏览器，而不是新开 Electron 窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

async function boot() {
  backendPort = await getFreePort()
  backend = startBackend(backendPort)
  try {
    await waitForBackend(backendPort)
  } catch (err) {
    console.error('[desktop] backend failed to start:', err)
    if (mainWindow && !mainWindow.isDestroyed()) {
      const msg = String(err).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
      await mainWindow.loadURL(
        `data:text/html,<html><body style="font-family:system-ui;color:#ddd;background:#0b0e14;padding:2rem"><h1>DeepSeek Harness 后端启动失败</h1><p>请确认已执行 <code>pnpm install</code> 并构建前端（<code>pnpm --filter @deepseek-ai/dsh-web-frontend run build</code>）。</p><pre>${msg}</pre></body></html>`,
      )
    }
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`)
  }
}

function shutdownBackend() {
  quitInitiated = true
  if (backend) {
    try {
      backend.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
    backend = null
  }
}

ipcMain.on('desktop:restart-backend', async () => {
  shutdownBackend()
  quitInitiated = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL('data:text/html,<h1 style="color:#ddd;font-family:system-ui">正在重启后端…</h1>')
  }
  await boot()
})

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  await boot()
})

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  // 桌面端：关掉所有窗口即视为退出（含后端）。
  if (process.platform !== 'darwin') {
    shutdownBackend()
    app.quit()
  }
})

app.on('before-quit', shutdownBackend)
app.on('quit', shutdownBackend)
