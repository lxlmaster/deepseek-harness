---
name: dsh-desktop
description: Use when packaging, running, building, or distributing the DeepSeek Harness (dsh) desktop app — an Electron shell that hosts the existing `dsh web` service inside a native window. Covers the一体式 (backend+UI bundled) architecture, the child-process boot handshake, port negotiation, and electron-builder packaging. Triggers on "desktop", "Electron", "installer", "打包桌面端", "桌面应用".
---

# DeepSeek Harness Desktop (dsh-desktop)

Package the harness as a self-contained desktop app. The backend is **never rewritten** — the Electron main process spawns the existing `dsh web` service and loads it into a `BrowserWindow`.

## Read the contracts

- `apps/desktop/electron.main.cjs` — main process: port pick → spawn `dsh web` → poll readiness → load URL → SIGTERM cleanup on quit.
- `apps/desktop/preload.cjs` — minimal preload exposing read-only env info.
- `apps/desktop/package.json` — app package with electron-builder NSIS config.
- `apps/web/package.json` — the Vite frontend; must be built (`dist/`) before the desktop can serve pages.
- Root `package.json` scripts: `desktop`, `desktop:pack`, `desktop:pack:dir`.

## How `dsh web` actually works (do not reinvent it)

`dsh web` = `pnpm dsh --profile web` → boots the `web` Cordis profile:

- `packages/host/webserver` — HTTP server, default port **3080**.
- `packages/host/frontend-static` — serves `apps/web/dist`.
- `packages/client/connection` — routes `/api`, `/rpc` to the `apiproxy` provider.

The frontend API trust check **allows any port on loopback hosts** (127.0.0.1 / localhost), so a dynamic free port is safe and avoids 3080 collisions.

## Architecture: 一体式 (backend + UI bundled)

1. Main process finds a free loopback port (fallback 3080).
2. Spawns the backend: prefer built `apps/cli/lib/bin.js`; else source `node --import tsx/esm apps/cli/src/bin.ts --profile web --port <port>`.
3. Polls `http://127.0.0.1:<port>` until 200 (health-check loop with timeout).
4. Creates `BrowserWindow`, `loadURL(http://127.0.0.1:<port>)`, with `nodeIntegration:false`, `contextIsolation:true`.
5. On `app.quit` / window close → `child.kill('SIGTERM')`, force-kill after grace period.

## Build & run (development)

```sh
pnpm install                                                  # downloads Electron binary (needs network)
pnpm --filter @deepseek-ai/dsh-web-frontend run build        # build the web UI into apps/web/dist
pnpm desktop                                                 # launches Electron, spawns backend, opens window
```

## Package the installer (electron-builder)

```sh
pnpm desktop:pack        # NSIS installer (.exe) under apps/desktop/dist
pnpm desktop:pack:dir    # unpacked dir build (faster smoke test)
```

`build.files` covers only the Electron shell. For a **distributable** build, add `build.extraResources` pointing at the already-built harness runtime (`apps/cli/lib`, `node_modules`, `packages/*/lib`), and place a `build/icon.ico` (NSIS fails without it). See `apps/desktop/README.md` "生产分发说明".

## Pitfalls

- **Empty page = frontend not built.** Always build `dsh-web-frontend` first; `frontend-static` only serves existing `dist/`.
- **Port 3080 busy** → use the dynamic-port path; never hardcode 3080 in the shell.
- **Backend spawn hangs** → check `DEEPSEEK_API_KEY`/`.env` and that the CLI entry resolves (built `lib/` vs source `tsx`).
- **electron-builder needs the host arch toolchain**; cross-building NSIS requires Windows.

## Extending

- **系统托盘（已实现）**：`electron.main.cjs` 的 `createTray()` 建 `Tray`（图标 `assets/tray-icon.png`，缺失时兜底 1x1 data URL，防 Windows `new Tray` 抛错）、点击显隐、右键菜单（显示 / 重启后端 / 检查更新 / 退出）。窗口 `close` 在 win/linux 改为最小化到托盘，仅托盘「退出」或单实例才 `app.quit()` 并 `SIGTERM` 清理后端。`restartBackend()` 供 IPC 与托盘复用。重生成图标：`node apps/desktop/scripts/gen-icon.mjs`；生成 NSIS 用 `build/icon.ico`：`node apps/desktop/scripts/gen-icon-ico.mjs`（或 `pnpm desktop:gen:ico`）。
- **轻量应用菜单（已实现）**：`createAppMenu()` 设标准菜单（检查更新 / 重新加载 / 开发者工具 / 重启后端 / 退出 + 编辑/视图），Windows 显示在窗口标题栏上方。注意：`before-quit` 中必须置 `quitInitiated=true`，否则 close 处理器拦截窗口关闭导致 app 永不退出。
- **自动更新（已实现）**：`electron-updater` 已接入（`package.json` 的 `dependencies` + `build.publish` 指向 `lxlmaster/deepseek-harness` GitHub Releases）。`setupAutoUpdater()` 配置事件转发到渲染进程（`update-status` IPC），托盘与菜单均有「检查更新…」，`update-downloaded` 后提示退出重装。依赖缺失时安全降级（不阻断主流程）。preload 暴露 `checkForUpdates / onUpdateStatus / quitAndInstall`。
- **后端日志可观测（已实现）**：后端子进程 stdout/stderr 实时写入 `app.getPath('logs')/dsh-backend.log`，并经 `backend-log` IPC 推送到渲染进程，历史可由 `desktop:get-backend-logs` 拉取；preload 暴露 `onBackendLog / getBackendLogs`。
- **生产运行时打包（已实现脚本骨架）**：`build.extraResources` 把 `apps/desktop/runtime` 映射到安装包 `resources/harness`；`scripts/build-runtime.mjs`（或 `pnpm desktop:build:runtime`）搬运已构建的 `apps/cli/lib`、`apps/web/dist`、`packages/*/lib`、`node_modules`（保留 pnpm 符号链接）、锁文件到 `runtime/`。打包态 `repoRoot = resources/harness`。若体积/原生依赖解析出问题，备选 `pnpm deploy` 产扁平 node_modules。该步必须在 Windows 桌面实测验证。
- 改动时务必保留 spawn/health-check/cleanup 握手。
