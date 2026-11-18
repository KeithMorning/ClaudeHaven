'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const available = process.platform !== 'win32' || fs.existsSync(bash);

test('网络检查只执行网络范围，不请求第三方评分或运行隐藏的浏览器检查', { skip: !available }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vm-audit-'));
  try {
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(dir, 'curl'), '#!/bin/sh\necho "$*" >> "$MOCK_CALLS"\ncase "$*" in *ipinfo.io/json*) printf \'{"ip":"203.0.113.8","country":"US","org":"Example"}\';; *api.ipify.org*|*ipinfo.io/ip*|*api.ip.sb*) if [ "$MOCK_INVALID" = 1 ]; then printf "999.999.999.999"; else printf "203.0.113.8"; fi;; esac\n');
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho node >> "$MOCK_HIDDEN"\nexit 1\n');
    fs.writeFileSync(path.join(dir, 'fc-list'), '#!/bin/sh\necho fc-list >> "$MOCK_HIDDEN"\nexit 1\n');
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, 'python3'), '#!/bin/sh\nexec python "$@"\n');
    for (const name of ['curl', 'node', 'fc-list', ...(process.platform === 'win32' ? ['python3'] : [])]) fs.chmodSync(path.join(dir, name), 0o755);
    const script = path.resolve(__dirname, '../../claude-vm/vm/scripts/check-env.sh');
    const args = process.platform === 'win32'
      ? ['-c', 'export PATH="$(cygpath -u "$MOCK_DIR"):$PATH"; export MOCK_CALLS="$(cygpath -u "$MOCK_CALLS")" MOCK_HIDDEN="$(cygpath -u "$MOCK_HIDDEN")"; exec bash "$1" --network-json', 'audit', script]
      : [script, '--network-json'];
    const result = spawnSync(bash, args, {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, MOCK_DIR: dir, MOCK_CALLS: calls, MOCK_HIDDEN: path.join(dir, 'hidden') },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checkcc.total, null);
    const ids = report.groups.map((group) => group.id);
    assert.ok(ids.includes('network'));
    assert.ok(ids.every((id) => ['network', 'consistency'].includes(id)));
    assert.equal(fs.existsSync(path.join(dir, 'hidden')), false);
    assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /checkcc/i);
    assert.equal(report.groups.flatMap((group) => group.items).some((item) => /checkcc|节点延迟/i.test(item.label)), false);
    const consistency = report.groups.flatMap((group) => group.items).find((item) => item.label === '多源出口一致性');
    assert.equal(consistency.status, 'pass');
    const invalid = spawnSync(bash, args, {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, MOCK_DIR: dir, MOCK_CALLS: calls, MOCK_HIDDEN: path.join(dir, 'hidden'), MOCK_INVALID: '1' },
    });
    assert.equal(invalid.status, 0, invalid.stderr);
    const invalidItem = JSON.parse(invalid.stdout).groups.flatMap((group) => group.items).find((item) => item.label === '多源出口一致性');
    assert.equal(invalidItem.status, 'warn');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
