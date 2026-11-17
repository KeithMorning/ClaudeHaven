'use strict';
// Claude VM 桌面主进程
// 负责：窗口、配置持久化、通过 WSL 管理 Linux 运行时（导入/启动/停止/自检）
const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execFile, spawn } = require('child_process');
// 平台后端：Windows → WSL2，macOS/Linux → 容器（Docker/OrbStack）。
// 平台差异全部收敛在 lib/vm-backend.js，本文件不再直接碰 wsl.exe 之外的平台 API。
// 注意：必须取 getBackend() 的**实例** —— 方法（runGuest/ensureImage/…）挂在实例上，
// 只 require 模块拿到的是导出表，调用会直接 TypeError（1.0.32 就是这么把启动搞挂的）。
const backend = require('./lib/vm-backend').getBackend();
const tunConfig = require('./lib/tun-config');
const personas = require('./lib/personas');
const guestCmd = require('./lib/guest-cmd');

const DISTRO = 'claude-vm';
const NOVNC_PORT = 6080;
const VNC_PASS = 'claudevm';
// App Icon：矢量真源在 renderer/assets/app-icon.svg（顶栏用），
// 这份 PNG 是同一套几何的位图导出，给 BrowserWindow / 任务栏 / 安装包用
// （Electron 的 icon 与 electron-builder 都不接受 SVG）。它随 asar 一起打包。
const APP_ICON = path.join(__dirname, 'renderer', 'assets', 'app-icon.png');
// 运行时脚本 / 界面资源有变更时 +1。它进配置指纹，保证升级后第一次点「启动」
// 不会去「接管」一个由旧脚本拉起的会话 —— 那些会话里的 openbox、entrypoint、
// 字体、内核配置全是旧版的，接管等于永远不生效。
const RUNTIME_REV = 19;
let win = null;
let runtimeProc = null;
// 主动停止/退出时收到的 exit 不是异常，不该弹「意外退出」提示
let stopping = false;

// ---------- 单实例 ----------
// 双击两次图标不该起两套运行时去抢同一个发行版和 6080 端口 ——
// 那种情况表现成「白屏 / 连不上」，用户完全没法自己看出来。
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// ---------- 路径与配置 ----------
const userDir = () => app.getPath('userData');
const cfgPath = () => path.join(userDir(), 'config.json');
const dataDir = () => path.join(userDir(), 'runtime');
// 上次「成功拉起桌面」时用的配置指纹。用来判断现在这台虚拟机是不是就按这份配置起的 ——
// 是的话，重复点「启动」应当直接接管，而不是先杀掉整台 VM 再重建。
const lastStartPath = () => path.join(userDir(), 'last-start.json');

// ---------- 日志 ----------
// 运行时是 spawn 出去的 wsl.exe，以前用 stdio:'ignore' 把它的输出全丢了 ——
// 出问题只能靠用户截图猜。现在统一落盘，诊断包也读这里。
const logDir = () => path.join(userDir(), 'logs');
const logFile = () => path.join(logDir(), 'vm.log');
let logStream = null;

function rotateLogs() {
  try {
    const files = fs.readdirSync(logDir())
      .filter((f) => /^vm-\d+\.log$/.test(f))
      .sort()
      .reverse();
    files.slice(2).forEach((f) => { try { fs.unlinkSync(path.join(logDir(), f)); } catch {} });
  } catch {}
}

function openLog() {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const f = logFile();
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    if (size > 4 * 1024 * 1024) {
      try { fs.renameSync(f, path.join(logDir(), `vm-${Date.now()}.log`)); } catch {}
      rotateLogs();
    }
    logStream = fs.createWriteStream(f, { flags: 'a' });
  } catch { logStream = null; }
}

// wsl.exe 自己的消息是 UTF-16LE（带大量 \0），Linux 程序的输出是 UTF-8 —— 混在一起
function decodeChunk(buf) {
  const head = buf.subarray(0, Math.min(256, buf.length));
  if (head.includes(0)) {
    try { return buf.toString('utf16le'); } catch {}
  }
  return buf.toString('utf8');
}

