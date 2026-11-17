'use strict';
// 真实环境验证：用 app/lib/guest-cmd.js 生成的命令，把 runtime/scripts 同步进 WSL，
// 再用 verifySync 校验 md5。只读校验 + 幂等覆盖，不启动 VM。
const { execFile } = require('child_process');
const path = require('path');
const G = require('../claude-desktop/app/lib/guest-cmd');

const dir = path.resolve(__dirname, '..', 'claude-desktop', 'runtime', 'scripts');
const manifest = G.localScriptManifest(dir);
const wslDir = '/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts';
const script = G.buildSyncScript({ scriptsPath: wslDir, remove: ['proxy-router.js'] });
const argv = G.bashViaBase64(script);

console.log('宿主脚本数:', manifest.size, ' 命令行长度:', argv[2].length,
  ' 含裸 $:', argv[2].includes('$'));

execFile('wsl.exe', ['-d', 'claude-vm', '-u', 'root', '--', ...argv],
  { windowsHide: true, maxBuffer: 1024 * 1024 * 8, timeout: 60000 },
  (err, stdout, stderr) => {
    const out = String(stdout || '').replace(/\0/g, '');
    console.log('exec 错误:', err ? err.message : 'null');
    const r = G.verifySync(out, manifest);
    console.log('verifySync:', JSON.stringify(r));
    const got = G.parseSyncFiles(out);
    console.log('客机回报文件数:', got.size);
    if (String(stderr || '').trim()) console.log('stderr:', String(stderr).trim().slice(0, 200));
    process.exitCode = r.ok ? 0 : 1;
  });
