'use strict';
// 渲染层逻辑：配置（画像 / 节点）、启动停止、内嵌 noVNC、守卫状态。
// 2.1 主界面：顶栏（自定义无边框）/ 串流舞台 / 单行宿主状态信息栏 /
// 浅色设置弹窗。检查结果仍在独立窗口（report.html），这里不渲染自检面板，
// 串流画面因此永远不会被遮罩盖住 —— 「报告不影响使用」。
//
// 任务栏属于虚拟机，不属于宿主：VM 内的 tint2 面板（/opt/config/tint2rc）
// 随 VNC 画面串流出来，启动器、窗口任务项、托盘与时钟都是真实 X11 桌面的一部分，
// 时钟走 VM 自己的 TZ（画像时区）。宿主底部这一行只展示画像 / 延迟 / 守卫 / 提示，
// 不要在这里再画 dock、窗口标签或时钟 —— 那会变成两个任务栏、两个不同的时间。
//
// 注意：2.1 的 DOM id 与 2.0 侧栏版完全不同（status/start/stop/guardBadge/
// egress/checkChip 已不存在）。所有状态统一从 `running` 布尔派生，不再靠
// 某个按钮的 disabled 属性反推运行时状态。

const $ = (id) => document.getElementById(id);
const novncUrl = (host) => `http://${host || '127.0.0.1'}:6080/desktop.html?autoconnect=1&v=2`;

let cfg = {};
let personas = [];
let nodes = [];
let nodeDelays = {};
let running = false;
let lastEgress = '';
let lastHint = '';

/** 更新带 svg 图标的元素文字，保留图标本身（不想用 innerHTML 引 XSS）。 */
function setLabel(el, text) {
  if (!el) return;
  const ico = el.querySelector('svg');
  el.textContent = '';
  if (ico) el.appendChild(ico.cloneNode(true));
  el.appendChild(document.createTextNode(text));
}

function renderSbItems() {
  $('sbItems').textContent = lastEgress || lastHint || '—';
}

function setStatus(text, kind) {
  $('runBadgeText').textContent = text;
  const badge = $('runBadge');
  badge.className = 'run-badge' + (
    kind === 'busy' ? ' busy' : kind === 'err' ? ' err' : kind === 'ok' ? '' : ' idle');
  $('advStatus').textContent = text;
  $('powerBtn').classList.toggle('running', running);
  $('powerLabel').textContent = running ? '停止' : '启动';
}

/** 提示同时落在设置弹窗底部与状态栏，弹窗关着时也看得见。 */
function setHint(msg, kind) {
  const el = $('settingsHint');
  el.textContent = msg || '';
  el.className = 'foot-hint settings-hint' + (kind ? ' ' + kind : '');
  lastHint = msg ? (msg.length > 60 ? `${msg.slice(0, 59)}…` : msg) : '';
  renderSbItems();
}

function gather() {
  return {
    persona: (cfg._persona || 'tw-taipei'),
    clashYamlPath: $('clashYamlPath').value.trim(),
    selectedNode: $('selectedNode').value,
    workspace: $('workspace').value.trim(),
    netGuard: 'strict',
    netGuardStrictRegion: $('strictRegion').checked,
    inputMethod: 'rime',
  };
}

function save() {
  cfg = { ...cfg, ...gather() };
  window.api.saveConfig(cfg).catch((error) => setHint(`设置保存失败：${error.message}`, 'err'));
  return cfg;
}

// ---------- 宿主状态信息栏：画像 / 延迟 / 守卫 ----------
function updateSbPersona() {
  const p = personas.find((x) => x.id === (cfg.persona || cfg._persona)) || personas[0];
  if (!p) return;
  const us = p.tz === 'America/Los_Angeles';
  const flag = us ? '🇺🇸' : '🇨🇳';
  setLabel($('sbPersona'), `${flag} ${p.name}`);
}

function updateLatency(ms) {
  const has = typeof ms === 'number';
  $('latencyText').textContent = has ? `${ms} ms` : '未测试';
  const el = $('sbLatency');
  setLabel(el, has ? `${ms} ms` : '— ms');
  el.className = 'sb-metric' + (has ? (ms < 200 ? ' ok' : ms < 400 ? ' warn' : ' err') : '');
}

