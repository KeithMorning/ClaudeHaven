'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const vm = path.join(root, 'claude-vm/vm');
const runtime = path.join(root, 'claude-tauri/runtime');

test('运行时脚本与资源从唯一源同步且逐字节一致', () => {
  const result = spawnSync(process.execPath, ['scripts/sync-runtime.js'], { cwd: path.join(root, 'claude-tauri'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const entry of fs.readdirSync(path.join(vm, 'scripts'), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    assert.deepEqual(fs.readFileSync(path.join(runtime, 'scripts', entry.name)), fs.readFileSync(path.join(vm, 'scripts', entry.name)), entry.name);
  }
  for (const [source, target] of [
    ['config/novnc/desktop.html', 'novnc/desktop.html'],
    ['assets/novnc-1.7.0.tgz', 'novnc/novnc-1.7.0.tgz'],
    ['assets/rime/wanxiang-pure.zip', 'rime/wanxiang-pure.zip'],
  ]) assert.deepEqual(fs.readFileSync(path.join(runtime, 'assets', target)), fs.readFileSync(path.join(vm, source)), source);
});

test('Tauri 打包配置包含虚拟机镜像与运行时资源', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'claude-tauri/src-tauri/tauri.conf.json'), 'utf8'));
  const targets = Object.values(config.bundle.resources);
  assert.ok(targets.includes('runtime/rootfs.tar.gz'));
  assert.ok(targets.includes('runtime/scripts/'));
  assert.ok(targets.includes('runtime/assets/'));
});

test('运行时 Shell 脚本语法正确', (t) => {
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'] : ['bash'];
  const bash = candidates.find((name) => spawnSync(name, ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0);
  if (!bash) return t.skip('未找到可运行的 Bash');
  for (const entry of fs.readdirSync(path.join(vm, 'scripts'))) {
    if (!entry.endsWith('.sh')) continue;
    const result = spawnSync(bash, ['-n', path.join(vm, 'scripts', entry)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${entry}: ${result.stderr}`);
  }
});

test('网络守卫在桌面服务启动之前启动', () => {
  const script = fs.readFileSync(path.join(vm, 'scripts/entrypoint.sh'), 'utf8');
  assert.ok(script.indexOf('/opt/scripts/tun-core.sh &') > 0);
  assert.ok(script.indexOf('/opt/scripts/net-guard.sh &') > script.indexOf('/opt/scripts/tun-core.sh &'));
  assert.ok(script.indexOf('websockify --web=') > script.indexOf('/opt/scripts/net-guard.sh &'));
});
