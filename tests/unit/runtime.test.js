'use strict';
// L1 单元测试：运行时存活判定（坑 13 假活）与配置指纹（坑 13 RUNTIME_REV）。
// 2.0 只有 desktop 一种显示模式，runtimeAlive 不再带 displayMode 参数。
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSegment, mkLogCollector } = require('../loader');

function buildRuntime({ procs, portUp }) {
  const collector = mkLogCollector();
  const runWsl = async (args) => {
    const cmd = String(args.join(' '));
    if (cmd.includes('pgrep -x Xtigervnc')) return { ok: true, stdout: `${procs || 'DEAD'}\n`, stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const { runtimeAlive } = loadSegment('runtimeAlive', {
    runWsl, log: collector.log, waitPort: async () => !!portUp, NOVNC_PORT: 6080,
  });
  return { runtimeAlive, collector };
}

test('桌面进程全退 → 判死并留日志（坑 13 假活）', async () => {
  const { runtimeAlive, collector } = buildRuntime({ procs: 'DEAD', portUp: false });
  assert.strictEqual(await runtimeAlive(), false);
  assert.ok(collector.lines.some((l) => l.includes('桌面进程缺失')),
    '假活必须留日志，否则排障时无从判断为什么重建');
});

test('进程在但串流端口没监听 → 仍判死', async () => {
  const { runtimeAlive } = buildRuntime({ procs: 'RUNNING', portUp: false });
  assert.strictEqual(await runtimeAlive(), false);
});

test('进程与端口都在 → 判活', async () => {
  const { runtimeAlive } = buildRuntime({ procs: 'RUNNING', portUp: true });
  assert.strictEqual(await runtimeAlive(), true);
});

// ---------- 配置指纹 ----------
// cfgFingerprint 现在会把 YAML 内容与选中节点一起算进去，
// 所以注入 tunConfig / userDir 桩，验证「改节点/改订阅必须重建」。

function fingerprintDeps(text = 'proxies:\n  - name: us-1\n    server: 1.2.3.4\n') {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  const pathStub = { join: (...a) => a.join('/').replace(/\\/g, '/') };
  const appStub = { getPath: () => '/home/u' };
  const { defaultConfig } = loadSegment('defaultConfig', { path: pathStub, app: appStub });
  const { mergeCfg } = loadSegment('mergeCfg', { defaultConfig, normalizeWinPath });
  const tunConfig = {
    readClashYaml: () => ({ ok: true, text }),
    // 用真实内容摘要，别用长度：两份不同订阅可能刚好一样长
    tunFingerprint: (t) => require('crypto').createHash('sha256').update(t).digest('hex').slice(0, 16),
    selectedNode: (cfg) => cfg.selectedNode || 'us-1',
  };
  return { mergeCfg, tunConfig, userDir: () => '/tmp/userdata' };
}

const baseCfg = {
  persona: 'tw-taipei', tz: 'Asia/Taipei', lang: 'zh_TW.UTF-8',
  clashYamlPath: '/tmp/sub.yaml', selectedNode: 'us-1',
  workspace: 'C:\\w\\p', netGuard: 'strict', inputMethod: 'off',
};

function fp(cfg, deps, rev = 12) {
  return loadSegment('cfgFingerprint', {
    RUNTIME_REV: rev, tunConfig: deps.tunConfig, userDir: deps.userDir,
  }).cfgFingerprint(deps.mergeCfg(cfg));
}

test('cfgFingerprint: workspace 写法漂移不改变指纹（经 mergeCfg 规范化）', () => {
  const d = fingerprintDeps();
  assert.strictEqual(fp({ ...baseCfg, workspace: 'C:\\w\\p' }, d),
    fp({ ...baseCfg, workspace: 'C:/w//p' }, d));
});

test('cfgFingerprint: 画像 / 节点 / 订阅内容 / 熔断 / 输入法任一变化都改变指纹', () => {
  const d = fingerprintDeps();
  const base = fp(baseCfg, d);
  assert.notStrictEqual(fp({ ...baseCfg, persona: 'us' }, d), base, '切画像必须重建会话');
  assert.notStrictEqual(fp({ ...baseCfg, selectedNode: 'hk-1' }, d), base, '换节点必须重建内核');
  assert.notStrictEqual(fp({ ...baseCfg, netGuard: 'off' }, d), base, '熔断改内核路由表');
  assert.notStrictEqual(fp({ ...baseCfg, inputMethod: 'rime' }, d), base, '输入法要重起 fcitx5');
});

test('坑 23：旧 config.json 残留的 tz / lang 不改变指纹（画像才是唯一决定项）', () => {
  const d = fingerprintDeps();
  assert.strictEqual(fp(baseCfg, d), fp({ ...baseCfg, tz: 'America/Los_Angeles', lang: 'zh_CN.UTF-8' }, d),
    'tz / lang 已由 mergeCfg 清掉；若它们还能改指纹，旧残留会导致每次启动都误判配置变更');
});

test('cfgFingerprint: 外部 YAML 内容变了必须换指纹（不能接管旧内核）', () => {
  const d1 = fingerprintDeps('proxies:\n  - name: us-1\n    server: 1.2.3.4\n');
  const d2 = fingerprintDeps('proxies:\n  - name: us-1\n    server: 5.6.7.8\n');
  assert.notStrictEqual(fp(baseCfg, d1), fp(baseCfg, d2));
});

test('cfgFingerprint: RUNTIME_REV 变化改变指纹（坑 13：升级强制重建）', () => {
  const d = fingerprintDeps();
  assert.notStrictEqual(fp(baseCfg, d, 12), fp(baseCfg, d, 13));
});
