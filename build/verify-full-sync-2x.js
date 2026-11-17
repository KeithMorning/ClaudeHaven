'use strict';
// 模拟主进程 syncScripts 的完整命令（含 assets / openbox / 清理残留），
// 在真实 WSL 里跑一遍并校验 md5。只读校验 + 幂等覆盖，不启动 VM。
const { execFile } = require('child_process');
const path = require('path');
const G = require('../claude-desktop/app/lib/guest-cmd');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'claude-desktop', 'runtime', 'scripts');
const manifest = G.localScriptManifest(dir);
const wslDir = '/mnt/e/Web/FuckCladue/claude-desktop/runtime/scripts';
const assetsDir = '/mnt/e/Web/FuckCladue/claude-desktop/runtime/assets';

const assetsCmd = `mkdir -p /opt/assets && cp -rf '${assetsDir}/.' /opt/assets/ 2>/dev/null`;
const openboxCmd = [
  'if [ -f /opt/assets/config/openbox-rc.xml ]; then',
  'mkdir -p /root/.config/openbox;',
  'cp -f /opt/assets/config/openbox-rc.xml /root/.config/openbox/rc.xml;',
  'cp -f /opt/assets/config/openbox-rc.xml /opt/config/openbox-rc.xml;',
  "pgrep -x openbox >/dev/null 2>&1 && DISPLAY=:1 openbox --reconfigure >/dev/null 2>&1 || true;",
  'fi',
].join(' ');

const script = G.buildSyncScript({
  scriptsPath: wslDir, assetsCmd, openboxCmd, remove: ['proxy-router.js'],
});
const argv = G.bashViaBase64(script);

console.log('宿主脚本数:', manifest.size, ' 脚本字节:', script.length,
  ' 命令行长度:', argv[2].length, ' 含裸 $:', argv[2].includes('$'));

execFile('wsl.exe', ['-d', 'claude-vm', '-u', 'root', '--', ...argv],
  { windowsHide: true, maxBuffer: 1024 * 1024 * 8, timeout: 60000 },
  (err, stdout) => {
    const out = String(stdout || '').replace(/\0/g, '');
    console.log('exec 错误:', err ? err.message : 'null');
    const r = G.verifySync(out, manifest);
    console.log('verifySync:', JSON.stringify(r));
    console.log('客机回报文件数:', G.parseSyncFiles(out).size);
    console.log('客机 stderr 之类警告已在 stderr，不影响 stdout 校验');
    process.exitCode = r.ok ? 0 : 1;
  });
