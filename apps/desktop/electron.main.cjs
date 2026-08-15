'use strict'

/**
 * DeepSeek Harness desktop shell (Electron main process).
 *
 * 一体式策略：本进程只负责把现有的 `dsh web` 后端作为子进程拉起来，
 * 等它在本机空闲端口就绪后，把前端（由后端同源托管）加载进 BrowserWindow。
 * 后端本身零改动 —— 桌面端只是它的一个原生窗口外壳。
 *
 * 托盘：关闭窗口改为最小化到托盘，仅通过托盘菜单「退出」才真正结束（并清理后端）。
 *
 * 后端启动命令（与 `pnpm dsh web` 完全一致）：
 *   - 若 apps/cli/lib/bin.js 已存在（pnpm build 之后）：直接 `node <built> web ...`
 *   - 否则（源码态）：`node --import tsx/esm apps/cli/src/bin.ts web ...`
 *
 * 额外能力（在「外壳 + 托盘 + 文档」地基之上扩展，未改动握手）：
 *   - 自动更新：electron-updater 接 GitHub Releases（lxlmaster/deepseek-harness）。
 *   - 可观测：后端子进程 stdout/stderr 同时落盘 app.getPath('logs')/dsh-backend.log
 *     并实时推送到渲染进程（IPC: backend-log），供「检查更新 / 日志」面板使用。
 *   - 轻量应用菜单：检查更新 / 重启后端 / 开发者工具 / 退出。
 */

const { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage } = require('electron')
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
let tray = null
let backendPort = 0
let quitInitiated = false

// ---- 后端日志：落盘 + 内存环形缓冲 + 实时推送到渲染进程 ----
let logStream = null
const backendLogBuffer = []
const LOG_BUFFER_MAX = 2000

function ensureLog() {
  if (logStream) return
  try {
    const dir = app.getPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'dsh-backend.log')
    logStream = fs.createWriteStream(file, { flags: 'a' })
    logStream.on('error', (e) => console.error('[desktop] log write error:', e.message))
  } catch (e) {
    console.error('[desktop] cannot open backend log file:', e.message)
  }
}

function pushLog(line) {
  if (logStream) logStream.write(line + '\n')
  backendLogBuffer.push(line)
  if (backendLogBuffer.length > LOG_BUFFER_MAX) backendLogBuffer.shift()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend-log', line)
  }
}

// ---- 自动更新（electron-updater，可选依赖，缺失时安全降级） ----
let autoUpdater = null
let hasUpdater = false

function setupAutoUpdater() {
  try {
    autoUpdater = require('electron-updater').autoUpdater
    hasUpdater = true
  } catch {
    console.log('[desktop] electron-updater 未安装，跳过自动更新')
    return
  }
  autoUpdater.autoDownload = false
  autoUpdater.on('update-available', (info) =>
    sendUpdateStatus({ status: 'available', version: info && info.version }),
  )
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ status: 'not-available' }))
  autoUpdater.on('download-progress', (p) =>
    sendUpdateStatus({ status: 'downloading', percent: p && p.percent }),
  )
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus({ status: 'downloaded', version: info && info.version })
    showUpdateReady(info && info.version)
  })
  autoUpdater.on('error', (e) =>
    sendUpdateStatus({ status: 'error', message: (e && e.message) || String(e) }),
  )
}

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', payload)
  }
}

function checkForUpdates() {
  if (!hasUpdater) {
    sendUpdateStatus({ status: 'error', message: 'electron-updater 未安装' })
    return
  }
  autoUpdater
    .checkForUpdates()
    .catch((e) => sendUpdateStatus({ status: 'error', message: (e && e.message) || String(e) }))
}

