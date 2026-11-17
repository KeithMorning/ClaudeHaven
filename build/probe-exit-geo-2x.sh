#!/usr/bin/env bash
# 只读：实测当前真实出口 IP 的地理/时区情报，并与 YAML 里选中节点的 server 对比
echo "=== 当前 TUN 状态 ==="
pgrep -x mihomo >/dev/null && echo "  mihomo 运行中" || echo "  mihomo 未运行"
grep -E '^ *Meta:' /proc/net/dev || echo "  Meta 网卡不存在"
echo "=== ipinfo.io 完整返回（脱敏只留地理字段）==="
curl -s --max-time 10 https://ipinfo.io/json 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for k in ('ip','city','region','country','loc','timezone','org','asn'):
        if k in d: print('  %-10s %s' % (k, d[k]))
except Exception as e:
    print('  解析失败:', e)
"
echo "=== YAML 里选中节点的 server ==="
grep -A4 -- '- type: vless' /opt/config/clash.yaml | grep 'server:' | head -3
echo "=== net-guard.state 里的出口信息 ==="
grep -E 'exit_(ip|country|city|org)' /run/claude-vm/net-guard.state 2>/dev/null || echo "  (无)"
