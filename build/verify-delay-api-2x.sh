#!/usr/bin/env bash
# 临时 mihomo 实例验证延迟 API：不启用 TUN / DNS、不碰路由表，测完立即杀掉。
# 目的：确认 /proxies 能列出节点、proxy_names 过滤正确、delay 端点真的可用，
# 而不是「界面把延迟展示出来了、结果每个节点都是超时」。
set -u
CFG=/tmp/mihomo-api-only.yaml
LOG=/tmp/mihomo-api-only.log

python3 - <<'PY'
import re
src = open('/tmp/mihomo-203-test.yaml', encoding='utf-8').read().splitlines()
out, skip = [], False
for l in src:
    m = re.match(r'^([a-z][a-z-]*):', l)
    if m:
        skip = m.group(1) in ('tun', 'dns')
    if not skip:
        out.append(l)
open('/tmp/mihomo-api-only.yaml', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('  仅 API 配置 %d 行（tun/dns 段已移除）' % len(out))
PY

mihomo -d /opt/mihomo -f "$CFG" > "$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 20); do
  curl -s --max-time 1 http://127.0.0.1:9090/version >/dev/null 2>&1 && break
  sleep 0.5
done
echo "=== 1. /version ==="
curl -s --max-time 3 http://127.0.0.1:9090/version || echo "  API 未就绪"
echo
echo "=== 2. /proxies 节点与组（验证 proxy_names 过滤）==="
curl -s --max-time 3 http://127.0.0.1:9090/proxies | python3 -c "
import json, sys
d = json.load(sys.stdin)
for n, i in (d.get('proxies') or {}).items():
    print('  %-24s type=%-14s is_group=%s' % (n, i.get('type'), bool(i.get('all'))))
"
echo "=== 3. 单个 delay 端点原始响应 ==="
FIRST=$(python3 -c "
import importlib.util
s=importlib.util.spec_from_file_location('tm','/opt/scripts/tun-merge.py')
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
print(m.node_names(open('/opt/config/clash.yaml',encoding='utf-8').read().splitlines())[0])
")
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$FIRST")
echo "  节点: $FIRST"
curl -s --max-time 8 "http://127.0.0.1:9090/proxies/$ENC/delay?url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=3000"
echo
echo "=== 4. node-delay.py 完整输出 ==="
timeout 30 python3 /opt/scripts/node-delay.py 2>&1 | head -3
echo "=== 5. 内核日志尾部 ==="
tail -5 "$LOG"

cleanup
trap - EXIT
echo "=== 6. 清理确认 ==="
echo "  9090 监听数: $(ss -ltn 2>/dev/null | grep -c ':9090')"
echo "  临时进程存活: $(kill -0 "$PID" 2>/dev/null && echo 是 || echo 否)"
