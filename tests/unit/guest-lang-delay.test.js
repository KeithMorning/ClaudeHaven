'use strict';
// L1 单元测试：客机 Python 小工具的关键纯逻辑。
// 坑 25（浏览器语言不跟画像走）与节点延迟展示都靠这两个脚本，
// 只做静态字符串断言太容易假绿，这里真的加载模块跑一遍。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('../loader');

function findPython() {
  for (const c of ['python3', 'python']) {
    try {
      const r = spawnSync(c, ['-c', 'print("ok")'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return c;
    } catch { /* 试下一个 */ }
  }
  return null;
}
const PY = findPython();
const skip = !PY && 'python 不可用，跳过客机脚本单测';

const guest = (name) => path.join(ROOT, 'claude-vm', 'vm', 'scripts', name)
  .replace(/\\/g, '/');

function runPy(body) {
  return spawnSync(PY, ['-c', body], {
    encoding: 'utf8', timeout: 25000, cwd: ROOT,
  });
}

/** 生成加载模块 + 临时 state 目录的前缀，避免碰到真实的 /root 或 /run。 */
const prelude = (file) => `
import importlib.util, json, os, tempfile
spec = importlib.util.spec_from_file_location('g', ${JSON.stringify(guest(file))})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
D = tempfile.mkdtemp()
`;

test('坑 25：CHROME_LANG 优先于 LANG，--set 同时写 accept_languages 与 app_locale',
  { skip }, () => {
    const r = runPy(prelude('chrome-lang.py') + `
m.PROFILE_DIR = D
m.PREFS = os.path.join(D, 'Preferences')
os.environ['CHROME_LANG'] = 'en-US'
os.environ['LANG'] = 'zh_TW.UTF-8'   # 故意冲突：老逻辑会写出繁中
out = m.do_set()
p = json.load(open(m.PREFS, encoding='utf-8'))
assert out['bcp47'] == 'en-US', out
assert p['intl']['accept_languages'] == 'en-US,en', p
assert p['intl']['selected_languages'] == 'en-US,en', p
assert p['intl']['app_locale'] == 'en-US', p
print('OK')
`);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /OK/);
  });

test('坑 25：台北画像把 UI 与请求头都切成繁中，两套画像互不串味', { skip }, () => {
  const r = runPy(prelude('chrome-lang.py') + `
m.PROFILE_DIR = D
m.PREFS = os.path.join(D, 'Preferences')
for want, accept, ui in [('zh-TW', 'zh-TW,zh,en-US,en', 'zh-TW'),
                         ('en-US', 'en-US,en', 'en-US')]:
    os.environ['CHROME_LANG'] = want
    m.do_set()
    p = json.load(open(m.PREFS, encoding='utf-8'))
    assert p['intl']['accept_languages'] == accept, (want, p)
    assert p['intl']['app_locale'] == ui, (want, p)
print('OK')
`);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /OK/);
  });

test('节点延迟：只从注入的 YAML 取真实节点，排除 proxy-groups 与内置策略',
  { skip }, () => {
    const r = runPy(prelude('node-delay.py') + `
cfg = os.path.join(D, 'clash.yaml')
with open(cfg, 'w', encoding='utf-8') as f:
    f.write('''proxies:
  - type: vless
    name: LAX-Cogent-Reality
    server: 1.2.3.4
  - name: TWN-Node
    type: ss
    server: 5.6.7.8
proxy-groups:
  - name: ClaudeVM
    type: select
    proxies:
      - LAX-Cogent-Reality
''')
m.CLASH_CFG = cfg
names = m.node_names_from_yaml()
assert names == ['LAX-Cogent-Reality', 'TWN-Node'], names
print('OK')
`);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /OK/);
  });

test('节点延迟：摘要区分实测毫秒与超时，无数据时不编造数字', { skip }, () => {
  const r = runPy(prelude('node-delay.py') + `
m.STATE = os.path.join(D, 'node-delay.json')
assert m.summary(m.read_state()) == '', '无 state 时必须为空，界面显示「未测」'
with open(m.STATE, 'w', encoding='utf-8') as f:
    json.dump({'ok': True, 'delays': {'LAX': 128, 'TWN': None}}, f)
s = m.summary(m.read_state())
assert 'LAX 128ms' in s and 'TWN ' in s and '超时' in s, s
print('OK')
`);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /OK/);
  });
