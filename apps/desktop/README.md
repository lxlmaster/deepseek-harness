# DeepSeek Harness 桌面端（Electron）

把现有的 `dsh web` 后端包进一个原生窗口里，双击即用——**后端零改动，真正的「一体式」**。

## 原理

`dsh web` 这个 profile 启动的就是一个本地 HTTP 服务（默认 `127.0.0.1:3080`），
由 `packages/host/webserver` 托管、`packages/host/frontend-static` 提供前端静态资源、
`packages/client/connection` 把 `/api`、`/rpc` 路由到 `apiproxy`。

桌面端做的事非常简单：

1. 主进程（Electron）起一个**空闲本机端口**（避免和已运行的 `dsh web` 抢 3080）。
2. 用子进程拉起后端：
   - 已构建（`apps/cli/lib/bin.js` 存在）→ `node apps/cli/lib/bin.js web --host 127.0.0.1 --port <端口>`
   - 源码态 → `node --import tsx/esm apps/cli/src/bin.ts web --host 127.0.0.1 --port <端口>`
3. 轮询端口直到后端就绪，把 `http://127.0.0.1:<端口>/` 加载进 `BrowserWindow`。
4. 退出时 `SIGTERM` 清理后端子进程。

> 前端 API 信任校验对 loopback 主机名（127.0.0.1 / localhost）放行任意端口，所以动态端口不会触发信任拦截。

## 前置条件

- Node.js `^22.19 || >=24`（仓库 `package.json` 的 engines 要求）
- pnpm `11.7.0`
- 仓库依赖已装：`pnpm install`
- 前端已构建（否则页面会 404，但 API 可用）：
  ```sh
  pnpm --filter @deepseek-ai/dsh-web-frontend run build
  # 或一次性构建全部：pnpm build
  ```

## 开发运行

```sh
# 仓库根目录
pnpm desktop
# 等价于：
pnpm --filter @deepseek-ai/dsh-desktop run dev
```

首次会下载 Electron 二进制（需联网）。启动后自动拉起后端并打开窗口。

## 打包成 Windows 安装包

```sh
pnpm desktop:gen:ico       # 由 assets/tray-icon.png 生成 build/icon.ico（NSIS 必需）
pnpm desktop:build:runtime # 组装自包含运行时到 apps/desktop/runtime（见下）
pnpm desktop:pack          # NSIS 安装包（dist-electron/*.exe）
pnpm desktop:pack:dir      # 未打包目录（dist-electron/win-unpacked，更快的冒烟测试）
```

`electron-builder` 配置见本目录 `package.json` 的 `build` 字段：
- `appId`: `ai.deepseek.harness.desktop`
- Windows 目标：`nsis`（非一键安装，可选安装目录）
- **需要 `build/icon.ico`**——`pnpm desktop:gen:ico` 一键生成（纯 Node、无 imagemagick 依赖）。
- **自动更新**：`build.publish` 已指向 GitHub Releases（`lxlmaster/deepseek-harness`），由 `electron-updater` 在运行时检查更新。

### 生产分发说明（开箱即用）

安装包要"双击启动即含后端"，需把已构建的 harness 运行时打进 `extraResources`。
本目录 `package.json` 的 `build.extraResources` 已配置把 `runtime/` 映射到安装包的 `resources/harness`，
而 `electron.main.cjs` 在打包态下正是以 `process.resourcesPath/harness` 作为 `repoRoot` 启动后端。

完整流程（在你**带显示器的本地 Windows** 上执行）：

```sh
pnpm install
pnpm build                                  # 产出 apps/cli/lib、packages/*/lib
pnpm --filter @deepseek-ai/dsh-web-frontend run build   # 产出 apps/web/dist
pnpm desktop:gen:ico                        # build/icon.ico
pnpm desktop:build:runtime                  # 组装 apps/desktop/runtime（含 node_modules + 构建产物）
pnpm desktop:pack                           # NSIS 安装包
```

`scripts/build-runtime.mjs` 会把 `apps/cli/lib`、`apps/web/dist`、`packages/*/lib`、`node_modules`
（保留 pnpm 符号链接）、锁文件搬运到 `apps/desktop/runtime/`。若安装包体积或原生依赖解析出问题，
更稳妥的方案是改用 `pnpm deploy`（为 `@deepseek-ai/dsh-cli` 产出扁平、无符号链接的 `node_modules`）
再叠加 `apps/web/dist` 与 `packages/*/lib`——两种方案都需在 Windows 桌面实测验证。

打包态下后端启动优先用 `apps/cli/lib/bin.js`；`DSH_NODE` 可指向随包内置的 Node 或系统 Node。

### 自动更新

托盘右键菜单「检查更新…」或应用菜单「检查更新…」会调用 `electron-updater.checkForUpdates()`，
命中新版本后提示"下载完成、退出并安装"。更新源为 `build.publish` 配置的 GitHub Releases，
即 `lxlmaster/deepseek-harness` 的 Release（按 `appId` + `version` 匹配）。

### 后端日志与可观测

后端子进程（`dsh web`）的 stdout/stderr 会：
- 实时写入 `app.getPath('logs')/dsh-backend.log`；
- 通过 IPC（`backend-log`）实时推送到渲染进程；
- 历史可通过 `desktop:get-backend-logs` 拉取。

`preload.cjs` 已暴露 `window.dshDesktop.onBackendLog(cb)` 与 `getBackendLogs()`，便于前端做日志面板。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_REPO_ROOT` | 强制指定 harness 仓库根（开发态默认上溯三级；打包态默认 `resources/harness`）。 |
| `DSH_NODE` | 指定启动后端用的 `node` 可执行文件路径（默认 `node`，取自 PATH）。 |
| `DSH_DESKTOP` | 后端被桌面端拉起时置为 `1`，供后端做环境判断。 |