function log(tag, msg) {
  const body = String(msg == null ? '' : msg).replace(/\s+$/, '');
  if (!body) return;
  const line = `[${new Date().toISOString()}] [${tag}] ${body}`;
  try { if (logStream) logStream.write(line + '\n'); } catch {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; }
}

function mergeCfg(saved) {
  const c = { ...defaultConfig(), ...saved };
  c.netGuard = 'strict';
  c.inputMethod = 'rime';
  // 2.0：tz / lang 不再是配置字段，一律由 lib/personas.js 从 persona 派生。
  // 1.0.x 的 config.json 里残留 tz=America/Los_Angeles 之类旧值，若不清洗会
  // 和画像（us → America/New_York）分叉：日志 spawn 用旧时区，报告显示新画像。
  delete c.tz;
  delete c.lang;
  // 读出来就收敛成规范路径：界面里显示的、以及后续算指纹用的都是同一个值
  if (c.workspace) c.workspace = normalizeWinPath(c.workspace);
  return c;
}
// 路径里混进多余的斜杠（粘贴、转义、手打都可能）会让指纹每次都不一样，
// 进而被当成「配置已变更」反复重建虚拟机。写盘前统一收敛成规范形式。
function normalizeWinPath(p) {
  const s = String(p || '').trim();
  if (!s) return s;
  // POSIX 路径（macOS / Linux 工作区）：只收敛重复斜杠，
  // 不能做下面的反斜杠替换 —— /Users/x 会被改成 \Users\x，指纹和挂载全错。
  if (s.startsWith('/')) return s.replace(/\/{2,}/g, '/').replace(/^(.+)\/$/, '$1');
  const unified = s.replace(/\//g, '\\');
  // UNC（\\server\share）要保留开头两个反斜杠
  if (/^\\\\./.test(unified)) return '\\\\' + unified.replace(/^\\+/, '');
  return unified.replace(/\\{2,}/g, '\\');
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  const clean = { ...cfg };
  // tz / lang 是画像派生值，不写盘（旧版 config.json 里的残留由 mergeCfg 清掉）
  delete clean.tz;
  delete clean.lang;
  if (clean.workspace) clean.workspace = normalizeWinPath(clean.workspace);
  fs.writeFileSync(cfgPath(), JSON.stringify(clean, null, 2));
  return clean;
}

function defaultConfig() {
  return {
    // 伪装画像：只有两套，见 lib/personas.js。tz / lang / locale 全由画像派生，
    // 不落盘 —— 存两份就会分叉。切画像会进配置指纹，强制重建会话。
    persona: 'tw-taipei',
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
    inputMethod: 'rime',
  };
}

function rootfsPath() {
  const dev = path.join(__dirname, '..', 'runtime', 'rootfs.tar.gz');
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, 'rootfs.tar.gz');
}

// 运行时脚本目录：打包后在 resources/scripts，开发时在 runtime/scripts
function scriptsDir() {
  const dev = path.join(__dirname, '..', 'runtime', 'scripts');
  if (fs.existsSync(dev)) return dev;
  const packed = path.join(process.resourcesPath, 'scripts');
  if (fs.existsSync(packed)) return packed;
  return null;
}

// 界面资源目录：串流页 / 欢迎页这些也会随版本改动，必须和脚本一起更新，
// 否则用户装新版后看到的还是镜像里那份旧页面。
function assetsDir() {
  const dev = path.join(__dirname, '..', 'runtime', 'assets');
  if (fs.existsSync(dev)) return dev;
  const packed = path.join(process.resourcesPath, 'assets');
  if (fs.existsSync(packed)) return packed;
  return null;
}

