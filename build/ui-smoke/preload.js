'use strict';
// UI 冒烟测试专用 preload：只给渲染层一份假的 window.api，
// 不触发任何真实 IPC（尤其不能自动 startup 把 WSL 虚拟机拉起来）。
const { contextBridge } = require('electron');

const PERSONAS = [
  { id: 'tw-taipei', name: '中国台湾 · 台北', short: '台北', tz: 'Asia/Taipei',
    lang: 'zh_TW.UTF-8', chromeLang: 'zh-TW', label: '中国台湾地区·台北的用户挂 VPN',
    desc: 'UTC+8 作息对齐中文用户。' },
  { id: 'us', name: '美国 · 洛杉矶', short: '美国', tz: 'America/Los_Angeles',
    lang: 'en_US.UTF-8', chromeLang: 'en-US', label: '美国本地用户（美西）',
    desc: 'UTC-8 美西时区 + 全英文环境。' },
];
const NODES = [
  { name: 'LAX-Cogent-Reality', type: 'vless', server: '38.150.32.117' },
  { name: 'Vultr-LAX-Reality', type: 'vless', server: '45.32.83.147' },
  { name: 'LAX-NTT-Reality', type: 'vless', server: '192.220.30.145' },
];

const ok = (extra) => Promise.resolve({ ok: true, ...(extra || {}) });
const noop = () => {};

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ok({
    _firstRun: true,              // 关键：阻止 init() 自动 doStart
    persona: 'us',
    clashYamlPath: 'C:\\sub\\clash.yaml',
    selectedNode: 'LAX-Cogent-Reality',
    workspace: 'C:\\claude-workspace',
    netGuard: 'strict',
    netGuardStrictRegion: true,
    inputMethod: 'off',
    _personas: PERSONAS,
    _nodes: NODES,
  }),
  saveConfig: () => ok(),
  start: () => ok({ ok: false, error: 'smoke' }),
  stop: () => ok(),
  reset: () => ok(),
  status: () => ok(),
  check: () => ok({ data: { runtimeUp: 1, summary: { pass: 1, fail: 1, warn: 0, info: 0 }, groups: [
    { id: 'network', title: '内核与出口', items: [{ status: 'fail', label: 'DNS 归属', value: '未接管' }] },
    { id: 'desktop', title: '浏览器与运行环境', items: [{ status: 'pass', label: '浏览器', value: '正常' }] },
  ] } }),
  netStatus: () => ok({ state: 'guarded', exit_ip: '38.150.32.117' }),
  probeWsl: () => ok(),
  pickClashYaml: () => ok({ canceled: true }),
  listNodes: () => ok({ nodes: NODES }),
  nodeLatency: () => ok({ delays: { 'LAX-Cogent-Reality': 197 } }),
  winMinimize: () => ok(),
  winMaximize: () => ok({ maximized: false }),
  winClose: () => ok(),
  winState: () => ok({ maximized: false }),
  onWinState: noop,
  openReport: () => ok(),
  exportReport: () => ok(),
  pickWorkspace: () => Promise.resolve('C:\\claude-workspace'),
  openWorkspace: () => ok(),
  exportDiag: () => ok({ canceled: true }),
  previewDiag: () => ok(),
  openLogs: () => ok(),
  onProgress: noop,
  onRuntimeExited: noop,
  readClipboard: () => Promise.resolve(''),
  writeClipboard: () => Promise.resolve(true),
});
