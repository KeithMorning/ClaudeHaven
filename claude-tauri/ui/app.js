'use strict';

const $ = (id) => document.getElementById(id);
const invoke = (name, args) => window.__TAURI__.core.invoke(name, args);
let config = { yaml_path: '', node: '', workspace: '', timezone: '', language: 'en-US' };
let checkGeneration = 0;
let sessionStarted = false;
let autoStartDone = false;
let manualStartRequested = false;
let stoppedByUser = false;
let statusGeneration = 0;
let nodeConfigIssue = '';
const configComplete = () => Boolean(!nodeConfigIssue && config.yaml_path && config.node && config.workspace);
let bootstrapState = null;
let latestRuntimePlatform = null;
let bootstrapBusy = false;
let latestHostProbe = null;
let lastBootstrapTask = null;
let lastBootstrapSequence = 0;
function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB']; let size = value; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
}
function renderBootstrap(snapshot, hostProbe = latestHostProbe) {
  if (snapshot?.task_id && snapshot.task_id === lastBootstrapTask && snapshot.sequence < lastBootstrapSequence) return;
  if (snapshot?.task_id && snapshot.task_id !== lastBootstrapTask) {
    lastBootstrapTask = snapshot.task_id;
    lastBootstrapSequence = 0;
  }
  if (snapshot?.task_id) lastBootstrapSequence = Math.max(lastBootstrapSequence, snapshot.sequence || 0);
  bootstrapState = snapshot;
  const phase = snapshot?.phase || '';
  const active = ['probing', 'downloading', 'verifying', 'awaiting_elevation', 'enabling_features', 'installing_msi', 'rechecking'].includes(phase);
  const progress = $('bootstrapProgress');
  const value = snapshot?.download;
  $('cancelBootstrap').hidden = !snapshot?.can_cancel;
  progress.hidden = !value || !active;
  progress.classList.toggle('indeterminate', Boolean(value && !value.total_bytes));
  if (value?.total_bytes) {
    const percent = Math.min(100, value.downloaded_bytes / value.total_bytes * 100);
    $('bootstrapProgressBar').style.width = `${percent}%`;
    $('bootstrapProgressText').textContent = `${formatBytes(value.downloaded_bytes)} / ${formatBytes(value.total_bytes)} · ${percent.toFixed(0)}%`;
  } else if (value) {
    $('bootstrapProgressBar').style.width = '34%';
    $('bootstrapProgressText').textContent = `${formatBytes(value.downloaded_bytes)} · 正在下载`;
  }
  $('bootstrapProgressSpeed').textContent = value?.bytes_per_second ? `${formatBytes(value.bytes_per_second)}/s` : '';
  if (snapshot?.error && ['blocked', 'failed', 'cancelled', 'reboot_required'].includes(phase)) {
    $('installNote').textContent = snapshot.error.user_message;
  }
  $('bootstrapDiagnostics').hidden = !snapshot?.error;
  $('bootstrapDiagnosticText').textContent = snapshot?.error ? JSON.stringify({
    diagnostic_id: snapshot.error.diagnostic_id,
    code: snapshot.error.code,
    phase: snapshot.error.phase,
    raw_exit_code: snapshot.error.raw_exit_code,
    hresult: snapshot.error.hresult,
    retryable: snapshot.error.retryable,
    user_message: snapshot.error.user_message,
    log_path: snapshot.error.log_path,
    windows: hostProbe ? {
      caption: hostProbe.windows_caption,
      version: hostProbe.windows_version,
      build: hostProbe.windows_build,
      architecture: hostProbe.architecture,
      hypervisor_present: hostProbe.hypervisor_present,
      virtualization_firmware_enabled: hostProbe.virtualization_firmware_enabled,
      virtual_machine_platform: hostProbe.virtual_machine_platform,
      wsl_feature: hostProbe.wsl_feature,
      wsl_cli_available: hostProbe.wsl_cli_available,
      wsl_package_installed: hostProbe.wsl_package_installed,
      wsl_version: hostProbe.wsl_version,
      claude_vm_wsl_version: hostProbe.claude_vm_wsl_version,
    } : undefined,
  }, null, 2) : '';
  $('installWsl').disabled = bootstrapBusy || active;
  $('selectWslMsi').disabled = bootstrapBusy || active || phase === 'reboot_required';
  $('installWsl').textContent = phase === 'reboot_required' ? '重启后重新检查' : snapshot?.error?.retryable ? '重试 WSL 配置' : '配置 WSL 2';
}
let runtimeInFlight = false;
let lastGuardState = '';
const clipboardChannel = 'claude-vm-clipboard';
const desktopOrigin = 'http://127.0.0.1:6080';
let clipboardConnected = false;
let clipboardBusy = false;
let clipboardLastHost = null;
let clipboardLastGuest = null;
let clipboardPending = null;
let clipboardGuestPending = null;
let clipboardSequence = 0;
let clipboardObservedHost;
const normalizeClipboardText = (text) => text.replace(/\r\n/g, '\n');

