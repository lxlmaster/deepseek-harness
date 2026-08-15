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

Add tray icon + auto-update by extending `electron.main.cjs` (tray via `Tray`, updater via `electron-updater`). Keep the spawn/health-check/cleanup handshake intact.
