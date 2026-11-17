#!/usr/bin/env bash
# 只读：用 mihomo -t 校验生成的配置是否合法（不启动内核、不动网络）
set -u
OUT=/tmp/mihomo-verify-2x.yaml
echo "=== mihomo -t 配置校验 ==="
/usr/local/bin/mihomo -t -f "$OUT" -d /opt/mihomo 2>&1 | tail -12
echo "exit=${PIPESTATUS[0]}"
echo "=== DNS 段（listen 才是 mihomo.yaml 里的写法）==="
grep -A6 '^dns:' "$OUT"
echo "=== 修复后脚本语法检查 ==="
bash -n /opt/scripts/net-guard.sh && echo "  net-guard.sh OK"
bash -n /opt/scripts/tun-core.sh && echo "  tun-core.sh OK"
python3 -m py_compile /opt/scripts/tun-merge.py && echo "  tun-merge.py OK"
