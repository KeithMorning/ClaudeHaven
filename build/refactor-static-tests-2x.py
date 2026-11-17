#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2.0：把静态一致性测试里绑定旧代理链路 / wslg / 双链路开关的断言换掉。

保留所有与新架构无关的断言（坑 12/14/16/17/18/19/20/21、平台抽象、工程基本面）。
"""
import sys

P = r'E:\Web\FuckCladue\tests\static\consistency.test.js'
with open(P, 'r', encoding='utf-8', newline='') as f:
    s = f.read()

n = 0


def once(old, new, label):
    global s, n
    c = s.count(old)
    if c != 1:
        sys.exit(f'[FAIL] {label}: 旧串出现 {c} 次')
    s = s.replace(old, new, 1)
    n += 1


# 1) cfgFingerprint 现在依赖 tunConfig / userDir，直接 loadSegment 会缺依赖
once(
    """test('坑 13：main.js 的 RUNTIME_REV 为正整数并参与指纹', () => {
  assert.match(MAIN_SRC, /const RUNTIME_REV = \\d+;/);
  const { cfgFingerprint } = loadSegment('cfgFingerprint', { RUNTIME_REV: 1 });
  assert.ok(cfgFingerprint({}).includes('rev'), '指纹必须含 rev，否则升级会接管旧会话');
});""",
    """test('坑 13：main.js 的 RUNTIME_REV 为正整数并参与指纹', () => {
  assert.match(MAIN_SRC, /const RUNTIME_REV = \\d+;/);
  const tunConfig = {
    readClashYaml: () => ({ ok: true, text: 'proxies: []\\n' }),
    tunFingerprint: () => 'fp', selectedNode: () => 'n1',
  };
  const { cfgFingerprint } = loadSegment('cfgFingerprint',
    { RUNTIME_REV: 1, tunConfig, userDir: () => '/tmp/u' });
  assert.ok(cfgFingerprint({}).includes('rev'), '指纹必须含 rev，否则升级会接管旧会话');
});""",
    'cfgFingerprint 依赖')

# 2) 坑 15 网关发现断言 → 2.0 单态网络路径断言
once(
    """test('坑 15：网关发现不再依赖默认路由（旧 wslGateway 已移除）', () => {
  assert.ok(!MAIN_SRC.includes('wslGateway'), 'wslGateway 只认默认路由，是坑 15 死锁的根因');
  assert.ok(MAIN_SRC.includes('wslHostCandidates'), '应使用多来源候选解析');
  assert.ok(MAIN_SRC.includes('parseRouteTable'), '应解析 /proc/net/route 直连段');
  assert.ok(MAIN_SRC.includes('/opt/config/local-proxy'), '应读取上次成功的宿主地址');
});""",
    """test('2.0：主进程不再有外部代理链路（全量单节点 TUN 是唯一路径）', () => {
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
  assert.match(MAIN_SRC, /无法启动：\\$\\{y\\.error\\}/, '读不到 YAML 要拦住');
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
  assert.match(p, /Asia\\/Taipei/);
  assert.match(p, /America\\/New_York/);
  assert.doesNotMatch(p, /canvas|webgl|audio|Canvas|WebGL/i,
    '不做假噪音（防封教程明确要求关掉，开了反而一眼被识破）');
  assert.match(MAIN_SRC, /_personas: personas\\.list/, '画像列表由主进程传给渲染层');
  const html = readRel('claude-desktop/app/renderer/index.html');
  assert.ok(!html.includes('id="region"'), '旧的 7 个地区下拉已删除');
  assert.match(html, /id="personaCards"/, '两套画像用卡片呈现');
});""",
    '坑 15 → 2.0 网络路径')

# 3) 坑 22 整段（从标题到文件末尾）换成 2.0 断言
start = s.index('// ---------- 模块一：容器内 mihomo + TUN 全局接管（坑 22） ----------')
s = s[:start] + r'''// ---------- 2.0：容器内内核 + TUN 唯一网络路径（单态化） ----------

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
    // 只查可执行行，注释里允许解释历史
    const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
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
  for (const id of ['personaCards', 'clashYamlPath', 'selectedNode', 'refreshNodes', 'check', 'reset']) {
    assert.match(html, new RegExp(`id="${id}"`), `界面缺少 ${id}`);
  }
  for (const legacy of ['id="proxy"', 'id="proxyMode"', 'id="whitelist"', 'id="tunMode"',
    'id="displayMode"', 'wslgPanel', 'checkPanel']) {
    assert.ok(!html.includes(legacy), `界面不该再有 ${legacy}`);
  }
  const js = readRel('claude-desktop/app/renderer/renderer.js');
  assert.match(js, /renderPersonas/, '画像卡片渲染');
  assert.match(js, /renderNodes/, '节点下拉渲染');
  assert.match(js, /window\.api\.openReport\(\)/, '检查报告走独立窗口');
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
  assert.strictEqual(pkg.version, '2.0.0');
  assert.match(MAIN_SRC, /const RUNTIME_REV = 12;/);
});

test('坑 22：net-guard 熔断恒用占位 lock，裸 curl 预检', () => {
  const s = readRel('claude-vm/vm/scripts/net-guard.sh');
  assert.ok(s.includes('LOCK_ARG="http://127.0.0.1:1"'), '占位 lock 保留 fail-closed 底座');
  assert.match(s, /pgrep -x mihomo/, '内核消失必须判失败');
  assert.ok(!s.includes('-x "$PROXY_URL"'), '不该再有显式代理端口探测');
});
'''
n += 1

with open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print(f'OK: {n} 处替换，consistency.test.js 现 {len(s.splitlines())} 行')