// 把最新的 entrypoint / tun-core / check-env 同步进已导入的发行版。
// 否则用户装过旧版后，发行版里一直是旧脚本，改了也生效不了。
async function syncScripts() {
  const dir = scriptsDir();
  if (!dir) return { ok: false, reason: 'scripts-missing' };
  const manifest = guestCmd.localScriptManifest(dir);
  if (!manifest.size) return { ok: false, reason: 'scripts-empty' };

  // guest 侧路径由后端给：WSL 是 /mnt/c/...，容器是只读挂载点 /mnt/sync-scripts
  const wslDir = backend.guestScriptsPath(dir);
  const asDir = assetsDir();
  // 资源拷到 /opt/assets，由 entrypoint 覆盖到 /usr/share/novnc 等最终位置。
  // 注意不要以分号结尾（下面按行 join，多一个分号会变成 ';;' —— bash 语法错误）。
  const assetsCmd = asDir
    ? `mkdir -p /opt/assets && cp -rf '${backend.guestAssetsPath(asDir)}/.' /opt/assets/ 2>/dev/null`
    : '';
  // openbox 配置热更新：把**旧版回退源**一并更新，否则 entrypoint 每次启动又覆盖回旧版
  // （1.0.27 的教训：装了新版仍点不动标题栏 ✕）。
  const openboxHotfix = [
    'if [ -f /opt/assets/novnc/desktop.html ]; then',
    'cp -f /opt/assets/novnc/desktop.html /usr/share/novnc/desktop.html || exit 1;',
    'fi;',
    'if [ -f /opt/assets/config/openbox-rc.xml ]; then',
    'mkdir -p /root/.config/openbox;',
    'cp -f /opt/assets/config/openbox-rc.xml /root/.config/openbox/rc.xml;',
    'cp -f /opt/assets/config/openbox-rc.xml /opt/config/openbox-rc.xml;',
    "pgrep -x openbox >/dev/null 2>&1 && DISPLAY=:1 openbox --reconfigure >/dev/null 2>&1 || true;",
    'fi',
  ].join(' ');

  // 坑 23：命令内联进 `bash -c` 时 $f / $(basename) 会被 wsl.exe 吞掉，cp 静默全失败、
  // 末尾 SYNCED 照常打印 → 假绿。整段脚本 base64 后交管道给 bash，并逐文件核对 md5。
  const script = guestCmd.buildSyncScript({
    scriptsPath: wslDir,
    assetsCmd,
    openboxCmd: openboxHotfix,
    remove: ['proxy-router.js'],
  });
  const r = await runWsl(guestCmd.bashViaBase64(script), { timeout: 30000 });
  const result = guestCmd.verifySync(r.stdout, manifest);
  if (!result.ok) {
    log('start', `运行时脚本同步未通过：${result.reason}${result.detail ? ` · ${result.detail}` : ''}`);
  }
  return result;
}

// Windows 路径 -> WSL 内 /mnt/x/... 路径
function toWslPath(p) {
  if (!p) return '';
  const s = p.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
  return s;
}

// ---------- WSL 调用 ----------
// 名字保留 runWsl（测试切片按此名注入桩），语义已是「在 guest 内执行命令」：
// args 为 guest 内 argv（如 ['bash', '-c', sh]），由后端翻译成 wsl.exe / docker exec。
// 历史调用形如 ['bash', '-c', sh]，1.0.32 起
// 只传 guest 部分，平台前缀由 lib/vm-backend.js 拼。
function runWsl(args, opts = {}) {
  return backend.runGuest(args, opts);
}

// WSL / 容器运行时可用性预检：区分「根本没装」与「装了但跑不起来」
async function probeWsl() {
  return backend.probe();
}


function cleanWslList(s) {
  return s.replace(/\0/g, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

async function distroExists() {
  return backend.imageExists();
}

function waitPort(port, timeoutMs, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const s = net.connect(port, host);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tick, 700);
      });
    };
    tick();
  });
}

// ---------- 运行时操作 ----------
async function ensureImported(onProgress) {
  // 后端负责全部差异：WSL 走 wsl --import，容器走 docker import + 实例创建/拉起
  return backend.ensureImage(rootfsPath(), {
    dataDir: dataDir(),
    scriptsDir: scriptsDir(),
    assetsDir: assetsDir(),
    novncPort: NOVNC_PORT,
    onProgress,
  });
}

