'use strict';
// 客机脚本同步：命令生成 + 真实落地校验。纯 Node 模块，主进程与单测共用。
//
// 坑 23（2026-11-17）：Windows 上 `wsl.exe -d ... -- bash -c <cmd>` 会把命令里的
// `$var` / `$(...)` 吞掉 —— 实测 `X=hello; echo "X=$X"` 输出 `X=`（空），
// 与安装路径是否带空格无关；写成 .sh 文件执行、或 base64 管道喂给 bash 都正常。
// 旧 syncScripts() 内联了 `for f in ...; do b=$(basename "$f"); cp -f "$f" ...`，
// $f/$b 全变空 → cp 全部失败被 `2>/dev/null` 吞掉 → 末尾 `echo SYNCED` 照常打印
// → 主进程判定同步成功（假绿）→ 发行版里一直跑 1.0.37 的旧脚本。
//
// 所以这里：整段脚本 base64 后由管道交给 bash（命令行只含 A-Za-z0-9+/= 与单引号/管道），
// 并且同步完成后由客机回报每个文件的 md5，宿主逐个比对才算成功 —— 不再只认 SYNCED。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 把一段 shell 脚本编码成不经过 Windows 命令行变量展开的 guest argv。 */
function bashViaBase64(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return ['bash', '-c', `echo '${b64}' | base64 -d | bash`];
}

/** 单测/诊断用：从 argv 还原原始脚本，确认编码无损。 */
function decodeBashArgv(argv) {
  const cmd = Array.isArray(argv) ? argv[2] : '';
  const m = /^echo '([A-Za-z0-9+/=]+)' \| base64 -d \| bash$/.exec(String(cmd || ''));
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : null;
}

/** 宿主侧脚本清单：name -> md5。作为「同步是否真的落地」的判据。 */
function localScriptManifest(dir) {
  const out = new Map();
  if (!dir || !fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!fs.statSync(p).isFile()) continue;
    out.set(name, crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'));
  }
  return out;
}

/**
 * 生成客机侧同步脚本。注意脚本内部可以自由使用 $，因为它不经过 wsl.exe 参数解析。
 * 原子替换仍然保留：先写 .tmp 再 mv，避免就地截断正在被 bash 逐行读取的 entrypoint.sh。
 */
function buildSyncScript(o) {
  const lines = [
    'mkdir -p /opt/scripts',
    `for f in '${o.scriptsPath}'/*; do b=$(basename "$f"); cp -f "$f" "/opt/scripts/.$b.tmp" 2>/dev/null && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"; done`,
    'chmod +x /opt/scripts/*.sh 2>/dev/null',
    // 1.0.x 遗留脚本：2.0 已从真源删除，但旧发行版 /opt/scripts 里还留着
    ...(o.remove || []).map((n) => `rm -f /opt/scripts/${n}`),
    o.assetsCmd,
    o.openboxCmd,
    // 回报真实落地结果：逐文件 md5，由宿主比对
    'for f in /opt/scripts/*; do [ -f "$f" ] || continue; md5sum "$f"; done',
    'echo SYNCED',
  ].filter(Boolean);
  return lines.join('\n');
}

/** 解析客机回报的 md5sum 行（格式：`<32hex>  /opt/scripts/<name>`）。 */
function parseSyncFiles(stdout) {
  const out = new Map();
  // wsl.exe 的输出偶尔混入 UTF-16LE 的 \0，先清掉再按行解析
  for (const line of String(stdout || '').replace(/\0/g, '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{32})\s+\/opt\/scripts\/([^\s]+)\s*$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** 真正判定同步成功：SYNCED 只是「脚本跑完了」，md5 全对才算数。 */
function verifySync(stdout, manifest) {
  const s = String(stdout || '').replace(/\0/g, '');
  if (!/(^|\n)SYNCED(\r?\n|$)/.test(s)) {
    return { ok: false, reason: 'sync-incomplete' };
  }
  const got = parseSyncFiles(s);
  const bad = [...manifest.keys()].filter((n) => got.get(n) !== manifest.get(n));
  if (bad.length) {
    return { ok: false, reason: 'scripts-mismatch', detail: bad.join(', ') };
  }
  return { ok: true, count: manifest.size };
}

module.exports = {
  bashViaBase64, decodeBashArgv, localScriptManifest,
  buildSyncScript, parseSyncFiles, verifySync,
};
