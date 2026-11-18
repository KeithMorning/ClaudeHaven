'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bridgeHarness(invoke) {
  const source = fs.readFileSync(path.join(__dirname, '../../claude-tauri/ui/app.js'), 'utf8');
  const code = source.slice(source.indexOf('const clipboardChannel'), source.indexOf('function invalidateCheck'));
  const messages = [];
  const frameWindow = { postMessage: (message, origin) => messages.push({ message, origin }) };
  const frame = { contentWindow: frameWindow, addEventListener() {} };
  let onMessage;
  const context = { $: () => frame, invoke, setInterval() {}, window: { addEventListener: (_, cb) => { onMessage = cb; } } };
  vm.runInNewContext('let sessionStarted = true;\n' + code + '\nthis.tick = syncClipboard;', context);
  return { messages, frameWindow, onMessage, tick: context.tick };
}

test('Tauri 剪贴板只接受来自指定桌面 iframe 和来源的消息', async () => {
  let writes = 0;
  const h = bridgeHarness(async (name) => { if (name === 'clipboard_write_text') writes++; return null; });
  h.onMessage({ origin: 'http://127.0.0.1:6080', source: h.frameWindow, data: { channel: 'claude-vm-clipboard', type: 'ready', connected: true } });
  const data = { channel: 'claude-vm-clipboard', type: 'guest-text', text: 'forged' };
  h.onMessage({ origin: 'http://attacker.example', source: h.frameWindow, data });
  h.onMessage({ origin: 'http://127.0.0.1:6080', source: {}, data });
  await h.tick();
  assert.equal(writes, 0);
});

test('连接建立后同步宿主文本，确认后不反复发送', async () => {
  const h = bridgeHarness(async (name) => name === 'clipboard_read_text' ? '测试文本' : null);
  const event = (data) => h.onMessage({ origin: 'http://127.0.0.1:6080', source: h.frameWindow, data: { channel: 'claude-vm-clipboard', ...data } });
  event({ type: 'ready', connected: true });
  await h.tick();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].message.text, '测试文本');
  event({ type: 'ack', sent: true, id: h.messages[0].message.id });
  await h.tick();
  assert.equal(h.messages.length, 1);
});

test('非文本宿主剪贴板不会阻止用户再次从虚拟机复制相同文本', async () => {
  let host = '同一段文本';
  const writes = [];
  const h = bridgeHarness(async (name, args) => {
    if (name === 'clipboard_write_text') { writes.push(args.text); host = args.text; return null; }
    return host;
  });
  const event = (data) => h.onMessage({ origin: 'http://127.0.0.1:6080', source: h.frameWindow, data: { channel: 'claude-vm-clipboard', ...data } });
  event({ type: 'ready', connected: true });
  await h.tick();
  event({ type: 'ack', sent: true, id: h.messages[0].message.id });
  host = null; // 图片等非文本格式
  await h.tick();
  event({ type: 'guest-text', text: '同一段文本' });
  await h.tick();
  assert.deepEqual(writes, ['同一段文本']);
});

test('宿主文本的回声不会覆盖随后更新的宿主剪贴板', async () => {
  let writes = 0;
  const h = bridgeHarness(async (name) => { if (name === 'clipboard_write_text') writes++; return name === 'clipboard_read_text' ? '旧文本' : null; });
  const event = (data) => h.onMessage({ origin: 'http://127.0.0.1:6080', source: h.frameWindow, data: { channel: 'claude-vm-clipboard', ...data } });
  event({ type: 'ready', connected: true });
  await h.tick();
  event({ type: 'guest-text', text: '旧文本' });
  await h.tick();
  assert.equal(writes, 0);
});

test('Windows 与 Linux 换行格式不同不会形成剪贴板回声', async () => {
  let writes = 0;
  const h = bridgeHarness(async (name) => { if (name === 'clipboard_write_text') writes++; return name === 'clipboard_read_text' ? '第一行\r\n第二行' : null; });
  const event = (data) => h.onMessage({ origin: 'http://127.0.0.1:6080', source: h.frameWindow, data: { channel: 'claude-vm-clipboard', ...data } });
  event({ type: 'ready', connected: true });
  await h.tick();
  event({ type: 'guest-text', text: '第一行\n第二行' });
  await h.tick();
  assert.equal(writes, 0);
});

test('宿主剪贴板在客机事件排队后变化时，不被旧事件覆盖', async () => {
  let host = '原始文本';
  const writes = [];
  const h = bridgeHarness(async (name, args) => {
    if (name === 'clipboard_write_text') { writes.push(args.text); host = args.text; return null; }
    return host;
  });
  const event = (data) => h.onMessage({ origin: 'http://127.0.0.1:6080', source: h.frameWindow, data: { channel: 'claude-vm-clipboard', ...data } });
  event({ type: 'ready', connected: true });
  await h.tick();
  event({ type: 'ack', sent: true, id: h.messages[0].message.id });
  event({ type: 'guest-text', text: '客机排队文本' });
  host = '宿主更新文本';
  await h.tick();
  assert.deepEqual(writes, []);
  assert.equal(h.messages.at(-1).message.text, '宿主更新文本');
});