// ---------- 伪装画像 ----------
// 两套画像由主进程 lib/personas.js 提供，这里只渲染卡片并应用派生字段。
function renderPersonas() {
  const box = $('personaCards');
  box.innerHTML = '';
  const current = cfg.persona || 'tw-taipei';
  for (const p of personas) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'persona-card' + (p.id === current ? ' active' : '');
    card.setAttribute('aria-pressed', String(p.id === current));
    card.dataset.persona = p.id;
    const name = document.createElement('div');
    name.className = 'pc-name';
    name.textContent = p.name;
    const details = document.createElement('div');
    details.className = 'pc-desc';
    details.textContent = p.id === 'us' ? '太平洋时间 · 英语' : '台北时间 · 繁体中文';
    const content = document.createElement('span');
    content.className = 'pc-main';
    content.append(name, details);
    const selected = document.createElement('span');
    selected.className = 'pc-selected';
    selected.textContent = p.id === current ? '已选择' : '选择';
    card.append(content, selected);
    card.addEventListener('click', () => {
      const chosen = personas.find((x) => x.id === p.id) || personas[0];
      // tz / lang 不落盘：由主进程按 persona 派生，存两份就会分叉
      cfg = { ...cfg, persona: chosen.id, _persona: chosen.id };
      renderPersonas();
      updateSbPersona();
      save();
      if (running) setHint('画像已改，点「停止」再「启动」生效', 'warn');
    });
    box.appendChild(card);
  }
  updateSbPersona();
}

// ---------- 节点列表 ----------
function nodeHintText() {
  const cur = $('selectedNode').value;
  let s = `共 ${nodes.length} 个节点`;
  if (Object.prototype.hasOwnProperty.call(nodeDelays, cur)) {
    const ms = nodeDelays[cur];
    if (typeof ms !== 'number') s += ' · 所选节点超时或不可达';
  }
  return s;
}

/** 经客机内核控制 API 实测每个节点延迟；内核没起时显示「未测」，不编数字。 */
async function testLatency() {
  const btn = $('testLatency');
  if (!btn || btn.disabled || !window.api.nodeLatency) return;
  if (!running) {
    $('nodeHint').textContent = '启动虚拟环境后即可测试延迟。';
    $('nodeHint').className = 'hint';
    return;
  }
  btn.disabled = true;
  const old = btn.textContent;
  setLabel(btn, '测试中…');
  $('nodeHint').textContent = '正在经容器内核实测各节点延迟…';
  try {
    const r = await window.api.nodeLatency();
    nodeDelays = (r && r.ok && r.delays) ? r.delays : {};
    if (!r || !r.ok) {
      renderNodes(nodes, $('selectedNode').value);
      $('nodeHint').textContent = `延迟测试失败：${(r && r.error) || '内核未就绪'}`;
      $('nodeHint').className = 'hint err';
      updateLatency(null);
      return;
    }
    const keep = $('selectedNode').value;
    renderNodes(nodes, keep);
    const okCount = Object.values(nodeDelays).filter((v) => typeof v === 'number').length;
    $('nodeHint').textContent = `${nodeHintText()} 已测 ${okCount}/${nodes.length} 个可达。`;
    $('nodeHint').className = 'hint';
    updateLatency(nodeDelays[keep]);
  } catch (error) {
    $('nodeHint').textContent = `延迟测试失败：${error.message || '请稍后重试'}`;
    $('nodeHint').className = 'hint err';
  } finally {
    btn.disabled = false;
    setLabel(btn, old && old.indexOf('测') >= 0 ? old : '测试延迟');
  }
}

