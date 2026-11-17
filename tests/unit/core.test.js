'use strict';
// L1 单元测试：基础纯函数（编码 / 路径规范 / 配置合并）
const { test } = require('node:test');
const assert = require('node:assert');
const { loadSegment } = require('../loader');

test('decodeChunk: 纯 UTF-8 输出按 UTF-8 解码', () => {
  const { decodeChunk } = loadSegment('decodeChunk');
  assert.strictEqual(decodeChunk(Buffer.from('hello 世界', 'utf8')), 'hello 世界');
});

test('decodeChunk: 头部含 0x00 判定 wsl.exe 的 UTF-16LE 输出', () => {
  const { decodeChunk } = loadSegment('decodeChunk');
  assert.strictEqual(decodeChunk(Buffer.from('Ubuntu', 'utf16le')), 'Ubuntu');
});

test('normalizeWinPath: 正斜杠与重复反斜杠收敛（指纹漂移坑）', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  assert.strictEqual(normalizeWinPath('C:\\Users\\\\x\\\\y'), 'C:\\Users\\x\\y');
  assert.strictEqual(normalizeWinPath('C:/Users/x/y'), 'C:\\Users\\x\\y');
});

test('normalizeWinPath: UNC 路径保留开头的双反斜杠', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  assert.strictEqual(normalizeWinPath('\\\\server\\share\\dir'), '\\\\server\\share\\dir');
});

test('normalizeWinPath: 去首尾空白，空串安全', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  assert.strictEqual(normalizeWinPath('  C:\\a\\b  '), 'C:\\a\\b');
  assert.strictEqual(normalizeWinPath(''), '');
});

test('normalizeWinPath: POSIX 路径只收敛斜杠，不做反斜杠替换', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  assert.strictEqual(normalizeWinPath('/Users/keith//claude-workspace'), '/Users/keith/claude-workspace');
  assert.strictEqual(normalizeWinPath('/Users/keith/ws/'), '/Users/keith/ws');
  assert.strictEqual(normalizeWinPath('/'), '/');
});

test('defaultConfig: 2.0 单态配置，不再有旧代理/显示模式字段', () => {
  const pathStub = { join: (...a) => a.join('/').replace(/\\/g, '/') };
  const appStub = { getPath: () => '/home/u' };
  const { defaultConfig } = loadSegment('defaultConfig', { path: pathStub, app: appStub });
  const c = defaultConfig();
  assert.strictEqual(c.persona, 'tw-taipei');
  assert.strictEqual(c.selectedNode, '');
  assert.strictEqual(c.clashYamlPath, '');
  assert.strictEqual(c.netGuard, 'strict');
  for (const legacy of ['proxy', 'proxyMode', 'whitelist', 'tunMode', 'displayMode', 'region',
    'tz', 'lang']) {
    assert.ok(!(legacy in c), `2.0 不该再有 ${legacy} 字段（tz/lang 由画像派生，不落盘）`);
  }
});

test('坑 23：mergeCfg 清掉 1.0.x config.json 里残留的 tz / lang', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  const pathStub = { join: (...a) => a.join('/').replace(/\\/g, '/') };
  const appStub = { getPath: () => '/home/u' };
  const { defaultConfig } = loadSegment('defaultConfig', { path: pathStub, app: appStub });
  const { mergeCfg } = loadSegment('mergeCfg', { defaultConfig, normalizeWinPath });
  const cfg = mergeCfg({
    persona: 'us', tz: 'America/Los_Angeles', lang: 'zh_CN.UTF-8',
    selectedNode: 'us-1', workspace: 'C:/w',
  });
  assert.strictEqual(cfg.persona, 'us');
  assert.ok(!('tz' in cfg) && !('lang' in cfg),
    '残留旧时区必须与画像一起被丢弃，否则 spawn 与报告会对不上');
});

test('mergeCfg: 保存值覆盖默认值，workspace 被规范化', () => {
  const { normalizeWinPath } = loadSegment('normalizeWinPath');
  const pathStub = { join: (...a) => a.join('/').replace(/\\/g, '/') };
  const appStub = { getPath: () => '/home/u' };
  const { defaultConfig } = loadSegment('defaultConfig', { path: pathStub, app: appStub });
  const { mergeCfg } = loadSegment('mergeCfg', { defaultConfig, normalizeWinPath });

  const cfg = mergeCfg({ selectedNode: 'us-1', workspace: 'C:/w s//p' });
  assert.strictEqual(cfg.selectedNode, 'us-1');
  assert.strictEqual(cfg.workspace, 'C:\\w s\\p');
  assert.strictEqual(cfg.persona, 'tw-taipei');
  assert.strictEqual(cfg.netGuard, 'strict');
});

test('toWslPath: Windows 盘符路径转 /mnt/<小写盘符>/…', () => {
  const { toWslPath } = loadSegment('toWslPath');
  assert.strictEqual(toWslPath('E:\\Web\\FuckCladue'), '/mnt/e/Web/FuckCladue');
  assert.strictEqual(toWslPath('e:/Users/x'), '/mnt/e/Users/x');
});

test('toWslPath: 已是 WSL 路径或空值原样返回', () => {
  const { toWslPath } = loadSegment('toWslPath');
  assert.strictEqual(toWslPath('/opt/scripts/x.sh'), '/opt/scripts/x.sh');
  assert.strictEqual(toWslPath(''), '');
});

test('cleanWslList: wsl.exe 的 UTF-16LE 空字节与空行全部清洗', () => {
  const { cleanWslList } = loadSegment('cleanWslList');
  assert.deepStrictEqual(cleanWslList('a\0b\r\n\r\n c\n \n'), ['ab', 'c']);
});
