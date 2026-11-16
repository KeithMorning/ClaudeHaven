#!/usr/bin/env bash
# TUN spike 精确诊断：完整打印路由表/网卡，不过滤，确认 auto-route 到底做了什么
set -u
D=/tmp/tun-spike
NODE_HOST=192.168.240.1
NODE_PORT=7897

cat > "$D/diag.yaml" <<'YAML'
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

echo "=== 启动前 /proc/net/route 全量 ==="
cat /proc/net/route
echo "=== 启动前 /proc/net/dev 全量 ==="
cat /proc/net/dev

"$D/mihomo" -d "$D/data" -f "$D/diag.yaml" > "$D/diag.log" 2>&1 &
PID=$!
sleep 5
echo ""
echo "=== 进程存活？ ==="
kill -0 "$PID" && echo "alive pid=$PID" || echo "DEAD"
echo "=== 启动后 /proc/net/route 全量 ==="
cat /proc/net/route
echo "=== 启动后 /proc/net/dev 全量 ==="
cat /proc/net/dev
echo "=== 路由相关日志 ==="
grep -iE "route|tun|interface|error|warn|fail" "$D/diag.log" | head -30
echo "=== 裸 curl -v（noproxy，看 DNS 解析到哪、连哪个 IP）==="
curl -v --noproxy '*' --connect-timeout 4 --max-time 10 https://api.ipify.org 2>&1 | head -25
echo ""
echo "=== 显式走 TUN 网关的 curl（绕过 DNS，直连 IP）==="
curl -s --noproxy '*' --connect-timeout 4 --max-time 10 https://1.1.1.1 2>&1 | head -3
echo ""
echo "=== /etc/resolv.conf ==="
cat /etc/resolv.conf

kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
sleep 1
echo "=== 退出后 /proc/net/route ==="
cat /proc/net/route
python3 /mnt/e/Web/FuckCladue/build/tun-restore.py eth0 192.168.240.1 || true
