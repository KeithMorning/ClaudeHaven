'use strict';
// L1 单元测试：坑 24 —— 客机 tun-merge.py 的节点解析必须与宿主一致。
// 宿主 extractNodes 支持「name 在列表项第二行」，客机旧版只认 `- name:` 开头，
// 导致界面能选中节点、客机却报「不在 proxies 列表中」→ merge 失败 → 内核不启动。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const readRel = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const PY = spawnSync('python3', ['-c', 'print("ok")'], { encoding: 'utf8' });
const hasPy = PY.status === 0;
const MERGE = path.join(ROOT, 'claude-vm', 'vm', 'scripts', 'tun-merge.py');

// 真实订阅里的写法：`- type: vless` 在前，name 在第二行
const TYPE_FIRST = [
  'mode: global',
  'proxies:',
  '  - type: vless',
  '    name: LAX-Cogent-Reality',
  '    server: 38.150.32.117',
  '    port: 443',
  '',
  '  - type: vless',
  '    name: "Vultr-LAX-Reality"',
  '    server: 45.32.83.147',
  '',
  'proxy-groups:',
  '  - name: pacProxy',
  '    type: select',
  'rules:',
  '  - MATCH,DIRECT',
].join('\n');

// 另一种常见写法：name 是列表项第一键
const NAME_FIRST = [
  'proxies:',
  '  - name: 台北节点 01',
  '    type: vmess',
  '    server: 1.2.3.4',
  '  - name: us-node',
  '    type: trojan',
  '    server: 5.6.7.8',
  'proxy-groups:',
  '  - name: GLOBAL',
].join('\n');

function callPython(expr, yamlText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudevm-merge-'));
  try {
    const cfg = path.join(dir, 'clash.yaml');
    fs.writeFileSync(cfg, yamlText, 'utf8');
    const script = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location('tm', ${JSON.stringify(MERGE)})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      `lines = open(${JSON.stringify(cfg)}, encoding='utf-8').read().replace('\\r\\n','\\n').split('\\n')`,
      `print(json.dumps(${expr}, ensure_ascii=False))`,
    ].join('\n');
    const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `python3 执行失败:\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(r.stdout.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('坑 24：name 在列表项第二行时，node_names 仍能解析（真实订阅格式）', { skip: !hasPy && 'python3 不可用' }, () => {
  const names = callPython('m.node_names(lines)', TYPE_FIRST);
  assert.deepStrictEqual(names, ['LAX-Cogent-Reality', 'Vultr-LAX-Reality']);
});

test('坑 24：name 是列表项第一键 / 含中文空格 / 带引号都正确', { skip: !hasPy && 'python3 不可用' }, () => {
  const names = callPython('m.node_names(lines)', NAME_FIRST);
  assert.deepStrictEqual(names, ['台北节点 01', 'us-node']);
});

test('坑 24：proxy-groups 里的 name 不应被误收进节点列表', { skip: !hasPy && 'python3 不可用' }, () => {
  const names = callPython('m.node_names(lines)', TYPE_FIRST);
  assert.ok(!names.includes('pacProxy'));
  const names2 = callPython('m.node_names(lines)', NAME_FIRST);
  assert.ok(!names2.includes('GLOBAL'));
});

test('坑 24：node_hosts 在 type-first 格式下也能提取 server', { skip: !hasPy && 'python3 不可用' }, () => {
  const hosts = callPython('m.node_hosts(lines)', TYPE_FIRST);
  assert.deepStrictEqual(hosts, ['38.150.32.117', '45.32.83.147']);
});

test('坑 24：strip_keys 保留 proxies 段、剥离订阅分流段', { skip: !hasPy && 'python3 不可用' }, () => {
  const kept = callPython('m.strip_keys(lines, m.STRIP_KEYS)', TYPE_FIRST);
  assert.ok(kept.some((l) => l.includes('LAX-Cogent-Reality')), 'proxies 段必须原样保留');
  assert.ok(!kept.some((l) => l.includes('MATCH,DIRECT')), '订阅 rules 必须剥离');
  assert.ok(!kept.some((l) => l.trim().startsWith('mode:')), '订阅 mode 必须剥离');
});

test('坑 24：net-guard.sh 不得再有「赋值里混入 # 分隔线」的垃圾行', () => {
  const s = readRel('claude-vm/vm/scripts/net-guard.sh');
  assert.doesNotMatch(s, /^[A-Z_][A-Z0-9_]*=#/m,
    '`VAR=# ===` 里的 # 不是注释，bash 会把 === 当命令执行并报错');
  assert.match(s, /^GUARD_DIR=\/run\/claude-vm$/m);
});

test('坑 24：node_names 实现与宿主 extractNodes 同构（按列表项分组）', () => {
  const s = readRel('claude-vm/vm/scripts/tun-merge.py');
  assert.match(s, /def node_names/, '必须有节点解析函数');
  assert.match(s, /r'\^\\s\*-\\s\+\(\.\*\)\$'/, '按 `^\\s*-\\s+` 切分列表项，与宿主一致');
  assert.match(s, /r'\^\\s\+name\\s\*:\\s\*\(\.\+\)\$'/, '项内 name 键不能被漏掉');
});
