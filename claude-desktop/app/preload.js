'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 主窗口与独立「环境检查报告」窗口共用这一份 preload；
// 两边都通过 window.api 调用，报告窗口只用到 check / netStatus / exportReport。
contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  start: (cfg) => ipcRenderer.invoke('runtime:start', cfg),
  stop: () => ipcRenderer.invoke('runtime:stop'),
  // 一键环境重置：销毁旧 VM 并重建（封号后换全新身份），破坏性操作由界面二次确认
  reset: (cfg) => ipcRenderer.invoke('runtime:reset', cfg),
  status: () => ipcRenderer.invoke('runtime:status'),
  check: () => ipcRenderer.invoke('runtime:check'),
  netStatus: () => ipcRenderer.invoke('net:status'),
  probeWsl: () => ipcRenderer.invoke('wsl:probe'),
  installWsl: () => ipcRenderer.invoke('wsl:install'),
  // 导入外部 Clash/Mihomo YAML，交给容器内内核；clash:nodes 用于刷新节点列表
  pickClashYaml: () => ipcRenderer.invoke('clash:pick'),
  listNodes: () => ipcRenderer.invoke('clash:nodes'),
  // 节点延迟：让客机的 mihomo 控制 API 实测，宿主只展示结果
  nodeLatency: () => ipcRenderer.invoke('nodes:latency'),
  // 自定义无边框窗口控制（顶栏按钮）
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winState: () => ipcRenderer.invoke('win:state'),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),
  // 独立检查报告窗口
  openReport: () => ipcRenderer.invoke('report:open'),
  exportReport: (html) => ipcRenderer.invoke('report:export', html),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  openWorkspace: (p) => ipcRenderer.invoke('workspace:open', p),
  exportDiag: () => ipcRenderer.invoke('diag:export'),
  previewDiag: () => ipcRenderer.invoke('diag:preview'),
  openLogs: () => ipcRenderer.invoke('diag:openLogs'),
  onProgress: (cb) => ipcRenderer.on('runtime:progress', (_e, msg) => cb(msg)),
  // 虚拟机进程自己退出了（不是用户点停止）：界面必须知道，否则会一直假装「运行中」
  onRuntimeExited: (cb) => ipcRenderer.on('runtime:exited', (_e, info) => cb(info)),
  // 剪贴板桥：主机 <-> 虚拟机（不走 noVNC 那个悬浮控制条）
  // 注意走 IPC，不要在 preload 里直接 require('electron').clipboard ——
  // sandbox 化的 preload 拿不到 clipboard，调用会静默失败。
  readClipboard: () => ipcRenderer.invoke('clip:read'),
  writeClipboard: (t) => ipcRenderer.invoke('clip:write', String(t == null ? '' : t)),
});
