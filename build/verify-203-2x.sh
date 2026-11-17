#!/usr/bin/env bash
# 2.0.3 真实客机验证：语言落地 / 配置生成 / 内核校验 / 延迟脚本降级。
# 全程不碰路由表、不碰真实 Chrome Profile、不启动正式内核。
echo "=== 1. 客机脚本是否为 2.0.3 版本 ==="
for f in chrome-lang.py chrome-login.sh show-welcome.sh entrypoint.sh tun-merge.py node-delay.py check-env.sh; do
  printf '  %-20s ' "$f"
  if [ -f "/opt/scripts/$f" ]; then md5sum "/opt/scripts/$f" | cut -c1-8; else echo MISSING; fi
done

echo "=== 2. chrome-lang.py 两套画像落地（临时 Profile，故意让 LANG 冲突）==="
python3 - <<'PY'
import importlib.util, json, os, tempfile
spec = importlib.util.spec_from_file_location('cl', '/opt/scripts/chrome-lang.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
D = tempfile.mkdtemp()
m.PROFILE_DIR = D; m.PREFS = os.path.join(D, 'Preferences')
os.environ['LANG'] = 'zh_TW.UTF-8'   # 与 CHROME_LANG 故意冲突
for want, accept in [('zh-TW', 'zh-TW,zh,en-US,en'), ('en-US', 'en-US,en')]:
    os.environ['CHROME_LANG'] = want
    out = m.do_set()
    d = json.load(open(m.PREFS, encoding='utf-8'))
    print('  %-6s -> bcp47=%-6s accept=%-20s app_locale=%s' % (
        want, out['bcp47'], d['intl']['accept_languages'], d['intl'].get('app_locale')))
    assert out['bcp47'] == want, out
    assert d['intl']['app_locale'] == want, d
    assert d['intl']['accept_languages'] == accept, d
print('  OK: CHROME_LANG 优先 + UI 语言写入')
PY

echo "=== 3. tun-merge.py 生成配置（monkeypatch，不碰路由表 / 不发 DNS）==="
python3 - <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location('tm', '/opt/scripts/tun-merge.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.load_net_guard = lambda: None
m.resolve = lambda h: '1.2.3.4'
sys.argv = ['tun-merge.py', '/opt/config/clash.yaml', '/tmp/mihomo-203-test.yaml', 'LAX-Cogent-Reality']
rc = m.main()
s = open('/tmp/mihomo-203-test.yaml', encoding='utf-8').read()
print('  merge rc =', rc)
for l in s.splitlines():
    if l.startswith('external-controller') or l.startswith('mode:'):
        print('   ', l)
assert rc == 0
assert 'external-controller: 127.0.0.1:9090' in s
assert 'external-controller-pipe' not in s, '订阅里的 Windows 管道没剥干净'
assert 'MATCH,ClaudeVM' in s
print('  OK: 本地控制 API + 单节点规则')
PY

echo "=== 4. mihomo 内核自带配置校验 ==="
mihomo -t -d /opt/mihomo -f /tmp/mihomo-203-test.yaml 2>&1 | tail -6

echo "=== 5. node-delay.py 内核未起时的降级输出（应 ok=false，不编数字）==="
python3 /opt/scripts/node-delay.py 2>&1 | head -3
echo "=== 6. --summary 无 state 时应为空 ==="
python3 /opt/scripts/node-delay.py --summary 2>&1 | head -3
echo "=== 7. 语法检查 ==="
bash -n /opt/scripts/chrome-login.sh && echo "  chrome-login.sh OK"
bash -n /opt/scripts/show-welcome.sh && echo "  show-welcome.sh OK"
bash -n /opt/scripts/entrypoint.sh && echo "  entrypoint.sh OK"
bash -n /opt/scripts/check-env.sh && echo "  check-env.sh OK"
python3 -m py_compile /opt/scripts/node-delay.py && echo "  node-delay.py OK"
python3 -m py_compile /opt/scripts/chrome-lang.py && echo "  chrome-lang.py OK"
