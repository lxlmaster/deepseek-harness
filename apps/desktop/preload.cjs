'use strict'

/**
 * 极简 preload：只向渲染进程暴露只读的桌面环境信息。
 * 不开启 nodeIntegration，渲染进程（dsh web 前端）仍是普通网页。
 */
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  electronVersion: process.versions.electron,
  platform: process.platform,
  restartBackend: () => {
    // 由主进程监听，见 electron.main.cjs 的 desktop:restart-backend。
    const { ipcRenderer } = require('electron')
    ipcRenderer.send('desktop:restart-backend')
  },
})
