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
pnpm desktop:pack        # 产出未打包目录（dist-electron/win-unpacked）
pnpm desktop:pack:dir    # 同上
pnpm desktop:pack        # NSIS 安装包（dist-electron/*.exe）
```

`electron-builder` 配置见本目录 `package.json` 的 `build` 字段：
- `appId`: `ai.deepseek.harness.desktop`
- Windows 目标：`nsis`（非一键安装，可选安装目录）
- **需要 `build/icon.ico`**——打包前请放入应用图标，否则 NSIS 步骤会报错。

### 生产分发说明

当前 `files` 只包含了 Electron 外壳（两个 `.cjs`）。真正分发时，安装包还需携带整个 harness 运行时：

1. 先构建：`pnpm build`（产出 `apps/cli/lib`、`apps/web/dist` 及各 `packages/*/lib`）。
2. 在 `build.extraResources` 里把仓库（或至少 `apps`、`packages`、`node_modules`、`pnpm-lock.yaml`）拷进 `resources/harness`。
3. 打包态下 `electron.main.cjs` 会用 `process.resourcesPath/harness` 作为 `repoRoot`，并优先用构建后的 `apps/cli/lib/bin.js` 启动后端（`DSH_NODE` 指向随包内置的 Node，或系统 Node）。

这一步依赖网络与代码签名环境，建议在 CI（见根 `package.json` 的 `check:ci:windows-*` 门禁）里完成。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_REPO_ROOT` | 强制指定 harness 仓库根（开发态默认上溯三级；打包态默认 `resources/harness`）。 |
| `DSH_NODE` | 指定启动后端用的 `node` 可执行文件路径（默认 `node`，取自 PATH）。 |
| `DSH_DESKTOP` | 后端被桌面端拉起时置为 `1`，供后端做环境判断。 |