function showUpdateReady(version) {
  if (!tray) return
  tray.setToolTip(`DeepSeek Harness · 更新已就绪${version ? ' (v' + version + ')' : ''}，点击退出并安装`)
}

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
  ensureLog()
  const { cmd, args } = backendLaunch(port)
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, DSH_DESKTOP: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tag = (buf) => {
    const text = buf.toString().replace(/\r?\n$/, '')
    text.split('\n').forEach((line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      console.log('[dsh]', trimmed)
      pushLog(trimmed)
    })
  }
  child.stdout?.on('data', tag)
  child.stderr?.on('data', tag)
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
  // 关闭窗口 → 最小化到托盘（仅托盘「退出」才会真正结束）。
  win.on('close', (e) => {
    if (!quitInitiated && process.platform !== 'darwin') {
      e.preventDefault()
      win.hide()
      return
    }
  })
  win.on('closed', () => {
    mainWindow = null
  })
  win.once('ready-to-show', () => win.show())
  // 让前端里 window.open / 外链落到系统浏览器，而不是新开 Electron 窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

function showErrorPage(msg) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const safe = String(msg).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
  mainWindow.loadURL(
    `data:text/html,<html><body style="font-family:system-ui;color:#ddd;background:#0b0e14;padding:2rem"><h1>DeepSeek Harness 后端启动失败</h1><p>请确认已执行 <code>pnpm install</code> 并构建前端（<code>pnpm --filter @deepseek-ai/dsh-web-frontend run build</code>）。</p><pre>${safe}</pre></body></html>`,
  )
}

async function boot() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  backendPort = await getFreePort()
  backend = startBackend(backendPort)
  try {
    await waitForBackend(backendPort)
  } catch (err) {
    console.error('[desktop] backend failed to start:', err)
    showErrorPage(String(err))
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(`http://127.0.0.1:${backendPort}/`)
  }
}

/** 重启后端（供托盘菜单与 IPC 复用）。 */
async function restartBackend() {
  shutdownBackend()
  quitInitiated = false
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL('data:text/html,<h1 style="color:#ddd;font-family:system-ui">正在重启后端…</h1>')
  }
  await boot()
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

/** 托盘：图标 + 点击显隐 + 右键菜单（显示 / 重启后端 / 检查更新 / 退出）。 */
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png')
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    // 兜底：内联一个 1x1 蓝色像素，避免 Windows 下 new Tray 抛错。
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC',
    )
  }
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isVisible()) mainWindow.hide()
    else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  const menu = Menu.buildFromTemplate([
    {
      label: '显示',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { label: '重启后端', click: () => restartBackend().catch((e) => console.error(e)) },
    { label: '检查更新…', click: () => checkForUpdates() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitInitiated = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

/** 轻量应用菜单（Windows 下显示在窗口标题栏上方）。 */
function createAppMenu() {
  const template = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        { label: '检查更新…', click: () => checkForUpdates() },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { label: '重启后端', click: () => restartBackend().catch((e) => console.error(e)) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

ipcMain.on('desktop:restart-backend', () => {
  restartBackend().catch((e) => console.error(e))
})

ipcMain.handle('desktop:check-for-updates', () => {
  checkForUpdates()
  return { ok: true }
})

ipcMain.handle('desktop:quit-and-install', () => {
  if (hasUpdater) autoUpdater.quitAndInstall()
  return { ok: hasUpdater }
})

ipcMain.handle('desktop:get-backend-logs', () => backendLogBuffer.join('\n'))

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  mainWindow = createWindow()
  createTray()
  createAppMenu()
  setupAutoUpdater()
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  await boot()
})

app.on('window-all-closed', () => {
  // 桌面端：最小化到托盘后不会触发此处；真正的退出走托盘「退出」/ 单实例退出 / 菜单退出。
  if (process.platform === 'darwin') {
    shutdownBackend()
    app.quit()
  }
})

// before-quit 必须置 quitInitiated，否则 close 处理器会拦截窗口关闭导致 app 永不退出
// （菜单「退出」、二次实例退出都依赖此路径）。
app.on('before-quit', () => {
  quitInitiated = true
  shutdownBackend()
})
app.on('quit', shutdownBackend)
