#!/usr/bin/env bash
# TUN spike 第二轮：全路由表 + ip rule 等价物（netlink）+ DNS 归属 + fail-closed
# 不关宿主 Clash —— 它正是 mihomo 的上游节点（192.168.240.1:7897）。
# 判定方式改为「锁定代理主机后，看非代理目标是否还出得去」，避免被网关接管干扰。
set -u
D=/tmp/tun-spike
R=/mnt/e/Web/FuckCladue/build/tun-routes.py

cat > "$D/diag2.yaml" <<'YAML'
mode: global
log-level: debug
ipv6: false
tun:
  enable: true
  stack: mips
  auto-route: true
  auto-detect-interface: true
  strict-route: true
  dns-hijack:
    - any:53
  route-exclude-address:
    - 192.168.240.0/20
dns:
  enable: true
  listen: 0.0.0.0:1053
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 1.1.1.1
proxies:
  - name: upstream
    type: http
    server: 192.168.240.1
    port: 7897
proxy-groups:
  - name: GLOBAL
    type: select
    proxies: [upstream]
YAML

echo "=== [0] before ==="
python3 "$R" before

"$D/mihomo" -d "$D/data" -f "$D/diag2.yaml" > "$D/diag2.log" 2>&1 &
PID=$!
sleep 5
echo ""
echo "=== [1] after（全路由表，看有无独立 table / Meta 默认路由）==="
python3 "$R" after

echo ""
echo "=== [2] 网卡 ==="
cat /proc/net/dev | grep -E "face|Meta|eth0|lo"

echo ""
echo "=== [3] DNS 实际解析到哪（裸 curl，不带 -x）==="
getent hosts api.ipify.org | head -3 || echo "(解析失败)"
echo -n "裸 curl 出口: "
curl -s --noproxy '*' --connect-timeout 4 --max-time 12 https://api.ipify.org || echo "(失败)"
echo ""

echo "=== [4] 指定 DNS 走 mihomo 1053 时能否解析 ==="
command -v dig >/dev/null && dig @127.0.0.1 -p 1053 +short api.ipify.org || echo "(无 dig)"

echo ""
echo "=== [5] 关键日志 ==="
sed -E 's/^time="[^"]+" //' "$D/diag2.log" | grep -iE "rule|table|route|tun|fake|dns|error|warn|TCP|UDP" | head -40

kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
sleep 1
echo ""
echo "=== [6] 退出后全路由表 ==="
python3 "$R" cleanup
python3 /mnt/e/Web/FuckCladue/build/tun-restore.py eth0 192.168.240.1 || true