function resetClipboard() {
  clipboardConnected = false;
  clipboardLastHost = null;
  clipboardLastGuest = null;
  clipboardPending = null;
  clipboardGuestPending = null;
  clipboardObservedHost = undefined;
  clipboardSequence++;
}
function sendDesktop(message) {
  $('desktopFrame').contentWindow?.postMessage({ channel: clipboardChannel, ...message }, desktopOrigin);
}
$('desktopFrame').addEventListener('load', () => {
  if (!sessionStarted) return;
  resetClipboard();
  sendDesktop({ type: 'hello' });
});
window.addEventListener('message', (event) => {
  if (!sessionStarted || event.origin !== desktopOrigin || event.source !== $('desktopFrame').contentWindow || event.data?.channel !== clipboardChannel) return;
  const message = event.data;
  if (message.type === 'ready') {
    const connected = message.connected === true;
    if (connected === clipboardConnected) return;
    resetClipboard();
    clipboardConnected = connected;
  } else if (message.type === 'ack' && clipboardPending && message.id === clipboardPending.id) {
    if (message.sent) { clipboardLastHost = clipboardPending.normalized; clipboardLastGuest = clipboardPending.normalized; }
    clipboardPending = null;
  } else if (message.type === 'guest-text' && typeof message.text === 'string') {
    const normalized = normalizeClipboardText(message.text);
    if (normalized === clipboardLastGuest || (clipboardPending && normalized === clipboardPending.normalized)) return;
    clipboardSequence++;
    clipboardPending = null;
    clipboardGuestPending = message.text;
  }
});
async function syncClipboard() {
  if (!sessionStarted || !clipboardConnected || clipboardBusy) return;
  clipboardBusy = true;
  const sequence = clipboardSequence;
  try {
    let text = await invoke('clipboard_read_text');
    if (sequence !== clipboardSequence || !sessionStarted || !clipboardConnected) return;
    const snapshot = typeof text === 'string' ? `text:${normalizeClipboardText(text)}` : 'non-text';
    if (clipboardGuestPending !== null) {
      const guest = clipboardGuestPending;
      if (clipboardObservedHost !== undefined && clipboardObservedHost !== snapshot) {
        clipboardGuestPending = null; // 宿主已有较新的内容，不能用旧的客机事件覆盖。
      } else {
        await invoke('clipboard_write_text', { text: guest });
        if (sequence !== clipboardSequence || !sessionStarted) return;
        clipboardGuestPending = null;
        clipboardLastGuest = normalizeClipboardText(guest);
        clipboardLastHost = normalizeClipboardText(guest);
        text = guest;
      }
    }
    clipboardObservedHost = typeof text === 'string' ? `text:${normalizeClipboardText(text)}` : 'non-text';
    if (typeof text !== 'string') {
      clipboardLastHost = null;
      clipboardLastGuest = null;
      clipboardPending = null;
      return;
    }
    const normalized = normalizeClipboardText(text);
    if (normalized === clipboardLastHost) return;
    if (clipboardPending && Date.now() - clipboardPending.at < 1200) return;
    const id = ++clipboardSequence;
    clipboardPending = { id, text, normalized, at: Date.now() };
    sendDesktop({ type: 'host-text', id, text });
  } catch (_) { /* retry on the next tick without changing the remembered value */ }
  finally { clipboardBusy = false; }
}
setInterval(syncClipboard, 400);
setInterval(() => { if (sessionStarted && !clipboardConnected) sendDesktop({ type: 'hello' }); }, 1200);
function invalidateCheck() {
  checkGeneration++;
  $('checkResults').replaceChildren();
  $('backgroundCheck').classList.remove('attention');
  $('backgroundCheckLabel').textContent = '网络详情';
  $('checkMessage').textContent = '连接状态或配置已变化，请重新检查。';
}

const protectionLabels = {
  idle: '网络保护未启用',
  checking: '正在验证网络保护',
  guarded: '网络保护已开启',
  blocked: '网络保护未通过检查',
  proxy_down: '出口节点已断开',
  off: '网络保护已关闭',
  unknown: '网络保护状态待确认',
};

function showProtection(state) {
  const label = protectionLabels[state];
  $('guardIndicator').dataset.state = state;
  if ($('desktopStatus').textContent !== label) $('desktopStatus').textContent = label;
  $('liveLatency').hidden = state !== 'guarded' || !$('liveLatency').textContent;
  if (state !== 'guarded') $('timezoneWarning').hidden = true;
}

function formatStorageBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const gib = 1024 ** 3;
  if (bytes >= gib) return `${(bytes / gib).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
  return `${(bytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
}

async function refreshStorage() {
  const button = $('refreshStorage');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const status = await invoke('storage_status');
    $('storageCard').hidden = !status;
    if (!status) return;
    $('storageCapacity').textContent = formatStorageBytes(status.capacity_bytes);
    $('storageAllocated').textContent = formatStorageBytes(status.allocated_bytes);
    $('storageAvailable').textContent = formatStorageBytes(status.guest_available_bytes);
    const growth = status.growth;
    $('storagePolicy').hidden = !growth;
    if (growth) {
      $('storagePolicy').textContent = `剩余空间低于 ${formatStorageBytes(growth.threshold_bytes)} 时，下次启动按需扩容，最高 ${formatStorageBytes(growth.limit_bytes)}。`;
    }
    const pending = growth?.pending_capacity_bytes;
    let message = status.guest_available_bytes == null
      ? '启动虚拟机后可刷新剩余空间。' : '';
    if (!status.initialized) message = '首次启动时创建虚拟盘。';
    if (pending != null) message = `下次启动计划扩容到 ${formatStorageBytes(pending)}，本机磁盘空间不足时将延后。`;
    $('storageMessage').textContent = message;
  } catch (error) {
    $('storageCard').hidden = false;
    $('storageMessage').textContent = String(error);
  } finally {
    button.disabled = false;
  }
}
$('refreshStorage').addEventListener('click', () => { void refreshStorage(); });