// 看某个端口在宿主上被谁占着（Windows: netstat+tasklist，macOS/Linux: lsof）
function winPortOwner(port) {
  return backend.hostPortOwner(port);
}

// 启动前确认端口没被别人占：占着的话 noVNC 永远起不来，最后只会报「90 秒未就绪」
async function portConflict(port) {
  const busy = await waitPort(port, 300);
  if (!busy) return null;
  // 可能是我们上一轮留下的发行版还在跑（应用重启但环境没停），那不算冲突
  const probe = await runWsl(['bash', '-c',
    'pgrep -f websockify >/dev/null 2>&1 && echo ours'], { timeout: 15000 });
  if ((probe.stdout || '').includes('ours')) return null;
  return await winPortOwner(port);
}

// ---------- 幂等启动 ----------
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

// 影响运行时行为的配置项。改了任意一项都必须重建，没改就有资格接管。
function cfgFingerprint(cfg) {
  // YAML 内容 + 选中节点都进指纹：用户在外部工具里改了订阅 / 换了节点，
  // 下次点「启动」必须重建会话，不能「接管」还在用旧配置的内核。
  let tun = 'invalid';
  const r = tunConfig.readClashYaml(cfg, userDir());
  if (r.ok) tun = `on:${tunConfig.tunFingerprint(r.text)}:${tunConfig.selectedNode(cfg, r.text)}`;
  // persona 是 tz / lang 的唯一决定项，单独列 tz/lang 只会让旧配置残留把指纹撕裂。
  return JSON.stringify({
    persona: cfg.persona || 'tw-taipei',
    tun,
    ws: cfg.workspace || '',
    // 熔断开关改变的是内核路由表，不能「接管」旧会话
    ng: 'strict',
    // 输入法要重起 fcitx5，同样必须重建会话
    im: 'rime',
    // 脚本/资源修订号：升级后强制重建一次
    rev: RUNTIME_REV,
  });
}

const readLastFingerprint = () => {
  try { return fs.readFileSync(lastStartPath(), 'utf8'); } catch { return ''; }
};

