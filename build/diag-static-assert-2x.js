'use strict';
// 验证「内联 bash -c 不得含裸 $」静态断言是否真的能抓到旧写法。
const fs = require('fs');
const S = fs.readFileSync('claude-desktop/app/main.js', 'utf8');

function capture(src) {
  // 到 `], { timeout` 才收尾，避免命令文本里的 ] 提前截断
  return [...src.matchAll(/\['bash',\s*'-c',\s*([\s\S]*?)\],\s*\{\s*timeout/g)]
    .map((m) => m[1]);
}
function offenders(calls) {
  const bad = [];
  for (const c of calls) {
    for (const line of c.replace(/\$\{[A-Za-z_][\w.]*\}/g, '').split('\n')) {
      if (/\$[A-Za-z_(]/.test(line)) bad.push(line.trim());
    }
  }
  return bad;
}

const real = capture(S);
console.log('实际捕获调用数:', real.length);
console.log('实际违规行:', offenders(real));
for (let i = 0; i < real.length; i++) console.log(`  [${i}] ${real[i].slice(0, 90).replace(/\n/g, ' ⏎ ')}`);

// 故意注入旧写法（含 shell 变量），断言必须报违规
const legacy = "  const r = await runWsl(['bash', '-c', `for f in '${dir}'/*; do b=$(basename \"$f\"); cp -f \"$f\" \"/opt/scripts/$b\"; done`], { timeout: 30000 });";
const fake = capture(legacy);
console.log('\n注入旧写法捕获数:', fake.length);
console.log('注入旧写法违规行:', offenders(fake));
if (!offenders(fake).length) { console.log('FAIL: 断言抓不到旧写法'); process.exit(1); }
console.log('OK: 断言能抓到旧写法');