function switchPage(page) {
  document.querySelectorAll('[data-page]').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  document.querySelectorAll('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== page; });
  $('pageTitle').textContent = ({ home: '虚拟桌面', files: '工作区', system: '系统设置' })[page] || 'Claude Haven';
  if (page === 'system') void refreshStorage();
}
document.querySelectorAll('[data-page]').forEach((el) => el.addEventListener('click', () => switchPage(el.dataset.page)));

function createSelect(select) {
  const wrapper = document.createElement('div'); wrapper.className = 'select-wrap';
  const button = document.createElement('button'); button.type = 'button'; button.className = 'select-trigger';
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-labelledby', `${select.id}Label ${select.id}Value`);
  const value = document.createElement('span'); value.id = `${select.id}Value`; value.className = 'select-value';
  const arrow = document.createElement('span'); arrow.className = 'select-chevron'; arrow.setAttribute('aria-hidden', 'true');
  button.append(value, arrow);
  const list = document.createElement('div'); list.className = 'select-list'; list.id = `${select.id}Options`;
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-labelledby', `${select.id}Label`); list.hidden = true;
  button.setAttribute('aria-controls', list.id);
  const label = document.querySelector(`label[for="${select.id}"]`);
  if (label) { label.id = `${select.id}Label`; label.addEventListener('click', (event) => { event.preventDefault(); button.focus(); }); }
  select.before(wrapper); wrapper.append(select, button, list); select.hidden = true;
  let active = 0;
  function close() { list.hidden = true; button.setAttribute('aria-expanded', 'false'); button.removeAttribute('aria-activedescendant'); }
  function sync() {
    const options = Array.from(select.options);
    const selectedName = select.selectedOptions[0]?.textContent || (select.id === 'nodeSelect' ? '请选择出口节点' : '请选择');
    value.textContent = selectedName;
    button.disabled = select.disabled || options.length === 0;
    active = Math.max(0, select.selectedIndex);
    list.replaceChildren();
    options.forEach((option, index) => {
      const row = document.createElement('div'); row.className = 'select-option'; row.id = `${select.id}Option${index}`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(option.selected));
      const lat = select.id === 'nodeSelect' ? nodeLatency.get(option.value) : undefined;
      const name = document.createElement('span'); name.className = 'select-option-name'; name.textContent = option.textContent;
      row.append(name);
      if (lat) {
        const badge = document.createElement('b');
        badge.className = 'select-latency' + (lat.ms == null || lat.ms > 300 ? ' slow' : '');
        badge.textContent = lat.error || `${lat.ms} ms`;
        row.append(badge);
      }
      row.addEventListener('click', () => { choose(index); close(); button.focus(); });
      list.append(row);
    });
    const selectedLatency = select.id === 'nodeSelect' ? nodeLatency.get(select.value) : undefined;
    const existing = button.querySelector('.select-latency');
    if (selectedLatency) {
      const badge = existing || document.createElement('b');
      badge.className = 'select-latency' + (selectedLatency.ms == null || selectedLatency.ms > 300 ? ' slow' : '');
      badge.textContent = selectedLatency.error || `${selectedLatency.ms} ms`;
      if (!existing) button.insertBefore(badge, arrow);
    } else if (existing) {
      existing.remove();
    }
  }
  function highlight() {
    Array.from(list.children).forEach((row, index) => row.classList.toggle('highlight', index === active));
    const row = list.children[active];
    if (row) { button.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }); }
  }
  function choose(index) {
    if (!select.options[index] || select.options[index].disabled) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index; sync();
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function open() {
    if (button.disabled) return;
    document.querySelectorAll('.select-wrap').forEach((other) => { if (other !== wrapper) other.dispatchEvent(new Event('close-select')); });
    const rect = button.getBoundingClientRect();
    const view = wrapper.closest('.settings-view')?.getBoundingClientRect();
    wrapper.classList.toggle('opens-up', (view?.bottom ?? window.innerHeight) - rect.bottom < 210 && rect.top - (view?.top ?? 0) > 210);
    list.hidden = false; button.setAttribute('aria-expanded', 'true'); highlight();
  }
  wrapper.addEventListener('close-select', close);
  button.addEventListener('click', () => { if (list.hidden) open(); else close(); });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (list.hidden) open();
      else { active = event.key === 'Home' ? 0 : event.key === 'End' ? select.options.length - 1 : Math.max(0, Math.min(select.options.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); highlight(); }
    } else if ((event.key === 'Enter' || event.key === ' ') && !list.hidden) {
      event.preventDefault(); choose(active); close();
    } else if (event.key === 'Tab') close();
  });
  document.addEventListener('pointerdown', (event) => { if (!wrapper.contains(event.target)) close(); });
  select.addEventListener('change', sync);
  sync();
  return { sync };
}
const nodeLatency = new Map();
const selects = {
  nodeSelect: createSelect($('nodeSelect')),
  environmentLanguage: createSelect($('environmentLanguage')),
  timezone: createSelect($('timezone')),
};
for (const zone of Intl.supportedValuesOf('timeZone')) {
  $('timezone').add(new Option(zone.replaceAll('_', ' '), zone));
}

async function showNodes(path, selected = '') {
  const select = $('nodeSelect');
  const names = await invoke('inspect_config', { path });
  nodeLatency.clear();
  select.replaceChildren();
  names.forEach((name) => { const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option); });
  select.value = names.includes(selected) ? selected : (names[0] || '');
  selects.nodeSelect.sync();
  $('testLatency').disabled = names.length === 0;
  return select.value;
}

