'use strict';
// 只读复现：主进程 syncScripts() 通过 execFile('wsl.exe', ...) 传 bash -c 命令时，
// 带空格安装路径的 glob 是否还能匹配到文件。不复制、不修改任何文件。
const { execFile } = require('child_process');

const wslDir = '/mnt/c/Users/KeithXi/AppData/Local/Programs/Claude VM/resources/scripts';

// 与 main.js syncScripts 完全同构的拼接方式
const sh = [
  'echo BEGIN',
  `for f in '${wslDir}'/*; do echo "F=$f"; done`,
  'echo SYNCED',
].join('; ');

console.log('=== 待传给 bash -c 的命令 ===');
console.log(sh.slice(0, 300));
console.log('=== 用与 runGuest 相同的 argv 调用 wsl.exe ===');

execFile('wsl.exe',
  ['-d', 'claude-vm', '-u', 'root', '--', 'bash', '-c', sh],
  { windowsHide: true, maxBuffer: 1024 * 1024 * 8, timeout: 30000 },
  (err, stdout, stderr) => {
    const clean = (s) => String(s || '').replace(/\0/g, '');
    const out = clean(stdout);
    console.log('err:', err ? err.message : 'null');
    console.log('stdout 行数:', out.split('\n').filter(Boolean).length);
    console.log('匹配到 F= 行数:', (out.match(/^F=/gm) || []).length);
    console.log('含 SYNCED:', /SYNCED/.test(out));
    console.log('--- 前 12 行 ---');
    console.log(out.split('\n').filter(Boolean).slice(0, 12).join('\n'));
    if (clean(stderr).trim()) console.log('--- stderr ---\n' + clean(stderr).trim().slice(0, 500));
  });
