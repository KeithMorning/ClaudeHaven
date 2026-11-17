#!/usr/bin/env bash
# 只读诊断：真实 Chrome 的语言状态 + 内核/延迟数据来源
echo "=== 1. mihomo 进程 ==="
pgrep -a -x mihomo || echo "  未运行"
echo "=== 2. 生成的 mihomo.yaml 里是否有 external-controller ==="
grep -n "external-controller\|^port:\|^socks-port:\|^mode:" /opt/config/mihomo.yaml 2>/dev/null || echo "  无 mihomo.yaml 或无该字段"
echo "=== 3. 9090 端口监听 ==="
ss -ltn 2>/dev/null | grep 9090 || echo "  无 9090 监听"
echo "=== 4. mihomo API /version 试探 ==="
curl -s --max-time 4 http://127.0.0.1:9090/version 2>/dev/null | head -c 200 || echo "  API 不可达"
echo
echo "=== 5. 真实 Chrome Profile 的 intl 字段 ==="
python3 - <<'PY'
import json, os
p = '/root/.config/google-chrome/Default/Preferences'
try:
    d = json.load(open(p, encoding='utf-8'))
    print('  accept_languages =', (d.get('intl') or {}).get('accept_languages'))
    print('  selected_languages=', (d.get('intl') or {}).get('selected_languages'))
    print('  app_locale        =', (d.get('intl') or {}).get('app_locale'))
    print('  intl 全字段       =', json.dumps(d.get('intl'), ensure_ascii=False)[:300])
except Exception as e:
    print('  读取失败:', type(e).__name__, e)
ls = '/root/.config/google-chrome/Local State'
try:
    d = json.load(open(ls, encoding='utf-8'))
    print('  Local State intl  =', json.dumps(d.get('intl'), ensure_ascii=False)[:300])
except Exception as e:
    print('  Local State 读取失败:', type(e).__name__)
PY
echo "=== 6. 运行中的 Chrome 进程 --lang 参数 ==="
for p in $(pgrep -x chrome); do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null; echo; done | grep -o -- '--lang=[^ ]*' | sort -u || echo "  无 chrome 进程或未带 --lang"
echo "=== 7. chrome-lang.py --show ==="
python3 /opt/scripts/chrome-lang.py --show 2>/dev/null || echo "  脚本不可用"
echo "=== 8. runtime-env 关键项 ==="
grep -E "TZ=|LANG=|LC_ALL=|LANGUAGE=|TUN_NODE=" /opt/config/runtime-env 2>/dev/null || echo "  无 runtime-env"
echo "=== 9. 出口 ipinfo（内核在跑时应有 timezone）==="
curl -s --max-time 8 https://ipinfo.io/json 2>/dev/null | head -c 400 || echo "  探测失败（内核未起或网络未通）"
echo
echo "=== 10. net-guard.state 现有字段 ==="
head -20 /run/claude-vm/net-guard.state 2>/dev/null || echo "  无 state"
