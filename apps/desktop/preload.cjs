'use strict'

/**
 * 极简 preload：只向渲染进程暴露只读的桌面环境信息，以及少量受控操作。
 * 不开启 nodeIntegration，渲染进程（dsh web 前端）仍是普通网页。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  electronVersion: process.versions.electron,
  platform: process.platform,

  // 重启后端（主进程监听 desktop:restart-backend）。
  restartBackend: () => ipcRenderer.send('desktop:restart-backend'),

  // 自动更新
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  quitAndInstall: () => ipcRenderer.invoke('desktop:quit-and-install'),
  onUpdateStatus: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('update-status', listener)
    return () => ipcRenderer.removeListener('update-status', listener)
  },

  // 后端日志可观测
  onBackendLog: (cb) => {
    const listener = (_e, line) => cb(line)
    ipcRenderer.on('backend-log', listener)
    return () => ipcRenderer.removeListener('backend-log', listener)
  },
  getBackendLogs: () => ipcRenderer.invoke('desktop:get-backend-logs'),
})
