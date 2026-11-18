'use strict';
// L3 集成测试：需要本机有 WSL2 且已导入 claude-vm 发行版，否则自动 skip。
//
// 安全约定（务必遵守）：
//   1. lock→unlock 测试会真实修改内核路由表 —— 只允许在环境「未运行」时执行
//      （/run/claude-vm/ready 为空）。正在运行的会话的熔断不能被测试解锁。
//   2. 每个改路由的用例都在 finally 里兜底 unlock，并以「默认路由已恢复」收尾断言。
//   3. 跑之前请先在应用里点「停止」。
//
// 2.0：旧代理链路（网关候选解析 / local-proxy）已删除，这里只验证
// net-guard 这条 fail-closed 底座本身与检查脚本的 JSON 契约。
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const DISTRO = 'claude-vm';

function wsl(args, timeoutMs = 60000) {
  const r = spawnSync('wsl.exe', ['-d', DISTRO, '-u', 'root', '--', ...args], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
  });
  return { ok: r.status === 0, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

function detectDistro() {
  try {
    const r = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 20000 });
    if (r.status !== 0) return false;
    const text = r.stdout.includes(0) ? r.stdout.toString('utf16le') : r.stdout.toString('utf8');
    return text.replace(/\0|\uFEFF/g, '').split(/\r?\n/).some((n) => n.trim().toLowerCase() === DISTRO);
  } catch { return false; }
}
const WSL_SKIP = detectDistro() ? undefined : '本机没有 WSL2 或未导入 claude-vm 发行版';

function envIdle() {
  const r = wsl(['bash', '-c', 'cat /run/claude-vm/ready 2>/dev/null'], 30000);
  return String(r.stdout).trim() === '';
}

/** 从 /proc/net/route 里取默认路由网关（小端 hex），仅测试用。 */
function defaultGateway(routeTxt) {
  for (const line of String(routeTxt || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '00000000') continue;
    const n = parseInt(f[2], 16);
    if (n) return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
  }
  return null;
}

test('net-guard.py status 输出结构化 JSON 且字段齐全', { skip: WSL_SKIP }, () => {
  const r = wsl(['python3', '/opt/scripts/net-guard.py', 'status']);
  assert.ok(r.ok, `net-guard.py 不可用: ${r.stderr}`);
  const st = JSON.parse(r.stdout);
  for (const k of ['locked', 'default_v4', 'ipv6_disabled']) {
    assert.ok(k in st, `status 缺少字段 ${k}`);
  }
});

test('坑 15 回归：lock→status→unlock 往返，默认路由可精确还原', { skip: WSL_SKIP }, (t) => {
  if (!envIdle()) return t.skip('环境正在运行（ready 非空）—— 不会对活会话的熔断下手，先点「停止」');
  const gw = defaultGateway(wsl(['cat', '/proc/net/route']).stdout);
  assert.ok(gw, '拿不到默认路由网关，无法构造 lock 参数');

  const lock = JSON.parse(wsl(['python3', '/opt/scripts/net-guard.py', 'lock', `http://${gw}:7897`]).stdout);
  assert.strictEqual(lock.ok, true, `lock 失败: ${JSON.stringify(lock)}`);

  const st = JSON.parse(wsl(['python3', '/opt/scripts/net-guard.py', 'status']).stdout);
  assert.strictEqual(st.locked, true, '锁定后 status 应为 locked');

  const lockedRoute = wsl(['cat', '/proc/net/route']).stdout;
  assert.ok(!/^eth0\t00000000\t/m.test(lockedRoute), '锁定后不应存在默认路由');

  try {
    const unlock = JSON.parse(wsl(['python3', '/opt/scripts/net-guard.py', 'unlock']).stdout);
    assert.strictEqual(unlock.ok, true, `unlock 失败: ${JSON.stringify(unlock)}`);
    assert.strictEqual(unlock.locked, false);
    const restored = wsl(['cat', '/proc/net/route']).stdout;
    assert.ok(/^eth0\t00000000\t[0-9A-F]{8}\t/m.test(restored),
      'unlock 后默认路由必须回来 —— 这是 1.0.30 死锁的复原路径');
  } finally {
    wsl(['python3', '/opt/scripts/net-guard.py', 'unlock']);
  }
});

test('网络检查输出结构化分组', { skip: WSL_SKIP }, () => {
  const r = wsl(['python3', '/opt/scripts/check-network.py'], 30000);
  if (!r.ok || !r.stdout.trim()) {
    assert.ok(r.stderr.length === 0 || r.ok, `网络检查执行失败: ${r.stderr.slice(0, 200)}`);
    return;
  }
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.groups), '报告窗口依赖 data.groups 是数组');
  assert.ok(out.groups.some((group) => group.id === 'network'), '缺少网络分组');
});

test('2.0：真源里不再有旧代理链路脚本（local-proxy / proxy-router）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  const srcDir = path.join(root, 'claude-vm', 'vm', 'scripts');
  assert.ok(!fs.existsSync(path.join(srcDir, 'proxy-router.js')),
    'proxy-router.js 应已从真源删除（VM 里的旧副本会在下次启动同步时移除）');
  for (const f of ['entrypoint.sh', 'net-guard.sh']) {
    const s = fs.readFileSync(path.join(srcDir, f), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .filter((l) => !/^\s*rm -f \/opt\/config\/local-proxy/.test(l))
      .join('\n');
    assert.ok(!/UPSTREAM_PROXY|PROXY_MODE|PROXY_WHITELIST|TUN_MODE/.test(s),
      `${f} 不该再写旧代理变量`);
  }
});
