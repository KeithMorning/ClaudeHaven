#!/usr/bin/env bash
# 只读：看注入的 clash.yaml 里 proxies 段格式，并对比两边节点解析结果
echo "=== clash.yaml 基本信息 ==="
ls -l /opt/config/clash.yaml
echo "=== 顶层键 ==="
grep -n '^[A-Za-z_][A-Za-z0-9_-]*\s*:' /opt/config/clash.yaml | head -20
echo "=== proxies 段前 24 行（带不可见字符标记）==="
awk '/^proxies:/{f=1;n=0} f{print NR": "$0; n++; if(n>=24) exit}' /opt/config/clash.yaml
echo "=== 所有 - name: 行（cat -A 显示缩进/行尾）==="
grep -n -- '- name:' /opt/config/clash.yaml | head -8 | cat -A
echo "=== 客机 tun-merge.py 的 node_names 结果 ==="
python3 - <<'PY'
import sys
sys.path.insert(0, '/opt/scripts')
import tun_merge
lines = open('/opt/config/clash.yaml', encoding='utf-8').read().replace('\r\n','\n').split('\n')
print('node_names =', tun_merge.node_names(lines))
print('node_hosts =', tun_merge.node_hosts(lines))
PY
echo "=== net-guard.sh 第 20-28 行 ==="
sed -n '20,28p' /opt/scripts/net-guard.sh