function renderNodes(list, preferred) {
  nodes = Array.isArray(list) ? list : [];
  const sel = $('selectedNode');
  sel.innerHTML = '';
  const listEl = $('nodeList');
  $('nodeHint').className = 'hint';
  listEl.innerHTML = '';
  listEl.hidden = true;
  $('nodePicker').setAttribute('aria-expanded', 'false');
  $('nodePicker').disabled = !nodes.length;
  if (!nodes.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '（先导入 YAML）';
    sel.appendChild(o);
    sel.disabled = true;
    $('nodePickerLabel').textContent = '请先选择配置文件';
    $('nodeHint').textContent = '尚未导入节点。';
    return;
  }
  sel.disabled = false;
  for (const n of nodes) {
    const o = document.createElement('option');
    o.value = n.name;
    const bits = [n.name];
    if (n.type) bits.push(n.type);
    if (n.server) bits.push(n.server);
    o.textContent = bits.join(' · ');
    sel.appendChild(o);
  }
  const want = preferred || cfg.selectedNode || '';
  sel.value = nodes.some((n) => n.name === want) ? want : nodes[0].name;
  cfg.selectedNode = sel.value;
  $('nodePickerLabel').textContent = sel.selectedOptions[0].textContent;
  for (const n of nodes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'node-option' + (n.name === sel.value ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'node-option-name';
    name.textContent = n.name;
    const detail = document.createElement('span');
    detail.className = 'node-option-delay';
    const delay = nodeDelays[n.name];
    detail.textContent = Object.prototype.hasOwnProperty.call(nodeDelays, n.name)
      ? (typeof delay === 'number' ? `${delay} ms` : '超时') : '';
    button.append(name, detail);
    button.addEventListener('click', () => {
      sel.value = n.name;
      sel.dispatchEvent(new Event('change'));
      renderNodes(nodes, n.name);
      $('nodePicker').focus();
    });
    listEl.appendChild(button);
  }
  $('nodeHint').textContent = nodeHintText();
}

function renderYamlHint() {
  const p = $('clashYamlPath').value.trim();
  if (!p) {
    $('yamlHint').textContent = '请选择配置文件。';
    $('yamlHint').className = 'hint err';
  } else {
    $('yamlHint').textContent = '启动时读取文件的最新内容。';
    $('yamlHint').className = 'hint';
  }
}

async function refreshNodes(preferred) {
  const r = await window.api.listNodes();
  if (!r || !r.ok) {
    renderNodes([], '');
    if (r && r.error) $('nodeHint').textContent = r.error;
    return;
  }
  renderNodes(r.nodes, preferred);
}

function fill(c) {
  $('clashYamlPath').value = c.clashYamlPath || '';
  $('workspace').value = c.workspace || '';
  $('strictRegion').checked = c.netGuardStrictRegion !== false;
  personas = Array.isArray(c._personas) ? c._personas : [];
  renderPersonas();
  renderNodes(c._nodes || [], c.selectedNode);
  renderYamlHint();
  updateLatency(null);
  updateSbGuard(null);
}

// ---------- 当前出口 ----------
function showEgress(exit) {
  if (!exit || !exit.ip) { clearEgress(); return; }
  const bits = [exit.ip, exit.city, exit.country].filter(Boolean);
  lastEgress = `出口 ${bits.join(' · ')}`;
  renderSbItems();
}

function clearEgress() {
  lastEgress = '';
  renderSbItems();
}

// ---------- 网络守卫状态（状态栏 + 设置弹窗里的锁定条） ----------
function updateSbGuard(g) {
  const el = $('sbGuard');
  if (!g || !g.state) {
    setLabel(el, '网络未锁定');
    el.className = 'sb-metric';
    el.title = '尚未启动或守卫无状态';
    return;
  }
  let kind = 'warn';
  let label;
  switch (g.state) {
    case 'guarded':
      kind = 'ok';
      label = `网络已锁定${g.exit_ip ? ` · ${g.exit_ip}${g.exit_country ? '/' + g.exit_country : ''}` : ''}`;
      break;
    case 'proxy_down':
      label = '内核链路已断开 · 网络同步切断';
      break;
    case 'blocked':
      kind = 'err';
      label = `网络已切断 · ${g.reason || '预检未通过'}`;
      break;
    case 'off':
      kind = 'err';
      label = '熔断已关闭 · 存在直连风险';
      break;
    default:
      label = `网络守卫：${g.state}`;
  }
  setLabel(el, label);
  el.className = 'sb-metric ' + (kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : 'warn');
  el.title = g.message || label;
}

function showGuard(g) { updateSbGuard(g); }
function clearGuard() { updateSbGuard(null); }

// ---------- 设置弹窗 / 浮层 ----------
function openOverlay(id) { $(id).hidden = false; }
function closeOverlay(id) { $(id).hidden = true; }

function switchTab(tab) {
  if ($('settingsHint').classList.contains('ok')) setHint('', '');
  document.querySelectorAll('#settingsNav [data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.modal-content .tab-panel').forEach((p) => {
    p.classList.toggle('active', p.dataset.panel === tab);
  });
  document.querySelector('.modal-content').scrollTop = 0;
}

function openEnvironmentCheck() {
  switchTab('check');
  openOverlay('settingsOverlay');
}

function focusStage() {
  try { $('view').focus(); } catch { /* 未启动时 webview 还隐藏 */ }
}

// ---------- 诊断包 ----------
async function doExportDiag() {
  const btn = $('diag');
  btn.disabled = true;
  const old = btn.textContent;
  setLabel(btn, '正在收集…');
  try {
    const r = await window.api.exportDiag();
    if (r && r.ok) setHint('诊断包已保存：' + r.file, 'ok');
    else if (r && r.canceled) setHint('已取消导出', '');
    else setHint('导出失败：' + ((r && r.error) || '未知错误'), 'err');
  } finally {
    btn.disabled = false;
    setLabel(btn, old && old.indexOf('导出') >= 0 ? old : '导出诊断包');
  }
}

// ---------- 剪贴板 / 键盘桥接 ----------
let clipTimer = null;
let lastFromHost = '';
let lastFromGuest = '';
const normClip = (t) => String(t == null ? '' : t);

function stopClipboardBridge() {
  if (clipTimer) { clearInterval(clipTimer); clipTimer = null; }
  lastFromHost = '';
  lastFromGuest = '';
}

function startClipboardBridge() {
  stopClipboardBridge();
  const wv = $('view');
  const tick = async () => {
    if (!wv || wv.hidden) return;
    let guestText = '';
    try {
      guestText = normClip(await wv.executeJavaScript('window.__clipTaken ? window.__clipTaken() : ""'));
    } catch { return; }
    if (guestText && guestText !== lastFromGuest) {
      lastFromGuest = guestText;
      lastFromHost = guestText;
      try { window.api.writeClipboard(guestText); } catch {}
    }
    let hostText = '';
    try { hostText = normClip(await window.api.readClipboard()); } catch {}
    if (hostText && hostText !== lastFromHost) {
      lastFromHost = hostText;
      try {
        await wv.executeJavaScript(`window.__clipSet && window.__clipSet(${JSON.stringify(hostText)})`);
      } catch {}
    }
  };
  clipTimer = setInterval(tick, 250);
  tick();
}

function wireStageFocus() {
  const stage = document.querySelector('.stage');
  if (!stage || stage.dataset.wired) return;
  stage.dataset.wired = '1';
  stage.addEventListener('mousedown', () => { try { $('view').focus(); } catch {} }, true);
}

/** 启动成功后显示串流画面（唯一显示模式）。 */
function showDesktop(r, forceReload) {
  running = true;
  $('placeholder').hidden = true;
  const v = $('view');
  const already = !forceReload && r.resumed && v.getAttribute('src');
  v.hidden = false;
  if (!already) {
    v.addEventListener('dom-ready', () => { try { v.focus(); } catch {} }, { once: true });
    v.src = novncUrl(r.host);
  }
  wireStageFocus();
  startClipboardBridge();
  $('advStop').disabled = false;
  const lines = [...(r.notes || []), ...(r.warnings || [])];
  if (lines.length) setHint(lines.join('  '), (r.warnings || []).length ? 'err' : 'ok');
  showEgress(r.exit);
  showGuard(r.guard);
  setStatus((r.warnings || []).length ? '运行中（有警告）' : '运行中',
    (r.warnings || []).length ? 'err' : 'ok');
  // 内核就绪后自动测一次节点延迟，界面直接显示出来，不用用户再点按钮。
  if (window.api.nodeLatency) {
    setTimeout(() => { if (running) testLatency(); }, 2000);
  }
}

function hideDesktop() {
  running = false;
  stopClipboardBridge();
  const v = $('view');
  v.hidden = true;
  v.src = 'about:blank';
  $('placeholder').hidden = false;
  clearEgress();
  clearGuard();
  $('advStart').disabled = false;
  $('advStop').disabled = true;
  setStatus('已停止', '');
}

// ---------- 启动 / 停止 ----------
async function doStart() {
  if ($('phStart').disabled || running) return;
  $('phStart').disabled = true;
  $('powerBtn').disabled = true;
  save();
  $('advStart').disabled = true;
  setStatus('正在启动…', 'busy');
  $('phTitle').textContent = '正在启动虚拟环境';
  $('phSub').textContent = '正在准备工作区，请稍候。';
  $('phStart').textContent = '正在启动…';
  let r;
  try {
    r = await window.api.start(gather());
  } catch (error) {
    r = { ok: false, error: error.message };
  }
  $('phStart').disabled = false;
  $('powerBtn').disabled = false;
  $('phTitle').textContent = '准备好开始工作了吗？';
  $('phSub').textContent = '启动虚拟环境，进入你的 Claude 工作区。';
  $('phStart').textContent = '启动虚拟环境';
  if (r.ok) {
    showDesktop(r, false);
  } else {
    clearGuard();
    setStatus('启动失败', 'err');
    setHint(r.error || '未知错误', 'err');
    $('advStart').disabled = false;
  }
}

async function doStop() {
  setStatus('正在停止…', 'busy');
  await window.api.stop();
  hideDesktop();
  setStatus('已停止', '');
}

function togglePower() {
  if (running) doStop(); else doStart();
}

// ---------- 一键环境重置 ----------
// 破坏性操作：两段式按钮确认，第一次只改文案，10 秒内再点才执行。
let resetArmed = 0;
async function doReset() {
  const btn = $('reset');
  if (Date.now() > resetArmed) {
    resetArmed = Date.now() + 10000;
    setLabel(btn, '确认销毁并重建？再点一次');
    btn.classList.add('armed');
    setTimeout(() => {
      if (Date.now() > resetArmed) { setLabel(btn, '重置环境'); btn.classList.remove('armed'); }
    }, 10500);
    return;
  }
  resetArmed = 0;
  setLabel(btn, '正在重置…');
  btn.disabled = true;
  $('advStart').disabled = true;
  $('advStop').disabled = true;
  hideDesktop();
  setStatus('正在销毁旧环境并生成新环境…', 'busy');

  let r;
  try { r = await window.api.reset(gather()); }
  catch (e) { r = { ok: false, error: String(e && e.message || e) }; }

  btn.disabled = false;
  btn.classList.remove('armed');
  setLabel(btn, '重置环境');
  if (r && r.ok) {
    showDesktop(r, true);
    if (!(r.warnings || []).length) setStatus('新环境已就绪', 'ok');
  } else {
    setStatus('重置失败', 'err');
    setHint((r && r.error) || '未知错误', 'err');
    $('advStart').disabled = false;
  }
}

// ---------- 初始化 ----------
// 没有 preload 注入的 api 时（预览/截图用）跳过自动初始化。
if (!window.api) {
  window.__noop = true;
} else (async function init() {
  cfg = await window.api.getConfig();
  cfg._persona = cfg.persona || 'tw-taipei';
  fill(cfg);
  setStatus('未启动', '');

  // ---- 顶栏 ----
  $('powerBtn').addEventListener('click', togglePower);
  $('runBadge').addEventListener('click', togglePower);
  $('phStart').addEventListener('click', doStart);
  $('navSettings').addEventListener('click', () => openOverlay('settingsOverlay'));
  $('navWorkspace').addEventListener('click', () => {
    closeOverlay('settingsOverlay');
    focusStage();
  });

  // ---- 无边框窗口控制 ----
  $('winMin').addEventListener('click', () => window.api.winMinimize());
  $('winMax').addEventListener('click', async () => {
    const r = await window.api.winMaximize();
    $('winMax').title = (r && r.maximized) ? '还原' : '最大化 / 还原';
  });
  $('winClose').addEventListener('click', () => window.api.winClose());
  if (window.api.onWinState) {
    window.api.onWinState((s) => {
      $('winMax').title = (s && s.maximized) ? '还原' : '最大化 / 还原';
    });
  }

  // ---- 弹窗开关 / tab ----
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => closeOverlay(b.dataset.close));
  });
  for (const id of ['settingsOverlay', 'checkOverlay']) {
    $(id).addEventListener('mousedown', (e) => {
      if (e.target === $(id)) closeOverlay(id);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeOverlay('settingsOverlay');
    closeOverlay('checkOverlay');
  });
  $('settingsNav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  // 桌面快捷启动器 / 任务项 / 时钟都由 VM 内的 tint2 面板提供，宿主不代劳。
  $('sbGuard').addEventListener('click', openEnvironmentCheck);

  // ---- 表单 ----
  $('clashYamlPath').addEventListener('change', () => { save(); renderYamlHint(); refreshNodes(); });
  $('workspace').addEventListener('change', () => {
    save();
    if (running) setHint('工作区已更改，停止后重新启动生效', 'warn');
  });
  $('selectedNode').addEventListener('change', () => {
    save();
    $('nodeHint').textContent = nodeHintText();
    updateLatency(nodeDelays[$('selectedNode').value]);
    if (running) setHint('节点已改，点「停止」再「启动」生效', 'warn');
  });
  $('nodePicker').addEventListener('click', () => {
    const list = $('nodeList');
    list.hidden = !list.hidden;
    $('nodePicker').setAttribute('aria-expanded', String(!list.hidden));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.node-picker')) {
      $('nodeList').hidden = true;
      $('nodePicker').setAttribute('aria-expanded', 'false');
    }
  });
  $('nodeList').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      $('nodeList').hidden = true;
      $('nodePicker').setAttribute('aria-expanded', 'false');
      $('nodePicker').focus();
    }
  });
  $('strictRegion').addEventListener('change', () => {
    save();
    if (running) setHint('地区严格校验已改，点「停止」再「启动」生效', 'warn');
  });

  // 导入 YAML：一次拿到节点列表，直接刷新下拉并自动选中第一个。
  $('pickClash').addEventListener('click', async () => {
    const r = await window.api.pickClashYaml();
    if (!r || r.canceled) return;
    if (!r.ok) { setHint(r.error || '选择失败', 'err'); return; }
    $('clashYamlPath').value = r.path;
    cfg.clashYamlPath = r.path;
    cfg.selectedNode = '';
    renderYamlHint();
    renderNodes(r.nodes || [], '');
    save();
    const w = (r.warnings && r.warnings.length) ? `（${r.warnings.join('；')}）` : '';
    setHint(`已载入 ${(r.nodes || []).length} 个节点${w}`, 'ok');
  });
  $('refreshNodes').addEventListener('click', async () => {
    await refreshNodes();
    save();
    setHint(`节点列表已刷新（${nodes.length} 个）`, 'ok');
  });
  $('testLatency').addEventListener('click', testLatency);

  $('pick').addEventListener('click', async () => {
    const p = await window.api.pickWorkspace();
    if (p) {
      $('workspace').value = p;
      save();
      if (running) setHint('工作区已更改，停止后重新启动生效', 'warn');
    }
  });
  $('openWs').addEventListener('click', () => window.api.openWorkspace($('workspace').value));

  $('advStart').addEventListener('click', doStart);
  $('advStop').addEventListener('click', doStop);
  $('reset').addEventListener('click', doReset);
  $('settingsHint').addEventListener('click', openEnvironmentCheck);
  $('diag').addEventListener('click', doExportDiag);
  $('diagOpen').addEventListener('click', () => window.api.openLogs());

  // 守卫状态在运行中会变（内核退出又恢复、WSL 把默认路由重新加回来），每 6 秒拉一次。
  setInterval(async () => {
    if (!running || !window.api.netStatus) return;
    try {
      const g = await window.api.netStatus();
      if (g) showGuard(g);
    } catch { /* 会话正在重启，下一轮再看 */ }
  }, 6000);

  if (window.api.onRuntimeExited) {
    window.api.onRuntimeExited((info) => {
      hideDesktop();
      setStatus('虚拟环境已退出', 'err');
      setHint(`虚拟环境意外退出（code=${info && info.code}），点「启动虚拟环境」重新拉起`, 'err');
    });
  }
  window.api.onProgress((msg) => setStatus(msg, 'busy'));

  // 预检：WSL2 不可用时直接告诉用户怎么修，而不是等导入报错
  const probe = await window.api.probeWsl();
  if (!probe.ok) {
    setStatus('当前系统未启用 WSL2，无法启动环境', 'err');
    setHint(probe.error || '需要先安装 WSL2', 'err');
    $('advStart').disabled = true;
    return;
  }

})();
