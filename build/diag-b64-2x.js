'use strict';
const { execFile } = require('child_process');
const inner = 'X=hello; echo "X=$X"; for f in /etc/hostname /etc/hosts; do b=$(basename "$f"); echo "B=$b"; done';
const b64 = Buffer.from(inner, 'utf8').toString('base64');
// 方案：整条命令 base64 传进去，命令行里不含任何 $
const sh = `echo '${b64}' | base64 -d | bash`;
execFile('wsl.exe', ['-d', 'claude-vm', '-u', 'root', '--', 'bash', '-c', sh],
  { windowsHide: true, maxBuffer: 1024 * 1024 * 8, timeout: 30000 },
  (err, stdout) => {
    const out = String(stdout || '').replace(/\0/g, '').trim();
    console.log('err:', err ? err.message : 'null');
    console.log('输出:', JSON.stringify(out));
  });