const latencyText = (ms) => ms == null ? '—' : `${ms} ms`;
let latencyGeneration = 0;
async function probeLatencies() {
  const path = $('yamlPath').value;
  if (!path) return;
  const generation = ++latencyGeneration;
  const button = $('testLatency');
  button.disabled = true;
  button.textContent = '测速中…';
  $('latencyResult').textContent = '正在测速…';
  try {
    const nodes = await invoke('node_latency', { path });
    if (generation !== latencyGeneration) return;
    nodeLatency.clear();
    nodes.forEach((node) => nodeLatency.set(node.name, node));
    selects.nodeSelect.sync();
    const best = nodes.filter((node) => node.ms != null).sort((a, b) => a.ms - b.ms)[0];
    $('latencyResult').textContent = best ? `最快：${best.name} · ${best.ms} ms` : '没有可测速的节点。';
  } catch (error) {
    if (generation === latencyGeneration) $('latencyResult').textContent = String(error);
  } finally {
    if (generation === latencyGeneration) { button.disabled = $('nodeSelect').options.length === 0; button.textContent = '延迟测速'; }
  }
}

function updateLiveLatency(ms, name) {
  const el = $('liveLatency');
  el.textContent = ms == null ? '' : `节点延迟 ${ms} ms`;
  el.title = ms == null ? '节点连接延迟暂不可用' : `节点 ${name || '出口'}的 TCP 连接延迟`;
  el.classList.toggle('slow', ms != null && ms > 300);
  el.hidden = !sessionStarted || lastGuardState !== 'guarded' || ms == null;
}

let liveLatencyBusy = false;
async function pollLiveLatency() {
  if (liveLatencyBusy || !sessionStarted || !config.yaml_path || !config.node) return;
  liveLatencyBusy = true;
  const { yaml_path, node } = config;
  const generation = statusGeneration;
  const isCurrent = () => sessionStarted && generation === statusGeneration
    && yaml_path === config.yaml_path && node === config.node;
  try {
    const ms = await invoke('node_latency', { path: yaml_path, node });
    if (isCurrent()) updateLiveLatency(Array.isArray(ms) ? ms.find((item) => item.name === node)?.ms : null, node);
  } catch (_) { if (isCurrent()) updateLiveLatency(null); }
  finally { liveLatencyBusy = false; }
}
setInterval(pollLiveLatency, 8000);

async function save(message, nextConfig = config) {
  try {
    await invoke('save_config', { config: nextConfig });
    config = nextConfig;
    if (message === 'networkMessage') {
      const repairingNode = Boolean(nodeConfigIssue);
      nodeConfigIssue = '';
      if (repairingNode && !sessionStarted) {
        autoStartDone = false;
        switchPage('home');
      }
    }
    $(message).textContent = message === 'environmentMessage'
      ? '设置已保存，重启虚拟环境后生效。'
      : '设置已保存。';
    if (!sessionStarted) void refreshStatus();
  }
  catch (error) { $(message).textContent = String(error); }
}

$('chooseYaml').addEventListener('click', async () => {
  try {
    const path = await invoke('choose_config');
    if (!path) return;
    await showNodes(path, path === config.yaml_path ? config.node : '');
    invalidateCheck();
    $('yamlPath').value = path;
    $('networkMessage').textContent = '已选择第一个节点，可更换节点后保存设置。';
  } catch (error) { $('networkMessage').textContent = String(error); }
});
$('nodeSelect').addEventListener('change', invalidateCheck);
$('testLatency').addEventListener('click', () => { void probeLatencies(); });
$('saveNetwork').addEventListener('click', () => {
  const yaml_path = $('yamlPath').value;
  const node = $('nodeSelect').value;
  if (!yaml_path || !node) {
    $('networkMessage').textContent = '请选择配置文件和出口节点，再保存设置。';
    return;
  }
  void save('networkMessage', { ...config, yaml_path, node });
});
$('chooseWorkspace').addEventListener('click', async () => {
  try { const path = await invoke('choose_workspace'); if (path) { config.workspace = path; $('workspacePath').value = path; } }
  catch (error) { $('workspaceMessage').textContent = String(error); }
});
$('saveWorkspace').addEventListener('click', () => { void save('workspaceMessage'); });
$('saveEnvironment').addEventListener('click', () => {
  void save('environmentMessage', {
    ...config,
    timezone: $('timezone').value,
    language: $('environmentLanguage').value,
  });
});
$('timezoneWarning').addEventListener('click', () => {
  switchPage('system');
  $('timezone').focus();
});
function toggleCheckPopover(show) {
  const popover = $('checkPopover');
  const next = show ?? popover.hidden;
  if (next === !popover.hidden) return;
  popover.hidden = !next;
  $('backgroundCheck').setAttribute('aria-expanded', String(next));
  if (next) $('checkPopoverClose').focus();
}
$('backgroundCheck').addEventListener('click', () => toggleCheckPopover());
$('checkPopoverClose').addEventListener('click', () => { toggleCheckPopover(false); $('backgroundCheck').focus(); });
document.addEventListener('pointerdown', (event) => {
  const popover = $('checkPopover');
  if (!popover.hidden && !popover.contains(event.target) && event.target !== $('backgroundCheck') && !$('backgroundCheck').contains(event.target)) toggleCheckPopover(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('checkPopover').hidden) return;
  toggleCheckPopover(false);
  $('backgroundCheck').focus();
});

