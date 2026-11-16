'use strict';
// L1 单元测试：Clash/Mihomo YAML 导入（模块一「容器内内核」的宿主侧纯函数）
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

test('validateClashYaml: 正常配置通过并给出节点列表', () => {
  const r = T.validateClashYaml(SAMPLE);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.hosts, ['38.150.32.117', 'node.example.com']);
});

test('validateClashYaml: 空文件 / 无 proxies / 无 server 一律拒绝（不能放行无出口的网络）', () => {
  assert.strictEqual(T.validateClashYaml('').ok, false);
  assert.strictEqual(T.validateClashYaml('mode: rule\nrules:\n  - MATCH,DIRECT\n').ok, false);
  assert.strictEqual(T.validateClashYaml('proxies:\n  - name: only-name\n    type: vmess\n').ok, false);
});

test('validateClashYaml: DIRECT 模式必须提醒（客机会纠正为 global）', () => {
  const r = T.validateClashYaml(SAMPLE.replace('mode: rule', 'mode: direct'));
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /DIRECT/.test(w)));
});

test('extractNodeHosts: 只取 proxies 段，不把 proxy-groups 里的字段当节点', () => {
  const hosts = T.extractNodeHosts(SAMPLE);
  assert.strictEqual(hosts.length, 2);
  assert.ok(!hosts.includes('PROXY'));
});

test('tunFingerprint: 外部改了 YAML 就必须换指纹，否则会「接管」旧配置的内核', () => {
  const a = T.tunFingerprint(SAMPLE);
  const b = T.tunFingerprint(SAMPLE + '\n# changed\n');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.length, 16);
});

test('readClashYaml: 优先外部路径并读到最新内容；外部文件丢了退回缓存', () => {
  const d = tmpdir();
  try {
    const p = path.join(d, 'external.yaml');   // 别叫 clash.yaml：那是缓存文件名
    fs.writeFileSync(p, SAMPLE);
    const r1 = T.readClashYaml({ clashYamlPath: p }, d);
    assert.strictEqual(r1.ok, true, r1.error);
    assert.strictEqual(r1.source, p);
    assert.strictEqual(r1.validation.hosts.length, 2);

    // 外部工具改了配置：下次启动必须拿到新内容
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

test('cacheClashYaml: 缓存写进 userData，Windows 外还要是 600', () => {
  const d = tmpdir();
  try {
    const p = T.cacheClashYaml(SAMPLE, d);
    assert.strictEqual(path.basename(p), T.CACHE_NAME);
    assert.ok(fs.readFileSync(p, 'utf8').includes('38.150.32.117'));
    // Windows 不实现 POSIX mode，权限语义由 chmod 600（客机侧）与目录 ACL 保证
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
