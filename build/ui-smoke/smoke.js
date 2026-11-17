'use strict';
// 2.1 主界面冒烟：用真实 index.html + renderer.js + styles.css，
// 但换成 mock preload，不连主进程、不启动 VM、不弹可见窗口。
// 抓运行时异常，并验证顶栏 / 单行状态信息栏 / 画像 / 节点 / 设置弹窗 / tab 切换。
// 坑 26：宿主不得再出现假任务栏（dock / 窗口标签 / 时钟），那是 VM 里 tint2 的活。
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const errors = [];

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, frame: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 3) errors.push('console.error: ' + msg);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    errors.push(`load failed ${code}: ${desc}`);
  });
  win.webContents.on('render-process-gone', () => errors.push('renderer gone'));
  win.webContents.on('page-title-updated', (e) => e.preventDefault());

  try {
    await win.loadFile(path.join(ROOT, 'claude-desktop/app/renderer/index.html'));
  } catch (e) {
    errors.push('loadFile threw: ' + e.message);
  }
  await new Promise((r) => setTimeout(r, 1200)); // 等 init() 的异步 getConfig 完成

  const probe = async (expr) => {
    try { return await win.webContents.executeJavaScript(expr); }
    catch (e) { errors.push('executeJavaScript: ' + e.message); return null; }
  };

  const base = await probe(`(() => ({
    badge: document.getElementById('runBadgeText').textContent,
    personas: document.querySelectorAll('.persona-card').length,
    activePersona: (document.querySelector('.persona-card.active .pc-name') || {}).textContent,
    nodes: document.getElementById('selectedNode').options.length,
    tabs: document.querySelectorAll('#settingsNav [data-tab]').length,
    panels: document.querySelectorAll('.tab-panel').length,
    region: document.getElementById('sbPersona').textContent.trim(),
    guard: document.getElementById('sbGuard').textContent.trim(),
    info: document.getElementById('sbItems').textContent.trim(),
    statusRows: document.querySelectorAll('.sb-row').length,
    statusbarHeight: getComputedStyle(document.querySelector('.statusbar')).height,
    fakeTaskbar: Boolean(document.querySelector('.dock, .sb-window, .sb-clock, #sbTime, #sbWindow, [data-launch]')),
    iconLoaded: (() => { const i = document.querySelector('.tb-logo img'); return !!i && i.complete && i.naturalWidth > 0; })(),
    settingsHidden: document.getElementById('settingsOverlay').hidden,
    frameBg: getComputedStyle(document.querySelector('.topbar')).backgroundColor,
  }))()`);

  if (base) {
    if (base.fakeTaskbar) errors.push('宿主又出现了假任务栏元素（dock / 窗口标签 / 时钟）');
    if (base.statusRows !== 1) errors.push(`宿主状态信息栏应为单行，实际 ${base.statusRows} 行`);
    if (base.statusbarHeight !== '30px') errors.push(`状态栏高度应为 30px，实际 ${base.statusbarHeight}`);
    if (!base.iconLoaded) errors.push('顶栏 App Icon (assets/app-icon.svg) 未能加载');
  }

  // 打开设置 → 切到「工作区与输入」→ 点保存关闭
  await probe(`document.getElementById('navSettings').click(); true`);
  const opened = await probe(`(() => ({
    hidden: document.getElementById('settingsOverlay').hidden,
    activeTab: (document.querySelector('#settingsNav .active') || {}).textContent,
  }))()`);
  await probe(`document.querySelector('#settingsNav [data-tab="workspace"]').click(); true`);
  const switched = await probe(`(() => ({
    activeTab: (document.querySelector('#settingsNav .active') || {}).textContent,
    activePanel: (document.querySelector('.tab-panel.active') || {}).dataset.panel,
  }))()`);
  await probe(`document.querySelector('#settingsNav [data-tab="network"]').click(); document.getElementById('cpRerun').click(); true`);
  await new Promise((r) => setTimeout(r, 200));
  const network = await probe(`(() => ({text: document.getElementById('cpBody').textContent, verdict: document.getElementById('cpVerdict').textContent}))()`);
  if (!network || !network.text.includes('DNS 归属') || network.text.includes('浏览器') || !network.verdict.includes('失败')) errors.push('网络检查没有显示网络风险或混入了其他分类');
  await probe(`window.dispatchEvent(new Event('network-check-stale')); true`);
  if (!(await probe(`document.getElementById('cpVerdict').textContent.includes('失效') && document.getElementById('cpExport').disabled`))) errors.push('连接变化后旧检查结果未失效');
  await probe(`document.querySelector('[data-close="settingsOverlay"]').click(); true`);
  const closed = await probe(`document.getElementById('settingsOverlay').hidden`);

  console.log(JSON.stringify({ errors, base, opened, switched, closedAfterSave: closed }, null, 2));
  app.exit(errors.length ? 1 : 0);
}).catch((e) => {
  console.error('smoke crashed:', e && e.stack || e);
  app.exit(2);
});