async function runNetworkCheck() {
  const generation = checkGeneration;
  const button = $('checkNetwork');
  if (button.disabled) return;
  button.disabled = true;
  $('stopRuntime').disabled = true;
  $('stopRuntime').title = '环境检查完成后可以停止';
  const badge = $('backgroundCheck');
  badge.hidden = false;
  badge.classList.remove('attention');
  $('backgroundCheckLabel').textContent = '网络检查中';
  $('checkResults').replaceChildren();
  $('checkMessage').textContent = '正在检查当前连接…';
  try {
    const groups = await invoke('check_network');
    if (generation !== checkGeneration) return;
    let count = 0;
    groups.forEach((group) => (group.items || []).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'check-result';
      const mark = document.createElement('span'); mark.className = 'check-mark ' + (item.status || 'info');
      mark.textContent = ({ pass: '✓', warn: '!', fail: '×', info: 'i' })[item.status] || '·';
      const body = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = item.label || '';
      const value = document.createElement('p'); value.textContent = item.value || '';
      body.append(title, value);
      if (item.detail || item.advice) { const detail = document.createElement('p'); detail.textContent = [item.detail, item.advice].filter(Boolean).join(' '); body.append(detail); }
      row.append(mark, body); $('checkResults').append(row); count++;
    }));
    const warnings = groups.flatMap((group) => group.items || []).filter((item) => item.status === 'warn' || item.status === 'fail').length;
    $('checkMessage').textContent = count ? `已完成 ${count} 项检查；连接变化后请重新检查。` : '没有获取到检查结果。';
    badge.classList.toggle('attention', !count || warnings > 0);
    $('backgroundCheckLabel').textContent = warnings ? `网络详情 · ${warnings} 项需关注` : '网络详情';
  } catch (error) {
    if (generation === checkGeneration) {
      $('checkMessage').textContent = String(error);
      badge.classList.add('attention');
      $('backgroundCheckLabel').textContent = '网络详情';
    }
  }
  finally {
    button.disabled = false;
    $('stopRuntime').disabled = false;
    $('stopRuntime').title = '';
  }
}
$('checkNetwork').addEventListener('click', runNetworkCheck);

async function loadConfig() {
  try {
    config = await invoke('load_config');
    $('yamlPath').value = config.yaml_path;
    $('workspacePath').value = config.workspace;
    if (config.timezone && !Array.from($('timezone').options).some(option => option.value === config.timezone)) {
      $('timezone').add(new Option(config.timezone, config.timezone));
    }
    $('timezone').value = config.timezone || '';
    $('environmentLanguage').value = config.language || 'en-US';
    selects.timezone.sync();
    selects.environmentLanguage.sync();
    if (config.yaml_path) {
      const selected = await showNodes(config.yaml_path, config.node);
      if (!selected) {
        throw new Error('配置文件中没有可用节点。');
      } else {
        if (selected !== config.node) {
          const nextConfig = { ...config, node: selected };
          await invoke('save_config', { config: nextConfig });
          config = nextConfig;
          $('networkMessage').textContent = '原节点不可用，已选择并保存列表中的第一个节点。';
        }
        void probeLatencies();
      }
    }
  } catch (error) {
    nodeConfigIssue = String(error);
    $('networkMessage').textContent = nodeConfigIssue;
  }
}

function connectDesktop() {
  sessionStarted = true;
  resetClipboard();
  if ($('desktopFrame').getAttribute('src') !== 'http://127.0.0.1:6080/desktop.html?autoconnect=1') {
    $('desktopFrame').src = 'http://127.0.0.1:6080/desktop.html?autoconnect=1';
  }
  $('desktopFrame').hidden = false;
  $('stageContent').hidden = true;
  $('startupOverlay').hidden = true;
  $('stopRuntime').hidden = false;
  lastGuardState = 'guarded';
  showProtection(lastGuardState);
  $('topStatus').textContent = '运行中';
  void pollLiveLatency();
  invalidateCheck();
  $('backgroundCheck').hidden = false;
  const generation = statusGeneration;
  void refreshGuard().then(() => {
    if (sessionStarted && generation === statusGeneration && lastGuardState === 'guarded') void runNetworkCheck();
  });
}

const macStartupStages = {
  'mac-image': '正在准备数据盘并解压内核',
  'mac-boot': '正在启动 Linux 虚拟机并挂载工作区',
  'mac-sync': '正在校验运行时脚本和桌面资源',
  'mac-network': '正在连接所选网络节点',
  'mac-fonts': '正在检查字体并配置桌面',
  'mac-desktop': '正在启动图形桌面',
  'mac-input': '正在启动中文输入法服务',
  'desktop-ready': '桌面已就绪，正在验证网络保护',
};

function showMacStartupStage(event) {
  if (event === 'mac-first-start') {
    $('startupTitle').textContent = '首次启动';
    $('startupNote').textContent = '首次启动会创建本地数据盘，请保持应用打开。';
    $('startupNote').hidden = false;
    return;
  }
  if (event === 'mac-slow') {
    $('startupNote').textContent = '初始化比平时久一些，应用仍在等待桌面就绪。';
    $('startupNote').hidden = false;
    return;
  }
  const stage = macStartupStages[event];
  if (!stage) return;
  $('startupDetail').textContent = stage;
}

