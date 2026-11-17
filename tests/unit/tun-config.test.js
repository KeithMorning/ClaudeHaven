'use strict';
// L1 单元测试：Clash/Mihomo YAML 导入与节点选择（2.0 单态 TUN 的宿主侧纯函数）
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../../claude-desktop/app/lib/tun-config');

const SAMPLE = [
  'port: 7890',
  'mode: rule',
  'proxies:',
  '  - name: us-1',
  '    type: vmess',
  '    server: 38.150.32.117',
  '    port: 443',
  '  - name: hk-1',
  '    type: trojan',
  '    server: node.example.com',
  '    port: 443',
  'proxy-groups:',
  '  - name: PROXY',
  '    type: select',
  '    proxies: [us-1, hk-1]',
  'rules:',
  '  - MATCH,PROXY',
  '',
].join('\n');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudevm-tun-'));
}

test('extractNodes: 解析出节点名 / 类型 / server，保序去重', () => {
  const nodes = T.extractNodes(SAMPLE);
  assert.deepStrictEqual(nodes, [
    { name: 'us-1', type: 'vmess', server: '38.150.32.117' },
    { name: 'hk-1', type: 'trojan', server: 'node.example.com' },
  ]);
});

test('extractNodes: 中文/带空格/带引号的节点名都能正确解析', () => {
  const y = [
    'proxies:',
    '  - name: "美国 节点 01"',
    '    type: ss',
    '    server: 1.1.1.1',
    '  - name: 香港-02',
    '    server: 2.2.2.2',
  ].join('\n');
  const nodes = T.extractNodes(y);
  assert.strictEqual(nodes[0].name, '美国 节点 01');
  assert.strictEqual(nodes[1].name, '香港-02');
  assert.strictEqual(nodes[1].type, '');
});

test('extractNodes: 不把 proxy-groups / rules 里的字段当节点', () => {
  const nodes = T.extractNodes(SAMPLE);
  assert.ok(!nodes.some((n) => n.name === 'PROXY'));
  assert.strictEqual(nodes.length, 2);
});

test('validateClashYaml: 正常配置通过并给出 nodes / hosts', () => {
  const r = T.validateClashYaml(SAMPLE);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.hosts, ['38.150.32.117', 'node.example.com']);
  assert.deepStrictEqual(r.nodes.map((n) => n.name), ['us-1', 'hk-1']);
  assert.ok(r.warnings.some((w) => /分流规则/.test(w)), '全量单节点要提示忽略订阅分流');
});

test('validateClashYaml: 空文件 / 无 proxies / 无 server 一律拒绝', () => {
  assert.strictEqual(T.validateClashYaml('').ok, false);
  assert.strictEqual(T.validateClashYaml('mode: rule\nrules:\n  - MATCH,DIRECT\n').ok, false);
  assert.strictEqual(T.validateClashYaml('proxies:\n  - name: only-name\n    type: vmess\n').ok, false);
});

test('validateClashYaml: DIRECT 模式必须提醒（客机会纠正为 global）', () => {
  const r = T.validateClashYaml(SAMPLE.replace('mode: rule', 'mode: direct'));
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /DIRECT/.test(w)));
});

test('selectedNode: 选中的存在则用之，失效/未选则退回第一个节点', () => {
  assert.strictEqual(T.selectedNode({ selectedNode: 'hk-1' }, SAMPLE), 'hk-1');
  assert.strictEqual(T.selectedNode({ selectedNode: 'gone' }, SAMPLE), 'us-1');
  assert.strictEqual(T.selectedNode({}, SAMPLE), 'us-1');
  assert.strictEqual(T.selectedNode({}, 'proxies: []\n'), '');
});

test('tunFingerprint: 外部改了 YAML 就必须换指纹', () => {
  const a = T.tunFingerprint(SAMPLE);
  const b = T.tunFingerprint(SAMPLE + '\n# changed\n');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.length, 16);
});

test('base64Chunks: 分块不超 8000 且可无损还原（Windows 命令行上限）', () => {
  const text = '节点: 美国 01\n'.repeat(5000);
  const chunks = T.base64Chunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= T.CHUNK));
  assert.ok(chunks.every((c) => /^[A-Za-z0-9+/=]*$/.test(c)), '块内必须只含 base64 安全字符');
  assert.strictEqual(Buffer.from(chunks.join(''), 'base64').toString('utf8'), text);
});

test('readClashYaml: 优先外部路径并读到最新内容；外部文件丢了退回缓存', () => {
  const d = tmpdir();
  try {
    const p = path.join(d, 'external.yaml');
    fs.writeFileSync(p, SAMPLE);
    const r1 = T.readClashYaml({ clashYamlPath: p }, d);
    assert.strictEqual(r1.ok, true, r1.error);
    assert.strictEqual(r1.source, p);
    assert.strictEqual(r1.validation.nodes.length, 2);

    fs.writeFileSync(p, SAMPLE.replace('38.150.32.117', '1.2.3.4'));
    const r2 = T.readClashYaml({ clashYamlPath: p }, d);
    assert.ok(r2.text.includes('1.2.3.4'));

    T.cacheClashYaml(SAMPLE, d);
    fs.unlinkSync(p);
    const r3 = T.readClashYaml({ clashYamlPath: p }, d);
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.source, 'cache');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('cacheClashYaml: 缓存写进 userData，Windows 外是 600', () => {
  const d = tmpdir();
  try {
    const p = T.cacheClashYaml(SAMPLE, d);
    assert.strictEqual(path.basename(p), T.CACHE_NAME);
    assert.ok(fs.readFileSync(p, 'utf8').includes('38.150.32.117'));
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
