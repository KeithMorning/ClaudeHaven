'use strict';
// L2 静态一致性测试：不运行任何环境，只验证「仓库里的东西是对的」。
// 这一层是本项目最便宜的回归防线 —— 历史上 15 个坑里大半能在这里拦住：
//   坑 12 openbox Close context、坑 13 两侧脚本漂移 / RUNTIME_REV、
//   坑 14 entrypoint 兜底与输入法位置、坑 15 stopRuntime 顺序。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, MAIN_SRC, readRel, existsRel, loadSegment } = require('../loader');

const VM_SCRIPTS = path.join(ROOT, 'claude-vm', 'vm', 'scripts');
const RUNTIME_SCRIPTS = path.join(ROOT, 'claude-desktop', 'runtime', 'scripts');
const VM_ASSETS = path.join(ROOT, 'claude-vm', 'vm', 'assets');
const RUNTIME_ASSETS = path.join(ROOT, 'claude-desktop', 'runtime', 'assets');

function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }
function scriptFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(sh|py|js)$/.test(f)) : null;
}

// 克隆后的机器上 runtime/scripts 不存在（被 .gitignore 排除，构建时由 sync-scripts 生成）。
// 测试在这里自动补一次同步，让一致性检查在任何机器上都能跑。
test('前置：runtime/scripts 缺失时自动同步（克隆后首次跑测试）', () => {
  const files = scriptFiles(RUNTIME_SCRIPTS);
  if (files && files.length > 0) return;
  const r = spawnSync(process.execPath, ['scripts/sync-scripts.js'], {
    cwd: path.join(ROOT, 'claude-desktop'), encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `sync-scripts 失败:\n${r.stdout}\n${r.stderr}`);
  assert.ok((scriptFiles(RUNTIME_SCRIPTS) || []).length > 0, '同步后仍为空');
});

test('坑 13：镜像与打包副本的运行时脚本逐字节一致（修复在包里 ≠ 修复在环境里）', () => {
  const names = scriptFiles(VM_SCRIPTS);
  assert.ok(names.length >= 15, `镜像脚本数量异常: ${names.length}`);
  for (const f of names) {
    const a = fs.readFileSync(path.join(VM_SCRIPTS, f));
    const b = fs.readFileSync(path.join(RUNTIME_SCRIPTS, f));
    assert.ok(a.equals(b), `claude-vm/vm/scripts/${f} 与 claude-desktop/runtime/scripts/${f} 不一致 —— 打包会带上旧脚本`);
  }
});

test('坑 13：副本里不得出现真源之外的脚本（防手改副本漂移）', () => {
  const vm = new Set(scriptFiles(VM_SCRIPTS));
  const extra = scriptFiles(RUNTIME_SCRIPTS).filter((f) => !vm.has(f));
  assert.deepStrictEqual(extra, [], `真源在 claude-vm/vm/scripts/，副本里出现未知文件: ${extra.join(', ')}`);
});

test('界面资源按 sync-scripts 清单逐字节一致（单一真源，清单本身即 spec）', () => {
  // 从 sync-scripts.js 提取 ASSETS 映射表，避免测试与实现双份维护
  const syncSrc = readRel('claude-desktop/scripts/sync-scripts.js');
  const pairs = [...syncSrc.matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 6, `ASSETS 清单数量异常: ${pairs.length}`);
  for (const [from, to] of pairs) {
    const src = path.join(ROOT, 'claude-vm', 'vm', from);
    assert.ok(fs.existsSync(src), `清单源缺失: claude-vm/vm/${from}`);
    const dst = path.join(RUNTIME_ASSETS, to);
    assert.ok(fs.existsSync(dst), `副本缺失: runtime/assets/${to}（先跑 npm run sync-scripts）`);
    const a = fs.readFileSync(src);
    const b = fs.readFileSync(dst);
    assert.ok(a.equals(b), `资源不一致: claude-vm/vm/${from} ≠ runtime/assets/${to}`);
  }
});

// ---------- 工具可用性（缺失则相应检查跳过） ----------
function findTool(candidates, probeArgs) {
  for (const c of candidates) {
    try {
      const r = spawnSync(c, probeArgs, { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return c;
    } catch { /* 继续 */ }
  }
  return null;
}
const BASH = findTool(['bash', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'], ['-c', 'echo ok']);
const PYTHON = findTool(['python', 'python3'], ['-c', 'print("ok")']);

test('所有 .sh 语法检查（bash -n）', { skip: !BASH && 'bash 不可用，跳过语法检查' }, () => {
  for (const f of scriptFiles(VM_SCRIPTS).filter((f) => f.endsWith('.sh'))) {
    const r = spawnSync(BASH, ['-n', `claude-vm/vm/scripts/${f}`], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${f} 语法错误:\n${r.stdout}${r.stderr}`);
  }
});

test('坑 24：所有 .sh 不得有「赋值里混入 #」或裸分隔线（bash 会当命令执行）', () => {
  // `GUARD_DIR=# ===` 里的 # 紧跟在 = 后面，bash 不视为注释，
  // 会把 === 当命令跑并报 `command not found`，污染启动日志。
  for (const f of scriptFiles(VM_SCRIPTS).filter((x) => x.endsWith('.sh'))) {
    const src = readRel(`claude-vm/vm/scripts/${f}`);
    assert.doesNotMatch(src, /^[A-Za-z_][A-Za-z0-9_]*=#/m, `${f} 有 VAR=# 垃圾赋值`);
    assert.doesNotMatch(src, /^={5,}\s*$/m, `${f} 有裸分隔线（缺 # 前缀）`);
  }
});

test('坑 24：node_names 与宿主 extractNodes 保持同构（防两边解析分叉）', () => {
  const py = readRel('claude-vm/vm/scripts/tun-merge.py');
  const js = readRel('claude-desktop/app/lib/tun-config.js');
  // 两边都必须按列表项切分（`^\s*-\s+`），并且都支持「name 在项内第二行」。
  // 宿主用组合键 (name|type|server)，客机单独匹配 name —— 各自写法不同但语义必须等价，
  // 所以这里按两边各自的形态断言，另有 unit/tun-merge.test.js 用同一份 YAML 做行为对齐。
  assert.ok(py.includes(String.raw`^\s*-\s+`) && js.includes(String.raw`^\s*-\s+`),
    '两边都要按 `^\\s*-\\s+` 切分列表项');
  assert.match(py, /\^\\s\+name\\s\*:\\s\*/, '客机要能读项内第二行的 name');
  assert.match(js, /\(name\|type\|server\)/, '宿主项内键解析要包含 name');
  assert.match(py, /def node_names/);
  assert.match(py, /node not in names/, '节点不存在必须拒绝，不能静默回落');
});

test('所有 .py 语法检查（ast.parse）', { skip: !PYTHON && 'python 不可用，跳过语法检查' }, () => {
  for (const f of scriptFiles(VM_SCRIPTS).filter((f) => f.endsWith('.py'))) {
    const code = 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())';
    const r = spawnSync(PYTHON, ['-c', code, `claude-vm/vm/scripts/${f}`], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${f} 语法错误:\n${r.stdout}${r.stderr}`);
  }
});

test('openbox 配置可被 XML 解析', { skip: !PYTHON && 'python 不可用，跳过 XML 解析' }, () => {
  const code = 'import sys,xml.etree.ElementTree as ET;ET.parse(sys.argv[1])';
  const r = spawnSync(PYTHON, ['-c', code, 'claude-vm/vm/config/openbox-rc.xml'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `openbox-rc.xml 不是合法 XML:\n${r.stdout}${r.stderr}`);
});

// ---------- 行为规格断言：把「踩过的坑」固化成源码级 spec ----------
const ep = () => readRel('claude-vm/vm/scripts/entrypoint.sh');

test('坑 14：entrypoint 的 wait 有 sleep infinity 兜底（会话猝死）', () => {
  assert.match(ep(), /sleep infinity &/, 'desktop 分支必须挂住 wait，否则任一组件退出即会话死亡');
});

test('坑 14：输入法段位于 DISPLAY=:1 之后（注册到错误 X server）', () => {
  const s = ep();
  const inputSection = s.indexOf('# 2.45) 中文输入法');
  const displayExport = s.indexOf('export DISPLAY=:1');
  assert.ok(inputSection > 0, '找不到输入法段标记 # 2.45)');
  assert.ok(displayExport > 0, '找不到 export DISPLAY=:1');
  assert.ok(inputSection > displayExport, '输入法服务必须在 DISPLAY 确定后启动，否则注册到 WSLg :0');
});

test('坑 14：Chrome 启动前清理 SingletonLock（Profile 被别的主机占用）', () => {
  assert.match(ep(), /SingletonLock/, 'entrypoint 桌面启动段应清陈旧 Chrome 锁');
  const chrome = readRel('claude-vm/vm/scripts/chrome-login.sh');
  assert.match(chrome, /SingletonLock/, 'chrome-login.sh 也要清（桌面图标路径）');
});

test('坑 14：desktop-guard 自愈清单覆盖四个组件', () => {
  const g = readRel('claude-vm/vm/scripts/desktop-guard.sh');
  for (const k of ['Xtigervnc', 'openbox', 'websockify', 'fcitx5-remote']) {
    assert.ok(g.includes(k), `desktop-guard.sh 缺少组件 ${k}`);
  }
});

test('坑 12：openbox 配置用官方 Close context，无错误命名', () => {
  const xml = readRel('claude-vm/vm/config/openbox-rc.xml');
  assert.match(xml, /context name="Close"/);
  assert.doesNotMatch(xml, /context name="CloseButton"/, 'CloseButton 是臆造的 context 名，Openbox 不认');
});

test('坑 15：net-guard.py 的 unlock 报错不再误导「重启会自动恢复」', () => {
  const py = readRel('claude-vm/vm/scripts/net-guard.py');
  assert.doesNotMatch(py, /重启虚拟环境会自动恢复/, 'wsl --terminate 不恢复路由，这句是错的');
  assert.match(py, /wsl --shutdown/, '正确指引应是 wsl --shutdown');
});

test('坑 13：main.js 的 RUNTIME_REV 为正整数并参与指纹', () => {
  assert.match(MAIN_SRC, /const RUNTIME_REV = \d+;/);
  const tunConfig = {
    readClashYaml: () => ({ ok: true, text: 'proxies: []\n' }),
    tunFingerprint: () => 'fp', selectedNode: () => 'n1',
  };
  const { cfgFingerprint } = loadSegment('cfgFingerprint',
    { RUNTIME_REV: 1, tunConfig, userDir: () => '/tmp/u' });
  assert.ok(cfgFingerprint({}).includes('rev'), '指纹必须含 rev，否则升级会接管旧会话');
});

test('坑 13：desktop 存活判定必须查真实进程（不能只看 ready 标记）', () => {
  assert.ok(MAIN_SRC.includes('pgrep -x Xtigervnc'), 'runtimeAlive 应 pgrep 常驻进程');
});

test('坑 15：stopRuntime 先 unlock 再 kill（顺序不可颠倒）', () => {
  const start = MAIN_SRC.indexOf('async function stopRuntime()');
  const end = MAIN_SRC.indexOf('async function checkEnv()');
  assert.ok(start > 0 && end > start, '找不到 stopRuntime 函数体');
  const body = MAIN_SRC.slice(start, end);
  const unlockIdx = body.indexOf("'unlock'");
  const killIdx = body.indexOf('runtimeProc.kill()');
  assert.ok(unlockIdx > 0, 'stopRuntime 应调用 net-guard.py unlock');
  assert.ok(killIdx > unlockIdx, 'unlock 必须先于 runtimeProc.kill()：kill 后 /run 会话消失，原始路由记录就没了');
});

test('2.0：主进程不再有外部代理链路（全量单节点 TUN 是唯一路径）', () => {
  for (const legacy of ['UPSTREAM_PROXY', 'PROXY_MODE', 'PROXY_WHITELIST',
    'resolveUpstream', 'detectProxy', 'wslHostCandidates', 'parseRouteTable',
    'proxy:detect', 'verifyProxyChain', 'local-proxy', 'DEFAULT_WHITELIST']) {
    assert.ok(!MAIN_SRC.includes(legacy), `2.0 不该再有 ${legacy}（宿主代理已退出运行时链路）`);
  }
  assert.ok(!MAIN_SRC.includes('tunMode'), '不该再有 TUN 并存开关');
  assert.ok(!MAIN_SRC.includes('displayMode'), '不该再有显示模式配置');
  assert.match(MAIN_SRC, /TUN_NODE: chosen/, '必须把选中的节点传进客机');
  assert.match(MAIN_SRC, /DISPLAY_MODE: 'desktop'/, '显示模式固定为串流桌面');
});

test('2.0：无 YAML / 无节点一律拒绝启动（没有出口就不放行网络）', () => {
  assert.match(MAIN_SRC, /无法启动：\$\{y\.error\}/, '读不到 YAML 要拦住');
  assert.match(MAIN_SRC, /proxies 里没有可用节点/, '空节点列表要拦住');
  assert.match(MAIN_SRC, /请先在设置里选择一个出口节点/, '没选节点要拦住');
  assert.match(MAIN_SRC, /已不在配置里/, '订阅更新后选中节点失效要拦住');
});

test('2.0：删除了 wslg 专用 IPC 与窗口函数', () => {
  for (const legacy of ['terminal:open', 'terminal:shell', 'auth:status', 'auth:login',
    'openWslgWindow', 'wslg', 'WSLg']) {
    assert.ok(!MAIN_SRC.includes(legacy), `2.0 不该再有 ${legacy}`);
  }
  const pre = readRel('claude-desktop/app/preload.js');
  for (const legacy of ['detectProxy', 'openTerminal', 'openShell', 'authStatus', 'authLogin']) {
    assert.ok(!pre.includes(legacy), `preload 不该再暴露 ${legacy}`);
  }
});

test('2.0：两套伪装画像由 lib/personas.js 单一真源提供', () => {
  assert.ok(existsRel('claude-desktop/app/lib/personas.js'), 'personas.js 必须存在');
  const p = readRel('claude-desktop/app/lib/personas.js');
  assert.match(p, /id: 'tw-taipei'/);
  assert.match(p, /id: 'us'/);
  assert.match(p, /Asia\/Taipei/);
  assert.match(p, /America\/Los_Angeles/);
  assert.doesNotMatch(p, /America\/New_York/, '2.0.3 起美区画像固定为洛杉矶');
  // 只检查可执行行：注释里会解释「为什么不做假噪音」，不该被当成实现
  const pCode = p.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.doesNotMatch(pCode, /canvas|webgl|audio|Canvas|WebGL/i,
    '不做假噪音（防封教程明确要求关掉，开了反而一眼被识破）');
  assert.match(MAIN_SRC, /_personas: personas\.list/, '画像列表由主进程传给渲染层');
  const html = readRel('claude-desktop/app/renderer/index.html');
  assert.ok(!html.includes('id="region"'), '旧的 7 个地区下拉已删除');
  assert.match(html, /id="personaCards"/, '两套画像用卡片呈现');
});

// ---------- 工程基本面 ----------
test('package.json 版本与构建入口完整', () => {
  const pkg = JSON.parse(readRel('claude-desktop/package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '版本号应是 x.y.z');
  assert.ok(pkg.scripts['dist:win'], '必须有 dist:win');
  assert.ok(pkg.scripts['sync-scripts'], '必须有 sync-scripts（pre 钩子依赖它）');
  assert.ok(fs.existsSync(path.join(ROOT, 'claude-desktop', 'app', 'main.js')));
});

test('换行策略：.gitattributes 强制 LF（Linux 脚本防 CRLF 中毒）', () => {
  const ga = readRel('.gitattributes');
  assert.match(ga, /\* text=auto eol=lf/);
  assert.match(ga, /\.sh\s+text eol=lf/);
  assert.match(ga, /\.ttf\s+binary/);
});

test('忽略策略：2.4G 构建缓存被排除，但打包图标放行', () => {
  const gi = readRel('.gitignore');
  assert.match(gi, /claude-desktop\/build\/\*/);
  assert.match(gi, /!claude-desktop\/build\/icon\.png/);
  assert.ok(fs.existsSync(path.join(ROOT, 'claude-desktop', 'build', 'icon.png')), 'icon.png 必须存在，否则克隆后打包失败');
});


test('坑 16：终端启动器走 GTK 原生输入（不再用 xterm / XIM 资源）', () => {
  for (const f of ['run-terminal.sh', 'run-claude.sh']) {
    const src = readRel(`claude-vm/vm/scripts/${f}`);
    // 只检查可执行行：注释里会保留 XIM 的历史说明，不该被当成残留资源
    const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.match(code, /exec lxterminal/, `${f} 应使用 lxterminal`);
    assert.match(code, /--no-remote/, `${f} 应禁用实例复用`);
    assert.doesNotMatch(code, /exec xterm|XTerm\*inputMethod|preeditType/, `${f} 不应残留 XIM 资源`);
  }
});

test('坑 16：rime-setup 按需装 GTK 输入模块与终端（1.0.34 起 fcitx5）', () => {
  const src = readRel('claude-vm/vm/scripts/rime-setup.sh');
  for (const k of ['fcitx5', 'fcitx5-rime', 'fcitx5-frontend-gtk3', 'lxterminal', 'im-fcitx5.so']) {
    assert.ok(src.includes(k), `rime-setup.sh 缺少 ${k}`);
  }
  assert.match(src, /--no-install-recommends/, '不能带进中文字体包（checkcc 字体名单）');
});

test('坑 16：entrypoint 部署 lxterminal 配色配置', () => {
  const src = readRel('claude-vm/vm/scripts/entrypoint.sh');
  assert.match(src, /cp -f \/opt\/config\/lxterminal\.conf ~\/\.config\/lxterminal\//);
});

test('坑 16：自检先查 GTK im module，缺了要给出明确提示', () => {
  const src = readRel('claude-vm/vm/scripts/check-env.sh');
  assert.ok(src.includes('im-fcitx5.so'), '自检应检查 GTK 原生模块');
  assert.ok(src.includes('缺 GTK 输入模块'), '缺失时提示要具体，不能只说服务未就绪');
});

// ---------- 输入法壳换 fcitx5（1.0.34） ----------

test('坑 18：fcitx5 依赖 D-Bus 会话，entrypoint 必须显式起总线', () => {
  const s = ep();
  assert.match(s, /DBUS_SESSION_BUS_ADDRESS/, 'entrypoint 应管理 D-Bus 会话地址');
  assert.match(s, /dbus-launch|dbus-daemon/, '应显式启动 session bus（fcitx5 不能 autolaunch）');
  assert.match(s, /fcitx5-remote/, '就绪探测用 fcitx5-remote（XIM atom 已不适用）');
  assert.match(s, /GTK_IM_MODULE="fcitx"/, 'GTK_IM_MODULE 应指向 fcitx');
});

test('坑 18：fcitx5 启动后必须激活并切 rime（否则按键透传成 ASCII）', () => {
  const s = ep();
  assert.match(s, /fcitx5-remote -o/, '必须显式激活输入法（默认可能是关闭态）');
  assert.match(s, /fcitx5-remote -s rime/, '必须切到 rime 引擎');
});

test('坑 18：D-Bus 就绪必须早于 desktop-guard（guard 探活走 fcitx5-remote）', () => {
  const s = ep();
  const dbusIdx = s.indexOf('export DBUS_SESSION_BUS_ADDRESS');
  const guardIdx = s.indexOf('nohup /opt/scripts/desktop-guard.sh');
  assert.ok(dbusIdx > 0 && guardIdx > 0, '找不到 D-Bus 导出或 guard 启动标记');
  assert.ok(dbusIdx < guardIdx,
    'D-Bus 导出必须在 guard 启动之前，否则 guard 的 fcitx5-remote 永远失败、4 秒一轮杀掉 fcitx5');
});

test('坑 18：万象词库部署在 fcitx5-rime 数据目录，老 ibus 数据可迁移', () => {
  const src = readRel('claude-vm/vm/scripts/rime-setup.sh');
  assert.match(src, /RIME_DIR=\/root\/\.local\/share\/fcitx5\/rime/,
    'fcitx5-rime 的用户数据目录是 ~/.local/share/fcitx5/rime');
  assert.match(src, /OLD_RIME_DIR/, '应迁移 ibus 时代的词库，不能让用户重新编译 146MB');
  assert.match(src, /config\/fcitx5\/profile/, '默认引擎 rime 要写进 fcitx5 profile');
});

// ---------- 平台抽象（1.0.32 起支持 macOS） ----------

test('平台抽象：差异收敛在 vm-backend，main.js 不直接 spawn wsl.exe', () => {
  assert.ok(MAIN_SRC.includes("require('./lib/vm-backend').getBackend()"),
    'main.js 必须绑定 getBackend() 实例 —— 只 require 模块拿不到方法，调用即 TypeError（1.0.32 启动回归的根因）');
  assert.ok(existsRel('claude-desktop/app/lib/vm-backend.js'), 'vm-backend.js 必须存在');
  assert.doesNotMatch(MAIN_SRC, /spawn\('wsl\.exe'/, 'spawn 应走 backend.spawnEntry');
  const vb = readRel('claude-desktop/app/lib/vm-backend.js');
  for (const k of ['pickBackendId', 'createContainerBackend', 'createWslBackend', 'getBackend']) {
    assert.ok(vb.includes(k), `vm-backend.js 缺少 ${k}`);
  }
});

test('平台抽象：容器模式 noVNC 发布到 0.0.0.0（websockify 绑回环会连不上）', () => {
  const vb = readRel('claude-desktop/app/lib/vm-backend.js');
  assert.match(vb, /NOVNC_BIND: '0\.0\.0\.0'/);
  assert.match(ep(), /\$\{NOVNC_BIND:-127\.0\.0\.1\}/, 'entrypoint 必须尊重 NOVNC_BIND');
});

test('工程基本面：dist:mac 构建入口存在（macOS 支持）', () => {
  const pkg = JSON.parse(readRel('claude-desktop/package.json'));
  assert.ok(pkg.scripts['dist:mac'], '必须有 dist:mac');
});

test('坑 17：entrypoint 必须重设 XDG_RUNTIME_DIR（WSLg 目录属主不匹配会卡死 GTK）', () => {
  const s = ep();
  assert.match(s, /export XDG_RUNTIME_DIR=\/tmp\/claude-vm-runtime/,
    'root 会话必须用自己属主的运行时目录，否则 GTK3 应用窗口永不出现');
  assert.match(s, /chmod 700 "\$XDG_RUNTIME_DIR"/);
  assert.match(s, /echo "export XDG_RUNTIME_DIR=/, '落盘 runtime-env 供菜单启动的应用继承');
});

// ---------- 候选窗字形（1.0.35） ----------

test('坑 19：rime-setup 必须装覆盖 CJK 扩展 B 区的字体（否则候选窗画方框）', () => {
  const s = readRel('claude-vm/vm/scripts/rime-setup.sh');
  // 只检查可执行行：注释里会解释「为什么禁用 fonts-noto-cjk-extra」，不该被当成实际安装
  const code = s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(code, /fonts-hanazono/, '缺了它 U+20000+ 生僻候选无字形');
  assert.match(code, /fc-list ':charset=20000'/, 'need 检查应按「码位有没有字体覆盖」判定');
  assert.match(code, /fc-cache -f/, '装完必须刷新 fontconfig 缓存');
  assert.doesNotMatch(code, /fonts-noto-cjk-extra/,
    '214MB 且家族名 "Noto Sans CJK SC/TC" 命中 checkcc 名单，不能用');
});

test('坑 19：自检字体名单未因新增字体而放松', () => {
  const s = readRel('claude-vm/vm/scripts/check-env.sh');
  assert.ok(s.includes('Noto Sans CJK SC') && s.includes('WenQuanYi Micro Hei'),
    '指纹名单必须保持完整，换字体不能靠删名单蒙混');
  assert.doesNotMatch(s, /Hanazono|HanaMin|花園明朝/, '自检不该把合规字体误列入名单');
});

// ---------- 零候选时候选窗消失（1.0.36） ----------

test('坑 20：rime-setup 必须关闭 client preedit（否则 ffff 时候选窗 unmap、退格全盲）', () => {
  const s = readRel('claude-vm/vm/scripts/rime-setup.sh');
  // 只检查可执行行，注释里会解释这个配置项的来历
  const code = s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(code, /\/root\/\.config\/fcitx5\/config/, '必须写 fcitx5 全局配置');
  assert.match(code, /\[Behavior\]/, '配置段是 [Behavior]');
  assert.match(code, /PreeditEnabledByDefault=False/,
    '关掉「在应用中显示预编辑」才能让 classicui 在零候选时保持窗口可见');
});

test('坑 20：page_size 保持 6（万象 7890 是声调键，不是选字键）', () => {
  const s = readRel('claude-vm/vm/scripts/rime-setup.sh');
  assert.match(s, /page_size: 6/, 'page_size 必须为 6');
  assert.doesNotMatch(s, /page_size: 9/, '改成 9 会让第 7~9 个候选按数字选不中');
});

// ---------- 一键环境重置（封号后换全新身份） ----------

test('坑 21：重置必须先停会话再销毁磁盘，顺序反了会白清', () => {
  const s = readRel('claude-desktop/app/main.js');
  const stopAt = s.indexOf('const stopped = await stopRuntime();');
  const destroyAt = s.indexOf('const destroyed = await backend.destroyAll(');
  assert.ok(stopAt > 0 && destroyAt > stopAt,
    '运行中的 Claude Code 退出时会把内存旧凭证写回 ~/.claude，必须先停再销毁');
  assert.match(s, /fs\.unlinkSync\(lastStartPath\(\)\)/,
    '销毁后必须清宿主就绪指纹，否则下次启动误判环境还活着而跳过重建');
});

test('坑 21：重置按钮必须有显式二次确认', () => {
  const js = readRel('claude-desktop/app/renderer/renderer.js');
  assert.match(js, /resetArmed/, '两段式确认状态');
  assert.match(js, /确认销毁并重建/, '第一次点击只改文案，不直接执行');
  const html = readRel('claude-desktop/app/renderer/index.html');
  assert.match(html, /id="reset"/, '界面要有重置入口');
  const preload = readRel('claude-desktop/app/preload.js');
  assert.match(preload, /runtime:reset/, 'preload 要暴露重置通道');
});

// ---------- 2.0：容器内内核 + TUN 唯一网络路径（单态化） ----------

test('坑 22：容器内内核必须在 net-guard 熔断之前启动', () => {
  const s = readRel('claude-vm/vm/scripts/entrypoint.sh');
  const tunAt = s.indexOf('/opt/scripts/tun-core.sh');
  const guardAt = s.indexOf('/opt/scripts/net-guard.sh');
  assert.ok(tunAt > 0 && guardAt > tunAt,
    '内核要在还有默认路由时解析节点域名、预置 MMDB、补 /32 主机路由；锁完路由就做不了了');
  assert.ok(!s.includes('TUN_MODE'), '2.0 TUN 恒开，不该再有并存开关');
});

test('坑 22：GeoIP 数据库必须预置进镜像，且启动前检查', () => {
  const docker = readRel('claude-vm/vm/Dockerfile');
  assert.match(docker, /geoip\.metadb/, '预置 MMDB，避免 DNS 指向内核自己时下载死锁');
  assert.match(docker, /usr\/local\/bin\/mihomo/, '内核随镜像提供');
  const core = readRel('claude-vm/vm/scripts/tun-core.sh');
  assert.match(core, /geoip\.metadb/, '启动前检查数据库存在，缺了就保持全断网');
  assert.match(core, /nameserver 127\.0\.0\.1/, 'DNS 必须收进容器内，宿主 fake-ip 才插不进来');
});

test('2.0：客机脚本单态化，旧代理链路残留为零', () => {
  const scripts = ['entrypoint.sh', 'net-guard.sh', 'tun-core.sh', 'chrome-login.sh',
    'show-welcome.sh', 'check-env.sh'];
  for (const f of scripts) {
    const src = readRel(`claude-vm/vm/scripts/${f}`);
    // 只查可执行行，注释里允许解释历史；`rm -f ...local-proxy` 是清理 1.0.x
    // 残留文件（不写新值），也不算旧链路。
    const code = src.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .filter((l) => !/^\s*rm -f \/opt\/config\/local-proxy/.test(l))
      .join('\n');
    for (const legacy of ['UPSTREAM_PROXY', 'PROXY_MODE', 'PROXY_WHITELIST',
      'TUN_MODE', 'local-proxy', 'proxy-server', 'proxy-router']) {
      assert.ok(!code.includes(legacy), `${f} 不该再有 ${legacy}`);
    }
    assert.ok(!code.includes('DISPLAY=:0') && !code.includes('wslg'),
      `${f} 不该再有 wslg / :0 分支`);
  }
  assert.ok(!existsRel('claude-vm/vm/scripts/proxy-router.js'), 'proxy-router.js 应已删除');
});

test('2.0：节点选择贯穿宿主→客机（全量单节点，忽略订阅分流）', () => {
  const main = readRel('claude-desktop/app/main.js');
  assert.match(main, /TUN_NODE: chosen/, '宿主把选中节点传进客机');
  assert.match(main, /tunConfig\.extractNodes/, '宿主解析节点列表');
  assert.match(main, /ipcMain\.handle\('clash:nodes'/, '刷新节点通道');
  assert.match(main, /ipcMain\.handle\('clash:pick'/, '导入 YAML 通道');

  const ep = readRel('claude-vm/vm/scripts/entrypoint.sh');
  assert.match(ep, /TUN_NODE/, 'runtime-env 必须落盘 TUN_NODE');
  const core = readRel('claude-vm/vm/scripts/tun-core.sh');
  assert.match(core, /TUN_NODE/, 'tun-core 必须把节点传给 tun-merge');

  const merge = readRel('claude-vm/vm/scripts/tun-merge.py');
  assert.match(merge, /node_names/, '要解析 proxies 里的节点名');
  assert.match(merge, /proxy-groups/, '生成单节点代理组');
  assert.match(merge, /MATCH,/, 'rules 兜底全量走该节点');
  assert.match(merge, /selected_node/, 'stdout JSON 回报最终节点，便于核对');
  // mihomo 官方：mode: global 走内置 GLOBAL 组并忽略自定义 rules，
  // 那样「选中节点」根本不生效。单节点必须 rule + 单条 MATCH 兜底。
  assert.match(merge, /mode = 'rule'/, '选中节点时必须 rule 模式，global 会让 MATCH 规则失效');
  assert.ok(!/mode = 'global'\s*# 全量单节点/.test(merge), '别把单节点配置写成 global');

  const tc = readRel('claude-desktop/app/lib/tun-config.js');
  assert.match(tc, /function extractNodes/, '宿主侧节点解析');
  assert.match(tc, /selectedNode/, '失效节点要能回落或拒绝');
  assert.match(tc, /base64Chunks/, '分块注入抽到 lib');
});

test('2.0：Clash YAML 用 base64 分块注入，不把原文拼进 shell', () => {
  const s = readRel('claude-desktop/app/main.js');
  assert.match(s, /tunConfig\.base64Chunks\(y\.text\)/, 'YAML 内容编码后再传');
  assert.match(s, /printf '%s' '\$\{part\}'/, '块内只含 A-Za-z0-9+/=，单引号安全');
  const tc = readRel('claude-desktop/app/lib/tun-config.js');
  assert.match(tc, /const CHUNK = 8000/, 'Windows execFile 命令行上限 32767 字符');
  assert.match(tc, /toString\('base64'\)/);
});

test('2.0：界面接线（画像卡片 / 节点选择 / YAML 导入 / 报告按钮）', () => {
  const html = readRel('claude-desktop/app/renderer/index.html');
  for (const id of ['personaCards', 'clashYamlPath', 'selectedNode', 'refreshNodes', 'cpRerun', 'reset']) {
    assert.match(html, new RegExp(`id="${id}"`), `界面缺少 ${id}`);
  }
  for (const legacy of ['id="proxy"', 'id="proxyMode"', 'id="whitelist"', 'id="tunMode"',
    'id="displayMode"', 'wslgPanel', 'checkPanel']) {
    assert.ok(!html.includes(legacy), `界面不该再有 ${legacy}`);
  }
  const js = readRel('claude-desktop/app/renderer/renderer.js');
  assert.match(js, /renderPersonas/, '画像卡片渲染');
  assert.match(js, /renderNodes/, '节点下拉渲染');
  assert.match(js, /openEnvironmentCheck/, '检查报告接入设置');
  assert.ok(!js.includes('openPanel') && !js.includes('renderCheck'),
    '主窗口不再渲染自检遮罩面板');
  const pre = readRel('claude-desktop/app/preload.js');
  assert.match(pre, /listNodes/, '节点刷新通道');
  assert.match(pre, /openReport/, '报告窗口通道');
  assert.match(pre, /exportReport/, '报告导出通道');
});

test('2.0：独立检查报告窗口（不影响串流桌面）', () => {
  assert.ok(existsRel('claude-desktop/app/renderer/report.html'), 'report.html 必须存在');
  assert.ok(existsRel('claude-desktop/app/renderer/report.js'), 'report.js 必须存在');
  const main = readRel('claude-desktop/app/main.js');
  assert.match(main, /function createReportWindow/, '独立窗口创建函数');
  assert.match(main, /new BrowserWindow/, '报告是独立 BrowserWindow');
  assert.match(main, /ipcMain\.handle\('report:open'/, '打开通道');
  assert.match(main, /ipcMain\.handle\('report:export'/, '导出通道');
  const html = readRel('claude-desktop/app/renderer/report.html');
  assert.ok(!html.includes('cp-mask'), '报告页不该有遮罩（它自己就是一整个窗口）');
  const rp = readRel('claude-desktop/app/renderer/report.js');
  assert.match(rp, /buildExportHtml/, '能导出静态 HTML 报告');
  assert.match(rp, /window\.api\.check\(\)/, '报告数据来自只读 checkEnv');
  assert.ok(!rp.includes('<webview') && !MAIN_SRC.includes('webviewTag: true,.*report'),
    '报告窗口不嵌桌面画面');
});

test('2.0：check-env.sh 保持 JSON 契约，并按 TUN 口径检查', () => {
  const ce = readRel('claude-vm/vm/scripts/check-env.sh');
  assert.match(ce, /"groups"/, '报告窗口依赖 data.groups 是数组');
  assert.match(ce, /"summary"/, '汇总计数不能丢');
  assert.match(ce, /--json/, '支持 --json');
  for (const k of ['mihomo', 'Meta', '198.19', 'TUN_NODE']) {
    assert.ok(ce.includes(k), `检查项应覆盖 ${k}`);
  }
});

test('坑 22：TUN 就绪必须等显式 ready 标记，不能只看网卡出现', () => {
  const core = readRel('claude-vm/vm/scripts/tun-core.sh');
  const dnsAt = core.indexOf("printf 'nameserver 127.0.0.1\\n' > /etc/resolv.conf");
  const markAt = core.indexOf('echo ready > "$READY_FILE"');
  assert.ok(dnsAt > 0 && markAt > dnsAt,
    '网卡先于 DNS 切换出现；只等 Meta 会让 getent 问到 WSL 的 DNS 代理（宿主 fake-ip）');
  const ep = readRel('claude-vm/vm/scripts/entrypoint.sh');
  assert.ok(ep.includes('/run/claude-vm/tun-ready'), 'entrypoint 要等 ready 标记再进入熔断');
});

test('2.0：版本号与 RUNTIME_REV 已同步升级', () => {
  const pkg = JSON.parse(readRel('claude-desktop/package.json'));
  assert.strictEqual(pkg.version, '2.1.0', '2.1 主界面改版 + App Icon 是功能版本，2.0.x 全是修复包');
  // 画像 id 没变（us），但时区从纽约改成了洛杉矶；不 bump REV 会 resume 旧会话继续用美东时间
  assert.match(MAIN_SRC, /const RUNTIME_REV = 20;/);
});

// ---------- 坑 23：wsl.exe 吞 $ 导致脚本同步假绿 ----------

test('坑 23：内联 bash -c 命令里不得出现裸 $ 变量', () => {
  // wsl.exe -d ... -- bash -c <cmd> 会把 $var / $(...) 吞掉（实测 X=$X → 空）。
  // 需要变量的脚本必须走 lib/guest-cmd.js 的 base64 管道，而不是直接内联。
  // 只检查 main.js 里 `runWsl(['bash', '-c', <字面量>])` 这类调用的命令文本；
  // 模板字符串里的 ${part} 是 JS 插值（base64 块），不是 shell 变量，需排除。
  // 收尾到 `], { timeout` —— 命令文本里可能出现 `]`（如 grep '[w]ebsockify'），
  // 用 `[^\]]*?` 会提前截断造成漏检。注释行先剔掉，避免误报。
  const calls = [...MAIN_SRC.matchAll(/\['bash',\s*'-c',\s*([\s\S]*?)\],\s*\{\s*timeout/g)]
    .map((m) => m[1]);
  assert.ok(calls.length >= 8, `内联 bash -c 调用数异常: ${calls.length}`);
  const inline = calls.join('\n').split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n');
  const jsInterp = [...inline.matchAll(/\$\{[A-Za-z_][\w.]*\}/g)].map((m) => m[0]);
  assert.ok(jsInterp.length > 0, '应能识别 YAML base64 分块的 JS 插值，避免误报');
  const stripped = inline.replace(/\$\{[A-Za-z_][\w.]*\}/g, '');
  const offenders = stripped.split('\n').filter((l) => /\$[A-Za-z_(]/.test(l));
  assert.deepStrictEqual(offenders, [], `内联 bash -c 里出现裸 $ 变量：\n${offenders.join('\n')}`);
  // 反向验证：故意注入旧写法必须被这条规则抓到（防止断言自己变成假绿）
  const legacy = "`for f in '${d}'/*; do b=$(basename \"$f\"); cp -f \"$f\" \"/opt/scripts/$b\"; done`";
  const fake = legacy.replace(/\$\{[A-Za-z_][\w.]*\}/g, '');
  assert.ok(/\$[A-Za-z_(]/.test(fake), '自检：这条规则必须能识别 shell 变量写法');
});

test('坑 23：syncScripts 走 base64 管道并逐文件校验 md5，不再只认 SYNCED', () => {
  assert.ok(existsRel('claude-desktop/app/lib/guest-cmd.js'), '同步命令与校验抽到可单测的 lib');
  assert.match(MAIN_SRC, /guestCmd\.bashViaBase64\(script\)/, '脚本必须编码后交给 bash');
  assert.match(MAIN_SRC, /guestCmd\.verifySync\(r\.stdout, manifest\)/, '同步结果按 md5 清单校验');
  assert.match(MAIN_SRC, /guestCmd\.localScriptManifest\(dir\)/, '宿主侧先算期望 md5');
  const g = readRel('claude-desktop/app/lib/guest-cmd.js');
  assert.match(g, /md5sum "\$f"/, '客机回报逐文件 md5');
  assert.match(g, /scripts-mismatch/, 'md5 不一致必须判失败');
  const body = MAIN_SRC.slice(MAIN_SRC.indexOf('async function syncScripts()'),
    MAIN_SRC.indexOf('// ---------- WSL 调用 ----------'));
  assert.ok(!/return \{ ok: \/SYNCED\/\.test/.test(body), '不能再用 SYNCED 字面量判成功');
});

test('坑 23：同步失败必须中止启动，不能只 push warning 放行', () => {
  const seg = MAIN_SRC.slice(MAIN_SRC.indexOf('const sync = await syncScripts();'),
    MAIN_SRC.indexOf('// 把外部 YAML 注入客机'));
  assert.match(seg, /if \(!sync\.ok\)/, '同步失败要判断');
  assert.match(seg, /return \{[\s\S]*?ok: false/, '必须直接返回失败结果');
  assert.match(seg, /中止启动/, '错误信息要说明为何不放行');
  assert.ok(!MAIN_SRC.includes('运行时脚本同步失败，环境可能仍在用旧脚本'),
    '旧版那条「仍在用旧脚本」的软警告已删除');
});

test('坑 23：env 的 TZ / LANG 只由 personas.js 派生，配置里不再存 tz / lang', () => {
  assert.match(MAIN_SRC, /const persona = personas\.byId\(cfg\.persona\)/);
  assert.match(MAIN_SRC, /TZ: persona\.tz/);
  assert.match(MAIN_SRC, /LANG: persona\.lang/);
  assert.match(MAIN_SRC, /LC_ALL: persona\.lang/);
  assert.ok(!/TZ: cfg\.tz|LANG: cfg\.lang|LC_ALL: cfg\.lang/.test(MAIN_SRC),
    '不能再从配置里直接取时区/语言');
  const m = readRel('claude-desktop/app/main.js');
  assert.match(m, /delete c\.tz/, 'mergeCfg 要清掉旧 config.json 残留');
  assert.match(m, /delete clean\.tz/, 'saveConfig 不写回派生字段');
  const r = readRel('claude-desktop/app/renderer/renderer.js');
  assert.ok(!/tz: \(cfg\.tz|lang: \(cfg\.lang/.test(r), '渲染层 gather 不再提交 tz / lang');
});

test('坑 22：net-guard 熔断恒用占位 lock，裸 curl 预检', () => {
  const s = readRel('claude-vm/vm/scripts/net-guard.sh');
  assert.ok(s.includes('LOCK_ARG="http://127.0.0.1:1"'), '占位 lock 保留 fail-closed 底座');
  assert.match(s, /pgrep -x mihomo/, '内核消失必须判失败');
  assert.ok(!s.includes('-x "$PROXY_URL"'), '不该再有显式代理端口探测');
});

// ---------- 坑 25：画像语言单态化 + 节点延迟展示 ----------
test('坑 25：CHROME_LANG 贯通六个环节，浏览器语言不再各自从 LANG 猜', () => {
  const files = [
    'claude-desktop/app/main.js',
    'claude-vm/vm/scripts/entrypoint.sh',
    'claude-vm/vm/scripts/chrome-login.sh',
    'claude-vm/vm/scripts/show-welcome.sh',
    'claude-vm/vm/scripts/chrome-lang.py',
    'claude-vm/vm/scripts/check-env.sh',
  ];
  for (const f of files) {
    assert.match(readRel(f), /CHROME_LANG/, `${f} 必须读画像下发的 CHROME_LANG`);
  }
  assert.match(MAIN_SRC, /CHROME_LANG: persona\.chromeLang/, 'env 由画像派生');
  assert.match(readRel('claude-vm/vm/scripts/entrypoint.sh'),
    /export CHROME_LANG=/, '落盘 runtime-env，独立自检会话才读得到');
});

test('坑 25：写 app_locale（Chrome UI 语言），且自检单列该项防报告假绿', () => {
  const py = readRel('claude-vm/vm/scripts/chrome-lang.py');
  assert.match(py, /intl\['app_locale'\] = bcp47/,
    '只写 accept_languages 会让界面保持旧语言');
  assert.match(py, /print\(str\(out\.get\('app_locale'/,
    '--shell 要输出 UI 语言供自检读');
  const chk = readRel('claude-vm/vm/scripts/check-env.sh');
  assert.match(chk, /_cl_ui="\$\{_CL\[4\]:-\}"/, '自检要读第 5 行');
  assert.match(chk, /add region fail "浏览器 UI 语言"/,
    'UI 语言不一致必须判失败，不能只测请求头');
  assert.ok(chk.includes('_cl_want="${CHROME_LANG:-'), '期望语言跟画像走');
});

test('坑 25：启动期清残留 Chrome 实例，欢迎页不再写死 en-US', () => {
  const ep = readRel('claude-vm/vm/scripts/entrypoint.sh');
  assert.match(ep, /pkill -x chrome/,
    '旧实例会让新 --lang 被忽略，并在退出时把旧语言写回磁盘');
  const welcome = readRel('claude-vm/vm/scripts/show-welcome.sh');
  assert.ok(!welcome.includes('--lang=en-US'),
    '欢迎页写死英文会在首次启动时污染 Profile');
  assert.match(welcome, /--lang="\$WELCOME_LANG"/);
});

test('2.0.3：节点延迟链路贯通（本地控制 API → 客机脚本 → IPC → 界面 → 报告）', () => {
  const merge = readRel('claude-vm/vm/scripts/tun-merge.py');
  assert.match(merge, /'external-controller: %s' % CONTROLLER/);
  assert.match(merge, /CONTROLLER = '127\.0\.0\.1:9090'/, '只听本地回环，不暴露到宿主');
  assert.match(merge, /'external-controller-pipe'/, '订阅里的 Windows 命名管道要剥掉');
  const delay = readRel('claude-vm/vm/scripts/node-delay.py');
  assert.match(delay, /def node_names_from_yaml/,
    '节点名来自注入的 YAML，不靠 /proxies 的 type 黑名单（会混进 PASS-RULE 等内置策略）');
  assert.match(delay, /MERGE_SCRIPT/, '复用 tun-merge.node_names，与宿主 extractNodes 同构');
  assert.match(delay, /def summary/, '报告读摘要，不重复测速');
  assert.ok(MAIN_SRC.includes("ipcMain.handle('nodes:latency'"), '主进程要有延迟 IPC');
  assert.match(readRel('claude-desktop/app/preload.js'), /nodeLatency/);
  const ui = readRel('claude-desktop/app/renderer/renderer.js');
  assert.match(ui, /async function testLatency/);
  assert.match(ui, /\$\('testLatency'\)\.addEventListener/);
  assert.match(readRel('claude-vm/vm/scripts/check-env.sh'),
    /add network pass "节点延迟"/, '检查报告也要展示延迟');
});

test('2.0.3：画像固定台北 + 洛杉矶，不再有美东时区', () => {
  const p = readRel('claude-desktop/app/lib/personas.js');
  assert.ok(p.includes('Asia/Taipei') && p.includes('America/Los_Angeles'));
  assert.ok(!p.includes('America/New_York'), '美东画像已按用户要求换成洛杉矶');
  assert.match(p, /id: 'us'/, 'id 保留 us，旧配置不会被兜底成台北');
});

// ---------- 2.1 主界面：DOM 契约与无边框窗口 ----------
test('2.1：renderer.js 引用的每个 DOM id 都真实存在（防 UI 改版后整页静默失效）', () => {
  const html = readRel('claude-desktop/app/renderer/index.html');
  const js = readRel('claude-desktop/app/renderer/renderer.js');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...js.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]))];
  // 反向自检：抓不到引用时这条断言就是假绿（坑 23 的教训）
  assert.ok(refs.length >= 30, `只抓到 ${refs.length} 个 $() 引用，断言本身形同虚设`);
  assert.ok(refs.includes('selectedNode') && refs.includes('sbGuard'),
    '抽样确认能抓到真实引用');
  const missing = refs.filter((id) => !ids.has(id));
  assert.deepStrictEqual(missing, [],
    `渲染层引用了 index.html 里不存在的 id：${missing.join(', ')} —— 界面会静默失效`);
});

test('2.1：主界面骨架（顶栏 / 舞台 / 单行状态信息栏 / 设置弹窗 / 4 个 tab）', () => {
  const html = readRel('claude-desktop/app/renderer/index.html');
  for (const id of ['runBadge', 'powerBtn', 'navSettings', 'winMin', 'winMax', 'winClose',
                    'stage', 'phStart', 'view', 'settingsOverlay', 'settingsNav',
                    'settingsHint', 'sbPersona', 'sbLatency', 'sbGuard', 'sbItems']) {
    assert.match(html, new RegExp(`id="${id}"`), `主界面缺少 ${id}`);
  }
  assert.strictEqual([...html.matchAll(/\bdata-tab="([^"]+)"/g)].length, 4,
    '设置弹窗要有 4 个 tab 导航');
  assert.strictEqual([...html.matchAll(/\bdata-panel="([^"]+)"/g)].length, 4,
    '设置弹窗要有 4 个内容面板');
  assert.match(html, /wave-bg|stage-waves/, '串流舞台要有波浪背景');
  assert.strictEqual([...html.matchAll(/class="sb-row/g)].length, 1,
    '宿主底部只能有一行状态信息，任务栏属于虚拟机');
});

test('2.1：窗口控制通道在 main / preload 两侧对齐', () => {
  const main = readRel('claude-desktop/app/main.js');
  const pre = readRel('claude-desktop/app/preload.js');
  assert.match(main, /frame: false/, '顶栏自绘需要无边框窗口');
  for (const ch of ['win:minimize', 'win:maximize', 'win:close', 'win:state']) {
    assert.ok(main.includes(`ipcMain.handle('${ch}'`), `主进程缺 ${ch} 通道`);
  }
  for (const api of ['winMinimize', 'winMaximize', 'winClose', 'winState', 'onWinState']) {
    assert.match(pre, new RegExp(api), `preload 缺 ${api}`);
  }
  assert.match(main, /guestCmd\.bashViaBase64/, '同步脚本仍要避开 wsl.exe 吞 $（坑 23）');
});

// ---------- 坑 26：任务栏属于虚拟机，宿主不得再画一套假的 ----------
// 曾经把 dock / 窗口标签 / 音量 / 时钟做进宿主 DOM，结果串流画面里的 tint2
// 面板（04:30 PST）下面又叠一条宿主任务栏（20:30 本机时间），两个任务栏、
// 两个时钟。桌面启动器、任务项、托盘、时钟都只能由 VM 内的 X11 面板提供。
test('坑 26：宿主界面不得再实现假任务栏（dock / 窗口标签 / 时钟 / 音量）', () => {
  const html = readRel('claude-desktop/app/renderer/index.html');
  const css = readRel('claude-desktop/app/renderer/styles.css');
  const js = readRel('claude-desktop/app/renderer/renderer.js');
  for (const bad of ['class="dock"', 'class="dock-ico', 'data-launch=', 'id="sbWindow"',
                     'id="sbTime"', 'id="sbDate"', 'class="sb-vol"', 'class="sb-clock"',
                     'class="sb-top"', 'class="sb-bottom"']) {
    assert.ok(!html.includes(bad), `宿主 HTML 又出现了假任务栏元素：${bad}`);
  }
  for (const bad of ['.dock-ico', '.sb-window', '.sb-vol', '.sb-clock', '.sb-top']) {
    assert.ok(!css.includes(bad), `宿主 CSS 又出现了假任务栏样式：${bad}`);
  }
  for (const bad of ['sbWindow', 'sbTime', 'sbDate', 'updateClock', 'data-launch', 'launchGuest']) {
    assert.ok(!js.includes(bad), `渲染层又引用了假任务栏：${bad}`);
  }
  assert.ok(!/new Date\(\)/.test(js.slice(js.indexOf('// ---------- 宿主状态信息栏'), js.indexOf('// ---------- 伪装画像'))),
    '宿主不得自己算时钟（VM 时钟走画像时区，由 tint2 显示）');
  const main = readRel('claude-desktop/app/main.js');
  const pre = readRel('claude-desktop/app/preload.js');
  assert.ok(!main.includes("ipcMain.handle('guest:launch'"),
    '宿主不该再提供客机启动 IPC：VM 的 .desktop 自己拉起程序');
  assert.ok(!pre.includes('launchGuest'), 'preload 不该再暴露 launchGuest');
});

test('坑 26：任务栏的唯一真源是 VM 内的 tint2 面板', () => {
  const rc = readRel('claude-vm/vm/config/tint2rc');
  const entry = readRel('claude-vm/vm/scripts/entrypoint.sh');
  const docker = readRel('claude-vm/vm/Dockerfile');
  assert.match(rc, /panel_items\s*=\s*LTSC/,
    '面板要含启动器 L / 任务栏 T / 托盘 S / 时钟 C');
  assert.match(rc, /panel_position\s*=\s*bottom/, '任务栏贴在桌面底部');
  assert.strictEqual([...rc.matchAll(/launcher_item_app\s*=\s*(\S+)/g)].length, 4,
    '四个桌面启动器（Chrome / Claude Code / 终端 / 文件管理器）');
  assert.match(rc, /time1_format\s*=\s*%H:%M/, '时钟显示 HH:MM');
  assert.match(rc, /time2_format/, '时钟第二行显示星期与日期');
  assert.match(entry, /^\s*tint2\s*>/m, 'entrypoint 必须启动 tint2，否则桌面没有任务栏');
  assert.match(docker, /\btint2\b/, 'tint2 必须随镜像预置');
  for (const f of ['claude-login.desktop', 'claude-code.desktop',
                   'claude-terminal.desktop', 'claude-files.desktop']) {
    assert.ok(existsRel(`claude-vm/vm/config/apps/${f}`),
      `启动器 ${f} 必须随镜像提供，否则任务栏图标点不动`);
  }
  assert.match(entry, /\/opt\/config\/apps\/\*\.desktop/, '启动器要拷进 XDG 应用目录');
});

// ---------- App Icon：矢量真源 + 位图导出 + 三处接线 ----------
// 图标是手写的 SVG（深色圆角方块 + 橙色 >_），不依赖用户给的那张非正方形 PNG。
// 系统窗口 / 安装包图标只认位图，所以同一套几何还要导出一份 PNG；
// 两边色值与几何必须一致，否则顶栏和任务栏会是两个不同的图标。
test('App Icon：SVG 真源、PNG 导出与三处接线齐全', () => {
  const svg = readRel('claude-desktop/app/renderer/assets/app-icon.svg');
  const html = readRel('claude-desktop/app/renderer/index.html');
  const css = readRel('claude-desktop/app/renderer/styles.css');
  const main = readRel('claude-desktop/app/main.js');
  const pkg = JSON.parse(readRel('claude-desktop/package.json'));
  const gen = readRel('build/make-app-icon-2x.py');

  assert.match(svg, /viewBox="0 0 512 512"/);
  assert.match(svg, /rx="112"/, '圆角方块');
  assert.match(svg, /stroke="#f0825a"/, '橙色 > 箭头');
  assert.match(svg, /fill="#14141f"/, '深色方块');
  assert.match(svg, /M150 190 L242 256 L150 322/, '终端 > 折线');
  assert.match(svg, /<rect x="322"/, '右上小方块（光标）');
  assert.match(svg, /<rect x="252"/, '下方短横（下划线）');

  for (const p of ['claude-desktop/app/renderer/assets/app-icon.png',
                   'claude-desktop/build/icon.png']) {
    assert.ok(existsRel(p), `${p} 必须存在：窗口 / 安装包图标不认 SVG`);
  }
  // 位图导出必须与 SVG 同源，不允许又回到「裁用户原图」那条路
  assert.match(gen, /DARK = \(20, 20, 31, 255\)/, '#14141f 与 SVG 一致');
  assert.match(gen, /ORANGE = \(240, 130, 90, 255\)/, '#f0825a 与 SVG 一致');
  assert.match(gen, /radius=P\(112\)/, '圆角半径与 SVG 一致');
  assert.ok(!gen.includes('Dark Terminal Icon'), '生成脚本不该依赖下载的原始图片');

  assert.match(html, /<img src="assets\/app-icon\.svg"/, '顶栏 logo 用矢量真源');
  assert.ok(!html.includes('M4 12l6-6M4 12l6 6'), '旧的手绘箭头 logo 已删除');
  assert.match(css, /\.tb-logo img \{ width: 26px; height: 26px/);
  assert.ok(!css.includes('linear-gradient(135deg, #e0845f'), '不再叠橙色渐变底');

  assert.match(main, /const APP_ICON = path\.join\(__dirname, 'renderer', 'assets', 'app-icon\.png'\)/);
  assert.strictEqual([...main.matchAll(/icon: APP_ICON/g)].length, 2,
    '主窗口与独立报告窗口都要设置窗口图标');
  assert.strictEqual(pkg.build.icon, 'build/icon.png', 'electron-builder 用 512 位图');
  assert.ok(pkg.build.files.some((f) => f.startsWith('app/')),
    'app-icon.svg / .png 必须随 asar 打包');
});

test('网络检查入口位于网络与安全中', () => {
  const js = readRel('claude-desktop/app/renderer/renderer.js');
  assert.match(js, /switchTab\('network'\)/, '状态栏可以打开网络与安全');
  assert.ok(!js.includes("openOverlay('checkOverlay')"),
    '检查浮层本轮不接线（下一轮做环境检查时请同步更新这条断言）');
  const html = readRel('claude-desktop/app/renderer/report.html');
  assert.ok(!html.includes('cp-mask'), '报告页仍是独立窗口，无遮罩');
});