async function startSession() {
  if (runtimeInFlight) return;
  autoStartDone = true;
  runtimeInFlight = true;
  showProtection('checking');
  $('startRuntime').disabled = true;
  $('stageTitle').textContent = '正在启动虚拟环境';
  $('stageDescription').textContent = latestRuntimePlatform === 'macos'
    ? '正在启动虚拟桌面并验证网络保护。'
    : '正在同步运行时并验证网络守卫，首次启动可能需要几分钟。';
  $('installNote').textContent = '请保持应用打开。';
  $('startupOverlay').hidden = false;
  $('startupTitle').textContent = '正在准备工作空间';
  $('startupDetail').textContent = '正在启动虚拟桌面';
  $('startupNote').hidden = true;
  let unlisten = () => {};
  try {
    unlisten = await window.__TAURI__.event.listen('startup-progress', ({ payload }) => {
      if (latestRuntimePlatform === 'macos') {
        showMacStartupStage(payload);
        return;
      }
      if (payload === 'desktop-starting') $('startupDetail').textContent = '正在打开虚拟桌面';
      if (payload === 'desktop-ready') {
        $('startupTitle').textContent = '桌面已准备好';
        $('startupDetail').textContent = '正在确认代理出口和断网保护';
      }
    });
    const outcome = await invoke('start_runtime');
    if (!outcome.ok) {
      $('stopRuntime').hidden = !outcome.needs_stop;
      throw new Error(outcome.error || '启动未完成。');
    }
    connectDesktop();
  } catch (error) {
    $('startupOverlay').hidden = true;
    $('desktopFrame').hidden = true;
    $('desktopFrame').src = 'about:blank';
    $('stageContent').hidden = false;
    $('stageTitle').textContent = '无法完成启动';
    $('stageDescription').textContent = String(error);
    $('installNote').textContent = $('stopRuntime').hidden ? '请检查配置后重试。' : '环境已部分启动，可尝试停止环境后重试。';
    showProtection($('stopRuntime').hidden ? 'idle' : 'unknown');
    $('startRuntime').disabled = false;
  } finally {
    unlisten();
    runtimeInFlight = false;
  }
}

function triggerAutoStart(status, manual) {
  if (stoppedByUser || autoStartDone || sessionStarted || runtimeInFlight) return;
  if (!status || !status.wsl_available || !status.runtime_resources_available) return;
  if ((!status.distro_registered && !manual) || !configComplete()) return;
  return startSession();
}

async function refreshStatus(manual = false) {
  if (runtimeInFlight) return;
  if (manual) manualStartRequested = true;
  if ($('refresh').disabled) return;
  const button = $('refresh');
  button.disabled = true;
  const generation = statusGeneration;
  try {
    const status = await invoke('runtime_status');
    const boot = await invoke('bootstrap_snapshot');
    latestRuntimePlatform = status.platform;
    const isMac = status.platform === 'macos';
    const backendName = isMac ? 'Apple 虚拟化' : 'WSL';
    latestHostProbe = status.host_probe || null;
    renderBootstrap(boot, latestHostProbe);
    if (generation !== statusGeneration || runtimeInFlight) return;
    manual = manualStartRequested;
    manualStartRequested = false;
    $('topDot').classList.toggle('available', status.wsl_available);
    if (!sessionStarted) $('topStatus').textContent = status.wsl_available ? `${backendName} 可用` : `${backendName} 未就绪`;
    $('installWsl').hidden = isMac || status.wsl_available;
    $('selectWslMsi').hidden = isMac || status.wsl_available || status.host_probe?.wsl_cli_available !== false;
    const canRestore = !stoppedByUser && status.session_running && status.desktop_available;
    const canStart = status.wsl_available && status.runtime_resources_available && configComplete();
    const needsNode = !canRestore && Boolean(nodeConfigIssue);
    const startButton = $('startRuntime');
    startButton.dataset.action = needsNode ? 'network-settings' : 'start';
    startButton.textContent = needsNode ? '前往网络设置 ↗' : '启动虚拟环境 ↗';
    startButton.disabled = bootstrapBusy || sessionStarted || (!canRestore && !canStart && !needsNode);
    if (!sessionStarted && !runtimeInFlight) $('stopRuntime').hidden = stoppedByUser || !status.session_running;
    $('stageTitle').textContent = stoppedByUser ? '环境已停止' : !status.wsl_available ? `准备 ${backendName} 运行环境` : status.distro_registered ? '检测到已有虚拟环境' : '准备你的工作空间';
    $('stageDescription').textContent = canRestore ? '正在检查已有会话的网络保护，确认后将直接进入。'
      : !status.wsl_available ? (isMac ? '此版本需要配备 Apple 芯片的 Mac。' : boot.error?.user_message || '检查并配置 WSL 2。仅在缺少必要组件时才会下载或请求管理员授权。')
      : needsNode ? nodeConfigIssue
      : !status.runtime_resources_available ? '未找到完整的运行时资源，请检查应用目录或使用 npm run dev 启动。'
      : !configComplete() ? '请先完成网络与工作区设置。'
      : '点击启动进入虚拟桌面。';
    if (!sessionStarted && !boot.error) $('installNote').textContent = '';
    if (!sessionStarted) showProtection(status.session_running ? 'unknown' : 'idle');
    $('runtimeDetail').textContent = !status.wsl_available ? (isMac ? 'Apple 虚拟化不可用。' : 'WSL 未就绪，请检查 Windows 功能。')
      : !status.runtime_resources_available ? '运行时资源不完整。'
      : status.distro_registered ? `${backendName} 可用，已发现虚拟环境。` : `${backendName} 可用，运行时资源已就绪。`;
    if (status.session_running && status.desktop_available && !stoppedByUser && !sessionStarted && !runtimeInFlight) {
      runtimeInFlight = true;
      showProtection('checking');
      $('startRuntime').disabled = true;
      $('stageTitle').textContent = '正在恢复已有会话';
      $('startupTitle').textContent = '正在恢复工作空间';
      $('startupDetail').textContent = '正在确认已有会话的网络保护';
      $('startupNote').hidden = true;
      $('startupOverlay').hidden = false;
      try {
        await invoke('restore_session');
        connectDesktop();
      } catch (error) {
        $('startupOverlay').hidden = true;
        let latest = null;
        try { latest = await invoke('runtime_status'); } catch (_) { /* keep the explicit recovery error */ }
        if (latest && !latest.session_running) {
          $('stageTitle').textContent = '环境已停止';
          $('stageDescription').textContent = '之前的会话已经结束，可以直接重新启动。';
          $('installNote').textContent = configComplete() ? '点击启动即可重新进入。' : '请确认网络与工作区设置。';
          $('startRuntime').disabled = !latest.wsl_available || !latest.runtime_resources_available || !configComplete();
          $('stopRuntime').hidden = true;
          showProtection('idle');
        } else {
          $('stageTitle').textContent = '已有会话无法恢复';
          $('stageDescription').textContent = String(error);
          $('installNote').textContent = '会话仍在运行。处理上方提示后，可点击启动重试。';
          $('startRuntime').disabled = false;
          $('stopRuntime').hidden = false;
          showProtection('unknown');
        }
      } finally { runtimeInFlight = false; }
      return;
    }
    if (manual) autoStartDone = false;
    await triggerAutoStart(status, manual);
  } catch (_) {
    if (generation !== statusGeneration) return;
    $('topStatus').textContent = '检查失败';
    $('stageTitle').textContent = '无法检查运行环境';
    $('stageDescription').textContent = '请确认应用正在 Tauri 中运行。';
    if (!sessionStarted) showProtection('unknown');
    $('runtimeDetail').textContent = '无法读取 WSL 状态。';
  } finally {
    manualStartRequested = false;
    button.disabled = false;
  }
}

