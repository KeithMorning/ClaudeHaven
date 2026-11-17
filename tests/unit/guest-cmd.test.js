'use strict';
// L1 单元测试：坑 23 —— 客机脚本同步命令与「真实落地」校验。
// 回归目标：不能再把含 $ 的脚本内联进 wsl.exe 的 bash -c（$ 会被吞），
// 也不能只凭末尾 SYNCED 就判定同步成功（cp 全失败时它照样打印）。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('../../claude-desktop/app/lib/guest-cmd');

const md5 = (s) => require('crypto').createHash('md5').update(s).digest('hex');

test('bashViaBase64: argv 里不含任何 $，且能无损还原脚本', () => {
  const script = 'X=hello; echo "X=$X"; for f in /a/*; do b=$(basename "$f"); echo "$b"; done';
  const argv = G.bashViaBase64(script);
  assert.deepStrictEqual(argv.slice(0, 2), ['bash', '-c']);
  assert.ok(!argv[2].includes('$'), '命令行含裸 $ 就会被 wsl.exe 吞掉');
  assert.match(argv[2], /^echo '[A-Za-z0-9+/=]+' \| base64 -d \| bash$/);
  assert.strictEqual(G.decodeBashArgv(argv), script);
});

test('bashViaBase64: 中文与换行也无损（避免 UTF-8/CRLF 中毒）', () => {
  const script = '# 中文注释\necho "你好"\nprintf "a\\nb\\n"';
  assert.strictEqual(G.decodeBashArgv(G.bashViaBase64(script)), script);
});

test('buildSyncScript: 脚本内部保留 $ 变量与原子替换，末尾回报 md5', () => {
  const s = G.buildSyncScript({
    scriptsPath: '/mnt/c/Program Files/Claude VM/resources/scripts',
    assetsCmd: "mkdir -p /opt/assets && cp -rf '/mnt/x/assets/.' /opt/assets/ 2>/dev/null",
    openboxCmd: 'if [ -f /opt/assets/config/openbox-rc.xml ]; then echo ok; fi',
    remove: ['proxy-router.js'],
  });
  assert.match(s, /b=\$\(basename "\$f"\)/, 'base64 之后脚本内部仍必须能用 $');
  assert.match(s, /\/\.\$b\.tmp/, '原子替换：先写 .tmp 再 mv，不能就地截断');
  assert.match(s, /mv -f/);
  assert.match(s, /rm -f \/opt\/scripts\/proxy-router\.js/, '清理 1.0.x 残留');
  assert.match(s, /md5sum "\$f"/, '必须回报逐文件 md5 供宿主比对');
  assert.match(s, /^echo SYNCED$/m, 'SYNCED 仍作为「脚本跑完」标记');
  assert.ok(s.includes("'/mnt/c/Program Files/Claude VM/resources/scripts'/*"),
    '带空格路径要整体加引号，glob 星号留在外面');
});

test('parseSyncFiles: 解析 md5sum 行、忽略杂行、清洗 wsl.exe 的 \\0', () => {
  const a = md5('entrypoint'), b = md5('netguard');
  const out = [
    'wsl: 一些警告',
    `${a}  /opt/scripts/entrypoint.sh`,
    `${b}\0  /opt/scripts/net-guard.sh`,
    'SYNCED',
  ].join('\n');
  const got = G.parseSyncFiles(out);
  assert.strictEqual(got.get('entrypoint.sh'), a);
  assert.strictEqual(got.get('net-guard.sh'), b);
  assert.strictEqual(got.size, 2);
});

test('verifySync: 只有 SYNCED 但 md5 全错 → 判失败（坑 23 假绿回归）', () => {
  const manifest = new Map([['entrypoint.sh', md5('new')]]);
  const fake = `${md5('old')}  /opt/scripts/entrypoint.sh\nSYNCED\n`;
  const r = G.verifySync(fake, manifest);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'scripts-mismatch');
  assert.match(r.detail, /entrypoint\.sh/);
});

test('verifySync: 没有任何文件回报时也不能算成功', () => {
  const r = G.verifySync('SYNCED\n', new Map([['entrypoint.sh', md5('new')]]));
  assert.strictEqual(r.ok, false);
});

test('verifySync: 脚本没跑完（缺 SYNCED）→ sync-incomplete', () => {
  const h = md5('new');
  const r = G.verifySync(`${h}  /opt/scripts/entrypoint.sh\n`,
    new Map([['entrypoint.sh', h]]));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'sync-incomplete');
});

test('verifySync: 逐文件 md5 全对 → 才返回 ok 与文件数', () => {
  const manifest = new Map([
    ['entrypoint.sh', md5('a')], ['net-guard.sh', md5('b')],
  ]);
  const out = [
    `${manifest.get('entrypoint.sh')}  /opt/scripts/entrypoint.sh`,
    `${manifest.get('net-guard.sh')}  /opt/scripts/net-guard.sh`,
    `${md5('extra')}  /opt/scripts/tunnel.sh`, // 客机侧残留不算错
    'SYNCED',
  ].join('\n');
  assert.deepStrictEqual(G.verifySync(out, manifest), { ok: true, count: 2 });
});

test('localScriptManifest: 只读普通文件，md5 与内容一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudevm-manifest-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.sh'), 'hello');
    fs.writeFileSync(path.join(dir, 'b.py'), 'world');
    fs.mkdirSync(path.join(dir, 'sub'));
    const m = G.localScriptManifest(dir);
    assert.strictEqual(m.size, 2);
    assert.strictEqual(m.get('a.sh'), md5('hello'));
    assert.strictEqual(m.get('b.py'), md5('world'));
    assert.strictEqual(G.localScriptManifest(path.join(dir, '不存在')).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：buildSyncScript 编码后的 argv 不含 $，解码回来仍能执行', () => {
  const s = G.buildSyncScript({ scriptsPath: '/mnt/x/scripts' });
  const argv = G.bashViaBase64(s);
  assert.ok(!argv[2].includes('$'));
  assert.strictEqual(G.decodeBashArgv(argv), s);
});
