#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2.0 重构：把 main.js 从「双链路 + 双显示模式」收敛为「单态 TUN + desktop」。

每个替换都断言标记唯一 / 旧串恰好出现一次，任何一处不匹配立即中止，
避免静默改错对象。可重复跑之前请先 git checkout。
"""
import sys

P = r'E:\Web\FuckCladue\claude-desktop\app\main.js'
with open(P, 'r', encoding='utf-8', newline='') as f:
    s = f.read()

count = 0


def once(old, new, label):
    """精确替换，旧串必须恰好出现一次。"""
    global s, count
    n = s.count(old)
    if n != 1:
        sys.exit(f'[FAIL] {label}: 旧串出现 {n} 次（应为 1）')
    s = s.replace(old, new, 1)
    count += 1


def between(start, end, new, label):
    """把 [start, end) 整段替换掉；start/end 都必须唯一。"""
    global s, count
    if s.count(start) != 1:
        sys.exit(f'[FAIL] {label}: 起始标记出现 {s.count(start)} 次')
    if s.count(end) != 1:
        sys.exit(f'[FAIL] {label}: 结束标记出现 {s.count(end)} 次')
    i = s.index(start)
    j = s.index(end)
    if j <= i:
        sys.exit(f'[FAIL] {label}: 结束标记在起始之前')
    s = s[:i] + new + s[j:]
    count += 1


# ---------------------------------------------------------------- 1. 头部常量
between(
    "const DISTRO = 'claude-vm';",
    "let win = null;",
    r'''const DISTRO = 'claude-vm';
const NOVNC_PORT = 6080;
const VNC_PASS = 'claudevm';
// 运行时脚本 / 界面资源有变更时 +1。它进配置指纹，保证升级后第一次点「启动」
// 不会去「接管」一个由旧脚本拉起的会话 —— 那些会话里的 openbox、entrypoint、
// 字体、内核配置全是旧版的，接管等于永远不生效。
const RUNTIME_REV = 12;
''',
    '头部常量')

# ---------------------------------------------------------------- 2. 删 redact
between(
    '// 代理地址里可能带 user:pass',
    'function loadConfig() {',
    '',
    '删 redact')

# ---------------------------------------------------------------- 3. mergeCfg
once(
    "  // macOS 没有 WSLg，只有串流桌面一条路（选项在渲染层也会隐藏）\n"
    "  if (process.platform === 'darwin') c.displayMode = 'desktop';\n",
    '',
    'mergeCfg 去掉 darwin 特例')

# ---------------------------------------------------------------- 4. defaultConfig
between(
    'function defaultConfig() {',
    'function rootfsPath() {',
    r'''function defaultConfig() {
  return {
    // 伪装画像：只有两套，见 lib/personas.js。tz / lang 由画像派生，
    // 进配置指纹，切换画像会强制重建会话。
    persona: 'tw-taipei',
    tz: 'Asia/Taipei',
    lang: 'zh_TW.UTF-8',
    // 用户外部工具（Clash Verge 等）正在编辑的 YAML；每次启动读最新内容。
    clashYamlPath: '',
    // 从 YAML 的 proxies 里选中的节点名。TUN 全量走这一个节点。
    selectedNode: '',
    workspace: path.join(app.getPath('home'), 'claude-workspace'),
    // strict —— 删默认路由 + 关 IPv6，容器内内核是唯一出口；内核挂了网络就是断的
    // off    —— 关闭熔断（不推荐，内核异常时会回落到本机直连）
    netGuard: 'strict',
    // 出口落在 CN/HK/MO 时是否硬阻断
    netGuardStrictRegion: true,
    // rime —— fcitx5 + Rime 万象拼音词库
    inputMethod: 'off',
  };
}

''',
    'defaultConfig')

# ---------------------------------------------------------------- 5. 删整套上游代理解析
between(
    '// ---------- 上游代理地址解析 ----------',
    '// ---------- 运行时操作 ----------',
    '',
    '删上游代理解析全段')

# ---------------------------------------------------------------- 6. runtimeAlive
between(
    '// ---------- 幂等启动 ----------',
    '// 影响运行时行为的配置项',
    r'''// ---------- 幂等启动 ----------
// 环境是否真的在跑：不能只看 /run/claude-vm/ready 标记（/run 是 tmpfs，
// 会话没销毁时三个桌面进程全退了标记也还在）。必须真的查三个常驻进程
// 再加串流端口，否则会「接管一具假活的桌面」，新脚本永远同步不进去。
async function runtimeAlive() {
  const p = await runWsl(['bash', '-c',
    "pgrep -x Xtigervnc >/dev/null 2>&1 && pgrep -x openbox >/dev/null 2>&1 && ps -eo args= | grep -q '[w]ebsockify' && echo RUNNING || echo DEAD"],
    { timeout: 15000 });
  const procsUp = /RUNNING/.test(String(p.stdout || ''));
  if (!procsUp) {
    log('runtime', '桌面进程缺失（Xtigervnc / openbox / websockify），需要重建');
    return false;
  }
  return await waitPort(NOVNC_PORT, 2500);
}

''',
    'runtimeAlive')

# ---------------------------------------------------------------- 7. cfgFingerprint
between(
    '// 影响运行时行为的配置项',
    'const readLastFingerprint =',
    r'''// 影响运行时行为的配置项。改了任意一项都必须重建，没改就有资格接管。
function cfgFingerprint(cfg) {
  // YAML 内容 + 选中节点都进指纹：用户在外部工具里改了订阅 / 换了节点，
  // 下次点「启动」必须重建会话，不能「接管」还在用旧配置的内核。
  let tun = 'invalid';
  const r = tunConfig.readClashYaml(cfg, userDir());
  if (r.ok) tun = `on:${tunConfig.tunFingerprint(r.text)}:${tunConfig.selectedNode(cfg, r.text)}`;
  return JSON.stringify({
    persona: cfg.persona || 'tw-taipei',
    tz: cfg.tz || '',
    lang: cfg.lang || '',
    tun,
    ws: cfg.workspace || '',
    // 熔断开关改变的是内核路由表，不能「接管」旧会话
    ng: cfg.netGuard === 'off' ? 'off' : 'strict',
    // 输入法要重起 fcitx5，同样必须重建会话
    im: cfg.inputMethod === 'rime' ? 'rime' : 'off',
    // 脚本/资源修订号：升级后强制重建一次
    rev: RUNTIME_REV,
  });
}

''',
    'cfgFingerprint')

# ---------------------------------------------------------------- 8. 删 waitReadyMarker
between(
    '// 等 entrypoint 写完就绪标记',
    'async function startRuntime(cfg, onProgress) {',
    '',
    '删 waitReadyMarker')

# ---------------------------------------------------------------- 9. 整体替换 startRuntime + 读状态函数
between(
    'async function startRuntime(cfg, onProgress) {',
    'async function stopRuntime() {',
    r'''async function startRuntime(cfg, onProgress) {
  // 统一路径写法后再算指纹：否则 "C://Users//x" 和 "C:\Users\x" 会被当成两份配置
  cfg = { ...cfg, workspace: normalizeWinPath(cfg.workspace || defaultConfig().workspace) };

  const imp = await ensureImported(onProgress);
  if (!imp.ok) return imp;

  // 已经在跑、且配置没变 → 接管。但仍要同步脚本，否则装了新版客户端
  // 只要旧会话还活着，新脚本 / 新资源就永远进不了 VM（1.0.27 的教训）。
  const fp = cfgFingerprint(cfg);
  const alive = await runtimeAlive();
  if (readLastFingerprint() === fp && alive) {
    log('start', '环境已在运行且配置未变，直接接管（不重建虚拟机）');
    const resumedSync = await syncScripts();
    return {
      ok: true,
      resumed: true,
      imported: imp.imported,
      host: '127.0.0.1',
      notes: ['环境已在运行，已直接接管，没有重启虚拟机。',
        resumedSync.ok ? '已顺带同步最新运行时脚本与窗口配置。' : ''].filter(Boolean),
      warnings: resumedSync.ok ? [] : ['运行时脚本同步失败，界面可能仍用旧配置；可点「停止」再「启动」。'],
    };
  }
  log('start', alive ? '配置已变更（画像 / 节点 / 工作区 / 熔断），按新配置重建运行时'
    : '探测不到正在运行的桌面，按全新启动处理');

  // 2.0：容器内 mihomo + TUN 是唯一网络路径，YAML 是必需项。
  // 没导入就不启动 —— 否则会拉起一台没有出口、却显示「已就绪」的假环境。
  const y = tunConfig.readClashYaml(cfg, userDir());
  if (!y.ok) {
    return { ok: false, error: `无法启动：${y.error}\n\n请先在设置里导入 Clash / Mihomo YAML 配置。` };
  }
  const nodes = tunConfig.extractNodes(y.text);
  if (!nodes.length) {
    return { ok: false, error: '无法启动：YAML 的 proxies 里没有可用节点。请检查订阅内容。' };
  }
  const chosen = tunConfig.selectedNode(cfg, y.text);
  if (!chosen) {
    return { ok: false, error: '无法启动：请先在设置里选择一个出口节点。' };
  }
  if (!nodes.some((n) => n.name === chosen)) {
    return { ok: false, error: `无法启动：选中的节点「${chosen}」已不在配置里（订阅更新过？）。请重新选择节点。` };
  }
  tunConfig.cacheClashYaml(y.text, userDir());

  const conflict = await portConflict(NOVNC_PORT);
  if (conflict) {
    log('start', `端口 ${NOVNC_PORT} 被占用：${conflict.name} PID ${conflict.pid}`);
    return {
      ok: false,
      error: [
        `端口 ${NOVNC_PORT} 已被其他程序占用，虚拟桌面的串流服务无法启动。`,
        '', `占用者：${conflict.name}（PID ${conflict.pid}）`, conflict.line,
        '', '请关闭该程序后重试。',
      ].join('\n'),
    };
  }

  onProgress && onProgress('同步运行时脚本…');
  const sync = await syncScripts();

  // 把外部 YAML 注入客机，交给容器内的 mihomo 内核。
  // base64 分块：Windows execFile 命令行上限 32767 字符，订阅 YAML 动辄 100KB+；
  // 且 YAML 里的引号/$/反斜杠会把 bash -c 拼坏。每块只含 A-Za-z0-9+/=，单引号内绝对安全。
  const b64 = Buffer.from(y.text, 'utf8').toString('base64');
  const CHUNK = 8000;
  const prep = await runWsl(['bash', '-c',
    'mkdir -p /opt/config && rm -f /opt/config/clash.yaml /opt/config/mihomo.yaml'], { timeout: 15000 });
  if (!prep.ok) return { ok: false, error: '无法准备虚拟环境配置目录，已中止启动。' };
  for (let i = 0; i < b64.length; i += CHUNK) {
    const part = b64.slice(i, i + CHUNK);
    const r = await runWsl(['bash', '-c', `printf '%s' '${part}' >> /opt/config/clash.yaml`],
      { timeout: 15000 });
    if (!r.ok) return { ok: false, error: '写入内核配置中断，已中止启动（不会放行未受保护的网络）。' };
  }
  const fin = await runWsl(['bash', '-c',
    'base64 -d /opt/config/clash.yaml > /opt/config/.clash.dec && ' +
    'mv -f /opt/config/.clash.dec /opt/config/clash.yaml && ' +
    'chmod 600 /opt/config/clash.yaml && echo TUN_YAML_OK'], { timeout: 15000 });
  if (!/TUN_YAML_OK/.test(fin.stdout || '')) {
    return { ok: false, error: '内核配置解码失败，已中止启动。请确认 YAML 是 UTF-8 文本。' };
  }
  onProgress && onProgress(`已注入内核配置（${nodes.length} 个节点 · 出口 ${chosen}）`);

  const notes = [];
  const warnings = [];
  const ws = cfg.workspace || defaultConfig().workspace;
  try { fs.mkdirSync(ws, { recursive: true }); } catch {}
  if (!sync.ok && sync.reason !== 'scripts-missing') {
    warnings.push('运行时脚本同步失败，环境可能仍在用旧脚本。可点「停止」后重新启动。');
  }

  await runWsl(['bash', '-c', 'rm -f /run/claude-vm/ready'], { timeout: 12000 });

  onProgress && onProgress('启动虚拟环境…');
  const guestWs = backend.guestWorkspacePath(ws);
  if (!guestWs) {
    return {
      ok: false,
      error: [
        `工作区路径无法映射进虚拟环境：${ws}`, '',
        '容器后端只共享 /Users 与 /Volumes 下的目录。请把工作区换到用户目录下再试。',
      ].join('\n'),
    };
  }
  const env = {
    TZ: cfg.tz || 'Asia/Taipei',
    LANG: cfg.lang || 'zh_TW.UTF-8',
    LC_ALL: cfg.lang || 'zh_TW.UTF-8',
    NOVNC_PORT: String(NOVNC_PORT),
    DISPLAY_MODE: 'desktop',
    TUN_NODE: chosen,
    NET_GUARD: cfg.netGuard === 'off' ? 'off' : 'strict',
    NET_GUARD_STRICT_REGION: cfg.netGuardStrictRegion === false ? '0' : '1',
    INPUT_METHOD: cfg.inputMethod === 'rime' ? 'rime' : 'off',
    WORKSPACE: guestWs,
  };

  if (runtimeProc) { try { runtimeProc.kill(); } catch {} }
  log('start', `spawn: ${backend.id} desktop ` +
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' '));
  const proc = backend.spawnEntry(env);
  runtimeProc = proc;
  try { fs.writeFileSync(lastStartPath(), fp); } catch {}
  proc.stdout.on('data', (b) => log('vm', decodeChunk(b)));
  proc.stderr.on('data', (b) => log('vm!', decodeChunk(b)));
  proc.on('error', (e) => log('vm!', `spawn 失败：${e && e.message}`));
  proc.on('exit', (code) => {
    log('vm', `运行时进程退出 code=${code}`);
    if (runtimeProc === proc) runtimeProc = null;
    if (!stopping) {
      try { if (win && !win.isDestroyed()) win.webContents.send('runtime:exited', { code }); } catch {}
    }
  });

  const host = '127.0.0.1';
  const ready = await waitPort(NOVNC_PORT, 50000, host);
  if (!ready) {
    log('start', '串流桌面 50 秒内未就绪');
    return {
      ok: false,
      error: [
        '虚拟桌面在 50 秒内没有就绪。', '',
        '可以按顺序试：① 点「停止」再「启动」；② 打开「检查报告」看逐项结果；③ 导出诊断包查看日志。',
        `（如果端口 ${NOVNC_PORT} 被占用，先关掉占用它的程序。）`,
      ].join('\n'),
    };
  }
  log('start', `desktop 就绪 host=${host}`);

  // 出口是启动期的关键事实，读 net-guard 预检写的 exit.state，
  // 不再自己经代理端口探测（TUN 全量接管后没有那个端口了）。
  const exit = await readExitState();
  if (exit && exit.ip) {
    notes.push(`当前出口：${[exit.ip, exit.city, exit.org].filter(Boolean).join(' · ')}`);
  }
  const guard = await readNetGuard();
  if (guard) {
    if (guard.state === 'blocked') warnings.push(`网络守卫：${guard.message || guard.reason || '预检未通过，网络保持切断'}`);
    else if (guard.state === 'off') warnings.push('网络熔断已关闭：内核异常时流量可能直连出网，存在暴露真实环境的风险。');
    else if (guard.state === 'guarded') notes.push(`网络已锁定：内核 → 节点 ${chosen}，内核退出即断网。`);
  }
  for (const n of notes) log('note', n);
  for (const w of warnings) log('warn', w);
  return { ok: true, imported: imp.imported, host, notes, warnings, exit, guard };
}

// 读取 /run/claude-vm/net-guard.state（KV）。守卫的全部结论都落在这里：
// state=guarded|blocked|proxy_down|off、reason、message、exit_ip、ts 心跳。
async function readNetGuard() {
  try {
    const r = await runWsl(['bash', '-c',
      'cat /run/claude-vm/net-guard.state 2>/dev/null'], { timeout: 12000 });
    const out = {};
    for (const line of String(r.stdout || '').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
    return out.state ? out : null;
  } catch { return null; }
}

// 启动预检写下的真实出口（KV），供启动结果直接呈现给用户。
async function readExitState() {
  try {
    const r = await runWsl(['bash', '-c',
      'cat /run/claude-vm/exit.state 2>/dev/null'], { timeout: 12000 });
    const out = {};
    for (const line of String(r.stdout || '').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out.ip ? { ip: out.ip, city: out.city || '', org: out.org || '' } : null;
  } catch { return null; }
}

''',
    'startRuntime + 状态读取')

# ---------------------------------------------------------------- 10. checkEnv / 删 WSLg 窗口
between(
    '// 自检：优先取结构化 JSON',
    '// ---------- IPC ----------',
    r'''// 自检：优先取结构化 JSON（独立报告窗口按维度渲染），失败则回退到纯文本。
// 检查报告在独立窗口里跑，不影响主窗口的串流桌面使用。
async function checkEnv() {
  if (!(await distroExists())) {
    return { ok: false, needStart: true,
      error: '虚拟环境还没有创建。\n请先点「启动虚拟环境」，等桌面出现后再运行检查。' };
  }
  const run = (extra) => runWsl(['/opt/scripts/check-env.sh', ...extra], { timeout: 120000 });
  const r = await run(['--json']);
  const raw = (r.stdout + '\n' + r.stderr).trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      const data = JSON.parse(raw.slice(s, e + 1));
      if (data && Array.isArray(data.groups)) {
        const sm = data.summary || {};
        log('check', `检查 通过 ${sm.pass || 0} / 注意 ${sm.warn || 0} / 失败 ${sm.fail || 0}`);
        return { ok: true, data, raw };
      }
    } catch { /* 落到文本回退 */ }
  }
  const t = await run([]);
  const text = (t.stdout + '\n' + t.stderr).trim();
  if (!text) {
    return { ok: false, needStart: true,
      error: '检查脚本没有返回任何输出，虚拟环境可能未在运行。' };
  }
  return { ok: false, out: text, error: '检查脚本版本较旧，暂时以原始输出显示。' };
}

''',
    'checkEnv')

# ---------------------------------------------------------------- 11. IPC 段
between(
    "ipcMain.handle('config:get'",
    "ipcMain.handle('workspace:pick'",
    r'''ipcMain.handle('config:get', () => {
  const firstRun = !fs.existsSync(cfgPath());
  const cfg = mergeCfg(loadConfig());
  // 画像列表与节点列表由主进程给渲染层，避免两边各写一份常量分叉。
  let nodes = [];
  let yamlSource = '';
  const y = tunConfig.readClashYaml(cfg, userDir());
  if (y.ok) {
    nodes = tunConfig.extractNodes(y.text);
    yamlSource = y.source;
  }
  return { ...cfg, _firstRun: firstRun, _platform: process.platform,
    _personas: personas.list, _nodes: nodes, _yamlSource: yamlSource };
});
ipcMain.handle('config:save', (_e, cfg) => { saveConfig(cfg); return { ok: true }; });

// 列出当前 YAML 里的节点（导入后 / 订阅更新后刷新下拉用）。
ipcMain.handle('clash:nodes', async () => {
  const y = tunConfig.readClashYaml(loadConfig(), userDir());
  if (!y.ok) return { ok: false, error: y.error, nodes: [] };
  return { ok: true, nodes: tunConfig.extractNodes(y.text), source: y.source };
});

// 选择外部 Clash/Mihomo YAML：用户继续用自己的工具编辑订阅，这里只读不改写。
ipcMain.handle('clash:pick', async () => {
  let r;
  try {
    r = await dialog.showOpenDialog({
      title: '选择 Clash / Mihomo YAML 配置',
      properties: ['openFile'],
      filters: [
        { name: 'Clash YAML', extensions: ['yaml', 'yml'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const p = r.filePaths[0];
  try {
    const text = fs.readFileSync(p, 'utf8');
    const v = tunConfig.validateClashYaml(text);
    if (!v.ok) return { ok: false, error: v.error, path: p };
    tunConfig.cacheClashYaml(text, userDir());
    return { ok: true, path: p, nodes: v.nodes, warnings: v.warnings || [] };
  } catch (e) {
    return { ok: false, error: `读取失败：${String(e && e.message || e)}`, path: p };
  }
});

// 剪贴板必须由主进程做：Electron 20+ 的 preload 在 sandbox 里跑，
// 只能拿到 contextBridge / ipcRenderer / webFrame，clipboard 是 undefined。
ipcMain.handle('clip:read', () => { try { return clipboard.readText(); } catch { return ''; } });
ipcMain.handle('clip:write', (_e, t) => { try { clipboard.writeText(String(t == null ? '' : t)); } catch {} return true; });

ipcMain.handle('runtime:status', async () => {
  const imported = await distroExists();
  const running = imported && ((await waitPort(NOVNC_PORT, 800)) || !!runtimeProc);
  return { imported, running };
});
ipcMain.handle('runtime:start', async (e, cfg) => {
  saveConfig(cfg);
  const send = (msg) => { try { e.sender.send('runtime:progress', msg); } catch {} };
  return startRuntime(cfg, send);
});
ipcMain.handle('runtime:stop', async () => stopRuntime());
// 一键重置 = 销毁旧环境 + 立即重建启动，封号后不用手动点两次
ipcMain.handle('runtime:reset', async (e, cfg) => {
  const reset = await resetRuntime();
  if (!reset.ok) return reset;
  const nextCfg = saveConfig(cfg || loadConfig());
  const send = (msg) => { try { e.sender.send('runtime:progress', msg); } catch {} };
  send('旧环境已销毁，正在生成全新环境…');
  return startRuntime(nextCfg, send);
});
ipcMain.handle('runtime:check', async () => checkEnv());
// 网络守卫状态（fail-closed 熔断 / 内核存活 / 预检结论），主界面轮询用
ipcMain.handle('net:status', async () => readNetGuard());
ipcMain.handle('wsl:probe', async () => probeWsl());

// ---------- 独立检查报告窗口 ----------
let reportWin = null;
function createReportWindow() {
  if (reportWin && !reportWin.isDestroyed()) {
    reportWin.focus();
    return { ok: true, reused: true };
  }
  reportWin = new BrowserWindow({
    width: 940, height: 760,
    minWidth: 720, minHeight: 520,
    backgroundColor: '#14161a',
    title: 'Claude VM · 环境检查报告',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  reportWin.setMenuBarVisibility(false);
  reportWin.loadFile(path.join(__dirname, 'renderer', 'report.html'));
  reportWin.on('closed', () => { reportWin = null; });
  return { ok: true };
}
ipcMain.handle('report:open', async () => createReportWindow());
// 报告导出：把渲染层排好版的 HTML 直接落盘，避免主进程再渲染一次。
ipcMain.handle('report:export', async (_e, html) => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const r = await dialog.showSaveDialog(reportWin || win, {
    title: '保存环境检查报告',
    defaultPath: path.join(app.getPath('downloads'), `claude-vm-report-${stamp}.html`),
    filters: [{ name: 'HTML 报告', extensions: ['html'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, String(html || ''), 'utf8');
    log('report', `导出检查报告 → ${r.filePath}`);
    return { ok: true, file: r.filePath };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
});

''',
    'IPC 段')

# ---------------------------------------------------------------- 12. 诊断包
once(
    "  parts.push(`${process.platform === 'darwin' ? 'macOS' : 'Windows'} ${process.getSystemVersion()} ｜ ${process.arch} ｜ 后端 ${backend.id} ｜ 显示模式 ${cfg.displayMode === 'desktop' ? 'desktop(noVNC)' : 'wslg'}`);",
    "  parts.push(`${process.platform === 'darwin' ? 'macOS' : 'Windows'} ${process.getSystemVersion()} ｜ ${process.arch} ｜ 后端 ${backend.id} ｜ 串流桌面(noVNC)`);",
    '诊断包显示模式')
once(
    "  parts.push(JSON.stringify({ ...cfg, proxy: redact(cfg.proxy) }, null, 2));",
    "  parts.push(JSON.stringify(cfg, null, 2));",
    '诊断包去掉 proxy')

# ---------------------------------------------------------------- 13. personas require
once(
    "const tunConfig = require('./lib/tun-config');",
    "const tunConfig = require('./lib/tun-config');\nconst personas = require('./lib/personas');",
    '引入 personas')

with open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print(f'OK: {count} 处替换完成，main.js 现 {len(s.splitlines())} 行')