$('refresh').addEventListener('click', () => { void refreshStatus(); });
$('startRuntime').addEventListener('click', () => {
  if ($('startRuntime').dataset.action === 'network-settings') {
    switchPage('system');
    return;
  }
  stoppedByUser = false;
  void refreshStatus(true);
});
$('stopRuntime').addEventListener('click', async () => {
  if (runtimeInFlight) return;
  statusGeneration++;
  stoppedByUser = true;
  runtimeInFlight = true;
  const button = $('stopRuntime'); button.disabled = true;
  try {
    await invoke('stop_runtime');
    sessionStarted = false;
    autoStartDone = true;
    resetClipboard();
    lastGuardState = '';
    $('desktopFrame').hidden = true; $('desktopFrame').src = 'about:blank';
    $('liveLatency').textContent = '';
    showProtection('idle');
    $('stageContent').hidden = false;
    $('stageTitle').textContent = '环境已停止';
    $('stageDescription').textContent = '点击启动进入虚拟桌面。';
    $('installNote').textContent = '';
    $('startRuntime').disabled = false;
    $('startRuntime').dataset.action = 'start';
    button.hidden = true;
    $('backgroundCheck').hidden = true;
    toggleCheckPopover(false);
    invalidateCheck();
    runtimeInFlight = false;
    await refreshStatus();
  } catch (error) {
    stoppedByUser = false;
    $('desktopStatus').textContent = '停止失败：' + String(error);
    $('stageDescription').textContent = '停止失败：' + String(error);
  }
  finally { button.disabled = false; runtimeInFlight = false; }
});
function syncPowerButton() {
  const power = $('powerRuntime');
  const stop = $('stopRuntime');
  const running = !stop.hidden;
  const label = running ? '停止环境' : $('startRuntime').dataset.action === 'network-settings' ? '前往网络设置' : '启动环境';
  power.setAttribute('aria-label', label);
  power.title = label;
  power.classList.toggle('running', running);
  power.disabled = running ? stop.disabled : $('startRuntime').disabled;
}
new MutationObserver(syncPowerButton).observe($('stopRuntime'), { attributes: true, attributeFilter: ['hidden', 'disabled'] });
new MutationObserver(syncPowerButton).observe($('startRuntime'), { attributes: true, attributeFilter: ['disabled', 'data-action'] });
$('powerRuntime').addEventListener('click', () => {
  if (!$('stopRuntime').hidden) $('stopRuntime').click();
  else $('startRuntime').click();
});
syncPowerButton();
async function refreshGuard() {
  if (!sessionStarted || stoppedByUser) return;
  const generation = statusGeneration;
  let report;
  try { report = await invoke('guard_status'); } catch (_) { /* show unknown below */ }
  if (!sessionStarted || stoppedByUser || generation !== statusGeneration) return;
  const state = report?.state || 'unknown';
  if (lastGuardState && state !== lastGuardState) invalidateCheck();
  lastGuardState = state;
  showProtection(Object.hasOwn(protectionLabels, state) ? state : 'unknown');
  const { active_timezone: active, exit_timezone: exit, timezone_source: source } = report || {};
  const location = [report?.exit_country, report?.exit_city].filter(Boolean).join(' · ');
  const warning = $('timezoneWarning');
  const fallback = source === 'fallback';
  const mismatch = Boolean(active && exit && active !== exit);
  warning.textContent = fallback ? '请选择时区' : '时区与代理出口不一致';
  warning.hidden = state !== 'guarded' || !(fallback || mismatch);
  $('timezoneDetails').textContent = active
    ? `当前时区 ${active} · ${exit ? `出口时区 ${exit}` : '未识别出口时区'}${location ? `（${location}）` : ''}${fallback ? '。可手动选择时区。' : ''}`
    : '';
  $('topStatus').textContent = state === 'guarded' ? '运行中' : '网络需要注意';
  $('topDot').classList.toggle('available', state === 'guarded');
}
setInterval(refreshGuard, 6000);
window.__TAURI__.event.listen('exit-pending', () => {
  $('desktopStatus').textContent = '正在等待当前操作完成并停止环境…';
  $('topStatus').textContent = '正在退出';
}).catch(() => {});
window.__TAURI__.event.listen('exit-failed', ({ payload }) => {
  $('desktopStatus').textContent = '退出失败：' + String(payload);
  $('topStatus').textContent = '退出未完成';
}).catch(() => {});
$('installWsl').addEventListener('click', async () => {
  if (bootstrapBusy) return;
  bootstrapBusy = true;
  const button = $('installWsl'); button.disabled = true;
  $('selectWslMsi').disabled = true;
  $('installNote').textContent = '正在检查电脑；只有确实缺少组件时才会下载或请求管理员授权。';
  $('bootstrapProgress').hidden = true;
  try {
    const snapshot = await invoke('bootstrap_start');
    renderBootstrap(snapshot);
    if (snapshot.phase === 'reboot_required') $('installNote').textContent = snapshot.error?.user_message || '请重启电脑后重新打开 Claude Haven。';
    else if (snapshot.phase === 'infrastructure_ready' || snapshot.phase === 'already_ready') $('installNote').textContent = 'WSL 2 已就绪，正在刷新运行环境。';
    else if (snapshot.error) $('installNote').textContent = snapshot.error.user_message;
  } catch (error) {
    try { renderBootstrap(await invoke('bootstrap_snapshot')); } catch (_) {}
    $('installNote').textContent = bootstrapState?.error?.user_message || String(error);
  } finally {
    bootstrapBusy = false;
    button.disabled = false;
    if (bootstrapState?.phase === 'infrastructure_ready' || bootstrapState?.phase === 'already_ready') await refreshStatus(true);
    else await refreshStatus();
  }
});
$('selectWslMsi').addEventListener('click', async () => {
  if (bootstrapBusy) return;
  bootstrapBusy = true;
  $('installWsl').disabled = true;
  $('selectWslMsi').disabled = true;
  try {
    const path = await invoke('bootstrap_select_msi');
    if (path) {
      $('installNote').textContent = '已验证本地 WSL 安装包。点击「配置 WSL 2」继续安装。';
      renderBootstrap(await invoke('bootstrap_snapshot'));
    }
  } catch (error) { $('installNote').textContent = String(error); }
  finally {
    bootstrapBusy = false;
    renderBootstrap(bootstrapState);
  }
});
$('cancelBootstrap').addEventListener('click', async () => {
  $('cancelBootstrap').disabled = true;
  try { await invoke('bootstrap_cancel'); $('installNote').textContent = '正在停止下载，已完成的数据会保留以便稍后续传。'; }
  finally { $('cancelBootstrap').disabled = false; }
});
$('copyBootstrapDiagnostic').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('bootstrapDiagnosticText').textContent);
    $('copyBootstrapDiagnostic').textContent = '已复制';
    setTimeout(() => { $('copyBootstrapDiagnostic').textContent = '复制诊断信息'; }, 1600);
  } catch (_) { $('installNote').textContent = '无法写入剪贴板，请手动复制诊断信息。'; }
});
window.__TAURI__.event.listen('bootstrap-progress', ({ payload }) => {
  renderBootstrap(payload);
  const stages = {
    probing: '正在检查 Windows 与 WSL 能力…',
    downloading: '正在从微软官方下载 WSL…',
    verifying: '正在校验安装包大小、哈希与签名…',
    awaiting_elevation: '即将请求一次管理员授权…',
    enabling_features: '正在启用 VirtualMachinePlatform…',
    installing_msi: '正在安装 WSL 运行引擎…',
    rechecking: '正在重新检查 WSL 2…',
  };
  if (stages[payload.phase]) $('installNote').textContent = stages[payload.phase];
}).catch(() => {});
$('openReset').addEventListener('click', () => {
  $('resetPhrase').value = '';
  $('confirmReset').disabled = true;
  $('resetDialogError').textContent = '';
  $('resetScrim').hidden = false;
  $('resetPhrase').focus();
});
$('cancelReset').addEventListener('click', () => { $('resetScrim').hidden = true; $('openReset').focus(); });
$('resetScrim').addEventListener('click', (event) => {
  if (event.target === $('resetScrim')) $('cancelReset').click();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('resetScrim').hidden && !$('cancelReset').disabled) $('cancelReset').click();
});
$('resetPhrase').addEventListener('input', () => {
  $('confirmReset').disabled = $('resetPhrase').value.trim() !== '重置环境';
});
$('confirmReset').addEventListener('click', async () => {
  const button = $('confirmReset');
  if (button.disabled || runtimeInFlight) return;
  runtimeInFlight = true;
  button.disabled = true;
  $('cancelReset').disabled = true;
  $('resetDialogError').textContent = '正在安全停止并删除虚拟环境…';
  try {
    await invoke('reset_system', { confirmation: 'RESET_CLAUDE_ENVIRONMENT' });
    sessionStarted = false;
    stoppedByUser = true;
    autoStartDone = true;
    statusGeneration++;
    lastGuardState = '';
    resetClipboard();
    $('desktopFrame').hidden = true;
    $('desktopFrame').src = 'about:blank';
    $('stopRuntime').hidden = true;
    $('backgroundCheck').hidden = true;
    $('liveLatency').textContent = '';
    showProtection('idle');
    $('resetScrim').hidden = true;
    $('resetMessage').textContent = '环境已清除，网络和共享目录设置仍保留。回到工作台即可启动新环境。';
    switchPage('home');
    runtimeInFlight = false;
    await refreshStatus();
    $('stageTitle').textContent = '虚拟环境已重置';
    $('stageDescription').textContent = '已清除环境数据，可以用新 Claude 账号重新登录。';
    $('installNote').textContent = '网络与工作区设置仍然保留。';
  } catch (error) {
    $('resetDialogError').textContent = String(error);
    button.disabled = false;
  } finally {
    runtimeInFlight = false;
    $('cancelReset').disabled = false;
  }
});
void loadConfig().then(() => refreshStatus());