async function startRuntime(cfg, onProgress) {
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
      warnings: resumedSync.ok ? [] : [
        `运行时脚本同步未通过（${resumedSync.reason}），当前会话可能仍用旧脚本；请点「停止」再「启动」。`,
      ],
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
  // 坑 23：旧实现在同步失败时只 push 一条 warning 就继续启动，结果客机跑着
  // 1.0.x 脚本、内核没起来、报告 5 项失败，用户看到的是「已就绪」的假环境。
  // 脚本没落地就绝不放行 —— 与网络 fail-closed 同一条原则。
  const sync = await syncScripts();
  if (!sync.ok) {
    return {
      ok: false,
      error: [
        '运行时脚本同步失败，已中止启动（不允许旧脚本带病运行）。', '',
        `原因：${sync.reason}${sync.detail ? ` · ${sync.detail}` : ''}`, '',
        '通常是 Windows 上的 WSL 参数传递或 /opt/scripts 不可写。',
        '请点「停止」再「启动」重试；仍失败可用「一键环境重置」重建发行版。',
      ].join('\n'),
    };
  }

  // 把外部 YAML 注入客机，交给容器内的 mihomo 内核。
  // base64 分块：Windows execFile 命令行上限 32767 字符，订阅 YAML 动辄 100KB+；
  // 且 YAML 里的引号/$/反斜杠会把 bash -c 拼坏。每块只含 A-Za-z0-9+/=，单引号内绝对安全。
  const prep = await runWsl(['bash', '-c',
    'mkdir -p /opt/config && rm -f /opt/config/clash.yaml /opt/config/mihomo.yaml'], { timeout: 15000 });
  if (!prep.ok) return { ok: false, error: '无法准备虚拟环境配置目录，已中止启动。' };
  for (const part of tunConfig.base64Chunks(y.text)) {
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
  // 2.0：环境语言/时区唯一来源 = 画像。配置里不再存 tz / lang，
  // 旧 config.json 的残留已在 mergeCfg 里清掉，不会再出现「报告纽约、spawn 洛杉矶」。
  const persona = personas.byId(cfg.persona);
  const env = {
    TZ: persona.tz,
    LANG: persona.lang,
    LC_ALL: persona.lang,
    // 浏览器请求头与 UI 语言的唯一真源。以前各客机脚本各自从 LANG 猜，
    // 还有 show-welcome.sh 写死 en-US，结果切换画像后浏览器仍是旧语言（坑 25）。
    CHROME_LANG: persona.chromeLang,
    NOVNC_PORT: String(NOVNC_PORT),
    DISPLAY_MODE: 'desktop',
    TUN_NODE: chosen,
    NET_GUARD: 'strict',
    NET_GUARD_STRICT_REGION: cfg.netGuardStrictRegion === false ? '0' : '1',
    INPUT_METHOD: 'rime',
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

async function stopRuntime() {
  log('stop', '用户点击停止');
  stopping = true;
  // 主动停止是受控收尾：先还原被网络熔断删掉的默认路由。
  // 顺序必须在 kill 之前 —— /run 是 tmpfs，runtimeProc 一停，
  // /run/claude-vm/net-guard.orig（原始路由记录）就随会话消失；
  // 而 `wsl --terminate` 只终止发行版、不重建网络命名空间，
  // 被删的默认路由会残留到下次启动。fail-closed 的「不 unlock」
  // 只针对守卫意外死亡，用户点停止时环境本来就要下线，解锁是安全的。
  try {
    const u = await runWsl(['python3',
      '/opt/scripts/net-guard.py', 'unlock'], { timeout: 12000 });
    log('stop', /"ok":\s*true/.test(u.stdout || '')
      ? '已还原默认路由（熔断解锁）'
      : '熔断解锁跳过：无原始路由记录或脚本缺失（不影响停止）');
  } catch (e) {
    log('stop', `熔断解锁跳过：${e && e.message}`);
  }
  try { if (runtimeProc) { runtimeProc.kill(); runtimeProc = null; } } catch {}
  // 先抹掉就绪标记，再终止实例：否则停掉之后标记还在，
  // 下次启动的 runtimeAlive() 会把已经停掉的环境误判成「还活着」。
  await runWsl(['bash', '-c',
    'rm -f /run/claude-vm/ready'], { timeout: 12000 });
  await backend.stopAll();
  // 环境已经没了，指纹作废 —— 下次必须是真正的重建
  try { fs.unlinkSync(lastStartPath()); } catch {}
  setTimeout(() => { stopping = false; }, 3000);
  return { ok: true };
}

// 一键环境重置：封号后生成一个与旧环境零关联的新环境。
//
// 顺序是硬性的，别调换：
//   [0] 先 stopRuntime —— 它 kill 掉 entrypoint/桌面/终端，再 terminate 实例。
//       必须让客机进程全部退出，再销毁磁盘。若反过来，正在登录的 Claude Code
//       会在进程退出时把内存里的旧账号凭证写回 ~/.claude / ~/.claude.json，
//       等于白清（PDF 第七章「绝不能让登录中的 Claude Code 清理它自己」）。
//   [1] backend.destroyAll —— WSL 用 --unregister 删掉 ext4.vhdx，容器删掉
//       实例 + /root 命名卷。identity / machine-id / Chrome profile / 登录态
//       全部随磁盘消失；stopAll 的 --terminate / docker stop 只停机保数据，不够。
//   [2] 清宿主侧的就绪指纹，避免下次启动误判「环境还活着」而跳过重建。
//   [3] 由调用方决定是否立即 startRuntime —— 重建会从 rootfs 重新生成身份。
// 保留的是：干净的静态出口 IP、YAML 代理配置、工作区目录（它们不含身份）。
async function resetRuntime() {
  log('reset', '用户触发一键环境重置');
  const stopped = await stopRuntime();
  if (stopped && stopped.ok === false) return stopped;

  const destroyed = await backend.destroyAll({ dataDir: dataDir() });
  if (!destroyed.ok) {
    log('reset', `销毁失败：${destroyed.error}`);
    return { ok: false, error: destroyed.error };
  }
  try { fs.unlinkSync(lastStartPath()); } catch {}
  log('reset', '旧环境已销毁：身份、设备 ID、登录态、Chrome profile 全部清除');
  return { ok: true, reset: true };
}

// 自检：优先取结构化 JSON（独立报告窗口按维度渲染），失败则回退到纯文本。
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

// ---------- 自定义标题栏 ----------
// 2.1 UI 改成无边框窗口（frame:false），顶栏的窗口控制按钮由渲染层画，
// 这里只做状态变更；渲染层拿不到 BrowserWindow 引用，也不能直接 require electron。
function notifyWinState() {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('win:state', { maximized: win.isMaximized() });
  } catch {}
}
ipcMain.handle('win:minimize', () => { try { win && win.minimize(); } catch {} return { ok: true }; });
ipcMain.handle('win:maximize', () => {
  try { if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } } catch {}
  const maximized = !!(win && win.isMaximized());
  notifyWinState();
  return { ok: true, maximized };
});
ipcMain.handle('win:close', () => { try { win && win.close(); } catch {} return { ok: true }; });
ipcMain.handle('win:state', () => ({ maximized: !!(win && win.isMaximized()) }));

// 桌面快捷启动器属于虚拟机：VM 内 tint2 的 claude-*.desktop 直接执行
// /opt/scripts/run-*.sh，走 X11 桌面自己的会话，不经过宿主 IPC。
// 宿主因此不再提供客机启动通道 —— 假 Dock 已删除，别再留一个能拉起客机进程的入口。

// ---------- IPC ----------
ipcMain.handle('config:get', () => {
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

// 节点延迟：让客机脚本调 mihomo 的本地控制 API 逐个实测，结果同时落盘给自检读。
// 内核没起 / API 不通时返回 ok=false，界面显示「未测」，绝不编造延迟数字。
// 取 stdout 里最后一个 JSON 对象：WSL 有时会把 `wsl:` 警告混进同一路输出。
ipcMain.handle('nodes:latency', async () => {
  const r = await runWsl(['python3', '/opt/scripts/node-delay.py', '--file'],
    { timeout: 60000 });
  const lines = String(r.stdout || '').split(/\r?\n/)
    .map((s) => s.trim()).filter(Boolean).reverse();
  const raw = lines.find((l) => l.startsWith('{'));
  if (raw) {
    try {
      const out = JSON.parse(raw);
      if (out && typeof out === 'object') return out;
    } catch { /* 落到下面的错误分支 */ }
  }
  return { ok: false, delays: {},
    error: String(r.stderr || r.error || '内核未就绪或控制 API 不可用').trim().slice(0, 200) };
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
    icon: APP_ICON,
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

ipcMain.handle('workspace:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('workspace:open', (_e, p) => { if (p) shell.openPath(p); });

// ---------- 诊断包 ----------
// 目标：用户出问题时点一下，就能把「我看到的东西」原样交出来，
// 而不是靠他描述、我猜。内容全部是本地事实，代理口令先脱敏。
async function buildDiag() {
  const cfg = loadConfig();
  const parts = [];
  parts.push(`Claude VM 诊断包  ${new Date().toISOString()}`);
  parts.push(`应用版本 ${app.getVersion()} ｜ Electron ${process.versions.electron} ｜ Node ${process.versions.node}`);
  parts.push(`${process.platform === 'darwin' ? 'macOS' : 'Windows'} ${process.getSystemVersion()} ｜ ${process.arch} ｜ 后端 ${backend.id} ｜ 串流桌面(noVNC)`);
  parts.push(`数据目录 ${dataDir()}`);
  parts.push('');
  parts.push('--- 配置（口令已脱敏） ---');
  parts.push(JSON.stringify(cfg, null, 2));
  parts.push('');
  parts.push('--- 运行时实例 ---');
  parts.push((await backend.diagInfo()) || '(无)');
  parts.push('');
  parts.push(`--- 端口 ${NOVNC_PORT} ---`);
  const owner = await winPortOwner(NOVNC_PORT);
  parts.push(owner ? `${owner.name} (PID ${owner.pid})  ${owner.line}` : '未监听');
  parts.push('');
  parts.push('--- 环境自检（--json） ---');
  try {
    const c = await checkEnv();
    parts.push((c && (c.raw || c.error)) || '（无输出）');
  } catch (e) {
    parts.push(`自检失败：${e && e.message}`);
  }
  parts.push('');
  parts.push('--- 日志（末尾 400 行） ---');
  try {
    const lines = fs.readFileSync(logFile(), 'utf8').split(/\r?\n/);
    parts.push(lines.slice(-400).join('\n'));
  } catch {
    parts.push('（暂无日志）');
  }
  return parts.join('\n');
}

ipcMain.handle('diag:export', async () => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const r = await dialog.showSaveDialog(win, {
    title: '保存诊断包',
    defaultPath: path.join(app.getPath('downloads'), `claude-vm-diag-${stamp}.txt`),
    filters: [{ name: '文本文件', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, await buildDiag(), 'utf8');
    log('diag', `导出诊断包 → ${r.filePath}`);
    return { ok: true, file: r.filePath };
  } catch (e) {
    log('diag', `导出失败：${e && e.message}`);
    return { ok: false, error: e && e.message };
  }
});
ipcMain.handle('diag:openLogs', () => { try { shell.openPath(logDir()); } catch {} return { ok: true }; });
// 只把内容返回给渲染层，不弹保存框（自测/预览用，也方便以后做「复制诊断信息」）
ipcMain.handle('diag:preview', async () => ({ ok: true, text: await buildDiag() }));

// ---------- 窗口 ----------
function createWindow() {
  // 窗口默认尺寸按屏幕来，别再写死 1280x860 —— 那比大多数屏幕的可用区域还小，
  // 桌面会被迫在这么小的画布里显示，用户第一眼就觉得「不如本机」。
  // 取工作区的 82%/86%（避开任务栏与侧栏），上限 1600x1000。
  let winW = 1440, winH = 900;
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    winW = Math.min(1600, Math.max(1100, Math.round(wa.width * 0.82)));
    winH = Math.min(1000, Math.max(700, Math.round(wa.height * 0.86)));
  } catch {}

  win = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#14161a',
    icon: APP_ICON,
    title: 'Claude VM',
    // 2.1：顶栏由渲染层自绘（设计稿里的 logo / 运行中徽章 / 导航 / 窗口控制），
    // 系统标题栏会多出一条与深色框架不搭的白边。窗口控制走上面的 win:* IPC，
    // 顶栏设 -webkit-app-region: drag 保证仍可拖动；resizable 保持默认 true。
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.on('maximize', notifyWinState);
  win.on('unmaximize', notifyWinState);
  // 光隐藏菜单栏不够：Electron 默认菜单的加速键仍然生效，于是虚拟机里按 Ctrl+W
  //（Chrome 关标签页）会直接把整个应用关掉、连带杀掉 VM；Ctrl+R / Ctrl+Shift+I 同理。
  // 这是「像在自己电脑上一样用」最直接的破坏，所以整份菜单直接摘掉。
  try { Menu.setApplicationMenu(null); } catch {}
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  if (!gotSingleLock) return;                 // 第二个实例：直接退出，不再建窗口
  openLog();
  log('app', `启动 v${app.getVersion()}｜Electron ${process.versions.electron}｜${process.getSystemVersion()}`);
  // 应用自身的 webview 只访问 localhost，强制直连，避免系统代理把 127.0.0.1 也代理掉
  try { await session.defaultSession.setProxy({ mode: 'direct' }); } catch {}
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  log('app', '退出');
  stopping = true;
  try { if (runtimeProc) runtimeProc.kill(); } catch {}
});
