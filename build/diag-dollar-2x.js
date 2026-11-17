'use strict';
// 对照实验：经 wsl.exe bash -c 传参时，哪些字符会被吞
const { execFile } = require('child_process');

const cases = [
  ['A 无空格路径 + $f', "for f in /etc/hostname /etc/hosts; do echo \"F=$f\"; done"],
  ['B 带空格路径 + $f', "for f in '/mnt/c/Users/KeithXi/AppData/Local/Programs/Claude VM/resources/scripts'/*; do echo \"F=$f\"; done"],
  ['C 简单变量', "X=hello; echo \"X=$X\""],
  ['D 命令替换', "for f in /etc/hostname /etc/hosts; do b=$(basename \"$f\"); echo \"B=$b\"; done"],
];

function run(label, body) {
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-d', 'claude-vm', '-u', 'root', '--', 'bash', '-c', body],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 8, timeout: 30000 },
      (err, stdout) => {
        const out = String(stdout || '').replace(/\0/g, '').trim();
        const lines = out.split('\n').filter(Boolean).filter(l => !/^wsl:/.test(l));
        console.log(`--- ${label} ---`);
        console.log('  err:', err ? err.message : 'null');
        console.log('  行数:', lines.length, ' 首行:', JSON.stringify(lines[0] || ''));
        console.log('  次行:', JSON.stringify(lines[1] || ''));
        resolve();
      });
  });
}

(async () => {
  for (const [label, body] of cases) await run(label, body);
})();
