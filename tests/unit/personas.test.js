'use strict';
// L1 单元测试：伪装画像（2.0 只有两套，切换必须带出完整派生字段）
const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../../claude-desktop/app/lib/personas');

test('只有两套画像：台北与美国，id 唯一', () => {
  assert.strictEqual(P.list.length, 2);
  assert.deepStrictEqual(P.list.map((p) => p.id), ['tw-taipei', 'us']);
  assert.strictEqual(new Set(P.list.map((p) => p.id)).size, 2);
});

test('每套画像都有完整派生字段（tz / lang / chromeLang / label）', () => {
  for (const p of P.list) {
    assert.ok(p.tz && p.lang && p.chromeLang && p.label && p.name && p.desc,
      `${p.id} 缺少派生字段，切换后会造成画像不自洽`);
  }
});

test('台北是默认画像：UTC+8 + zh_TW，不在受限名单地区', () => {
  assert.strictEqual(P.byId('tw-taipei').tz, 'Asia/Taipei');
  assert.strictEqual(P.byId('tw-taipei').lang, 'zh_TW.UTF-8');
  assert.strictEqual(P.byId('unknown'), P.list[0], '未知 id 必须回落到默认，不要让界面出现空画像');
});

test('美国画像：UTC-8 洛杉矶（美西）+ 全英文环境', () => {
  const us = P.byId('us');
  assert.strictEqual(us.tz, 'America/Los_Angeles');
  assert.strictEqual(us.lang, 'en_US.UTF-8');
  assert.strictEqual(us.chromeLang, 'en-US');
});

test('坑 25：每套画像的 lang 与 chromeLang 必须自洽，不能切出「英文系统 + 繁中浏览器」', () => {
  for (const p of P.list) {
    const prefix = p.lang.split('.')[0];
    const want = prefix.replace('_', '-');
    assert.strictEqual(p.chromeLang.toLowerCase(), want.toLowerCase(),
      `${p.id}: lang=${p.lang} 与 chromeLang=${p.chromeLang} 不一致`);
  }
});

test('坑 23：applyTo 只写 persona 并清掉旧 tz / lang 残留', () => {
  const cfg = { workspace: 'C:\\ws', selectedNode: 'us-1', netGuard: 'strict', persona: 'tw-taipei',
    tz: 'America/Los_Angeles', lang: 'zh_CN.UTF-8' };
  const next = P.applyTo(cfg, 'us');
  assert.strictEqual(next.persona, 'us');
  assert.ok(!('tz' in next) && !('lang' in next),
    'tz / lang 是画像派生值，不落盘；存两份就会出现画像与环境分叉');
  assert.strictEqual(cfg.tz, 'America/Los_Angeles', '不能原地改传入对象');
  assert.strictEqual(next.selectedNode, 'us-1', '切画像不该把节点选择清掉');
  assert.strictEqual(next.workspace, cfg.workspace);
  assert.notStrictEqual(next, cfg, '不该原地改对象（渲染层依赖新引用触发重绘）');
});

test('画像派生字段与 env 语义一致（byId 是唯一真源）', () => {
  assert.strictEqual(P.byId('us').tz, 'America/Los_Angeles');
  assert.strictEqual(P.byId('us').lang, 'en_US.UTF-8');
  assert.strictEqual(P.byId('tw-taipei').tz, 'Asia/Taipei');
  assert.strictEqual(P.byId('tw-taipei').chromeLang, 'zh-TW');
});

test('坑 25：只有两套画像，且都带 chromeLang（浏览器语言的唯一真源）', () => {
  assert.deepStrictEqual(P.list.map((p) => p.tz), ['Asia/Taipei', 'America/Los_Angeles']);
  for (const p of P.list) {
    assert.ok(p.chromeLang, `${p.id} 缺 chromeLang，主进程无法下发 CHROME_LANG`);
  }
});
