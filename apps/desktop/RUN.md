# DeepSeek Harness 桌面端 · 本机运行指南

Electron 一体式外壳：启动后自动拉起 `dsh web` 后端子进程，把前端加载进原生窗口；
窗口关闭改为最小化到托盘，右键托盘菜单可「显示 / 重启后端 / 退出」。

> ⚠️ 必须在**带图形桌面的 Windows** 上运行（普通笔记本/台式机即可）。
> 无头/服务器/CI 环境弹不出窗口，且 pnpm 在本无头 shell 下因 safe-delete 受限无法安装，
> 因此本指南面向你自己的本地机器。

## 前置条件

- Windows 10 / 11
- Node.js ≥ 22.19 或 ≥ 24
- pnpm ≥ 10（`corepack enable` 或 `npm i -g pnpm`）
- Git
- （实际对话需）`DEEPSEEK_API_KEY`，但**仅看界面不需要**

## 步骤

```sh
# 1. 拉取你 fork 的仓库
git clone https://github.com/lxlmaster/deepseek-harness.git
cd deepseek-harness

# 2. 安装依赖（正常桌面下回收站可用，pnpm 的 safe-delete 不会失败）
pnpm install

# 3. 构建前端（窗口要加载的 UI 静态资源）
pnpm --filter @deepseek-ai/dsh-web-frontend run build

# 4. 启动桌面端（Electron 会拉起后端并弹出窗口）
pnpm desktop
```

启动后托盘出现 DeepSeek Harness 图标，窗口加载 `http://127.0.0.1:<空闲端口>/`。
托盘右键菜单可「显示 / 重启后端 / 检查更新 / 退出」；窗口关闭改为最小化到托盘。
后端日志实时写入 `app.getPath('logs')/dsh-backend.log`，可在故障排查时查看。

## 故障排查

- **后端启动失败 / 窗口显示「后端启动失败」**
  多半是 CLI 走 tsx 源码运行时 `tsx` 模块解析不到。先全量构建再启动：

  ```sh
  pnpm build
  pnpm --filter @deepseek-ai/dsh-web-frontend run build
  pnpm desktop
  ```

- **端口冲突**
  桌面端自动选用 127.0.0.1 上的空闲端口，与已运行的 `dsh web`(默认 3080) 不冲突；
  若仍异常，确认没有其他进程占用，或退出托盘菜单「退出」后重开。

- **实际对话无响应**
  在仓库根目录放 `.env` 设置 `DEEPSEEK_API_KEY=...`，重启后端即可。

- **自动更新检查报错**
  托盘/菜单「检查更新…」依赖 `build.publish` 配置的 GitHub Releases（lxlmaster/deepseek-harness）。
  仓库尚未发布 Release、或无网络时检查会失败——属预期，不影响主功能。

## 生产安装包（可选，开箱即用）

```sh
pnpm build                                  # 全量构建：apps/cli/lib、packages/*/lib
pnpm --filter @deepseek-ai/dsh-web-frontend run build   # 前端 dist
pnpm desktop:gen:ico                        # 生成 build/icon.ico（NSIS 必需）
pnpm desktop:build:runtime                  # 组装自包含运行时 apps/desktop/runtime
pnpm desktop:pack                           # 产出 Windows NSIS 安装包到 apps/desktop/dist-electron
```

安装包会把 `runtime/` 作为 `extraResources` 打包进 `resources/harness`，双击启动即自带后端，
无需另起服务。`scripts/build-runtime.mjs` 的细节与备选方案见 `README.md` 的「生产分发说明」。

## 为什么不在当前开发环境直接跑？

当前对话里的 shell 是无头 Windows 会话：

1. **pnpm 11 的 safe-delete 用回收站 trash**，而无头会话回收站 COM 不可用 →
   任何 `pnpm install` 在创建临时目录清理阶段即失败（这是强制行为，无配置可关）。
2. **无图形显示器** → 即使装好依赖，Electron 也弹不出窗口。

这两点都只在你的本地桌面会话才不存在，因此「看效果」请按上面的步骤在本机执行。
