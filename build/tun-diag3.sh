#!/usr/bin/env bash
# TUN spike 第三轮：把 DNS 完全收进 VM 内 mihomo，绕开宿主 Clash 的 fake-ip 污染。
# 不改宿主任何设置、不关 Clash（7897 仍是 mihomo 的上游节点）。
# 关键：WSL 的 DNS 代理 10.255.255.254 会把查询交给宿主 Clash，
#       宿主 Clash 开 TUN/DNS 劫持时直接返回自己 fake-ip 段（198.18.x）的地址，
#       VM 内 mihomo 收到这个包查自己的 fake-ip 表必然 "record missing"。
# 解法：resolv.conf 指向 127.0.0.1 + mihomo DNS 监听 53 + fake-ip 段换成不被占用的段。
set -u
D=/tmp/tun-spike
RESOLV_BAK="$D/resolv.conf.bak"
cp /etc/resolv.conf "$RESOLV_BAK"

cleanup() {
  echo ""
  echo "===== cleanup ====="
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
  sleep 1
  [ -n "${PID:-}" ] && kill -9 "$PID" 2>/dev/null || true
  cp "$RESOLV_BAK" /etc/resolv.conf
  python3 /mnt/e/Web/FuckCladue/build/tun-restore.py eth0 192.168.240.1 || true
  echo "resolv.conf 已恢复"; grep -E "^nameserver" /etc/resolv.conf
}
trap cleanup EXIT

cat > "$D/diag3.yaml" <<'YAML'
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
  listen: 0.0.0.0:53
  enhanced-mode: fake-ip
  fake-ip-range: 198.19.0.1/16
  nameserver:
    - https://223.5.5.5/dns-query
    - https://1.1.1.1/dns-query
  fallback:
    - https://223.5.5.5/dns-query
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

# 两阶段启动：先用 WSL 原 DNS 让 mihomo 完成初始化（要下载 GeoIP MMDB），
# 进程稳定后再把 resolv.conf 切到 127.0.0.1。一上来就切会 DNS 死锁。
"$D/mihomo" -d "$D/data" -f "$D/diag3.yaml" > "$D/diag3.log" 2>&1 &
PID=$!
sleep 6
kill -0 "$PID" 2>/dev/null || { echo "mihomo 启动失败"; tail -20 "$D/diag3.log"; exit 1; }
printf 'nameserver 127.0.0.1\n' > /etc/resolv.conf
sleep 1
echo "=== [0] 初始化日志（确认 MMDB 就绪）==="
sed -E 's/^time="[^"]+" //' "$D/diag3.log" | grep -iE "MMDB|geoip|error|fatal|listening at" | head -8

echo "=== [1] DNS 归属（应返回 198.19.x，证明由 VM 内 mihomo 分配）==="
getent hosts api.ipify.org || echo "(解析失败)"
echo ""
echo "=== [2] 裸 curl 出口（不带 -x、不带代理环境变量）==="
curl -s --noproxy '*' --connect-timeout 5 --max-time 15 https://api.ipify.org || echo "(失败)"
echo ""
echo "=== [3] 三源出口一致性 ==="
for u in https://api.ipify.org https://ipinfo.io/ip https://api.ip.sb/ip; do
  printf "  %-32s -> " "$u"
  curl -s --noproxy '*' --connect-timeout 4 --max-time 10 "$u" || echo "(失败)"
  echo ""
done
echo "=== [4] DNS 日志里有没有 fake-ip 记录命中 ==="
sed -E 's/^time="[^"]+" //' "$D/diag3.log" | grep -iE "fake|dns|error|warn" | head -12
echo ""
echo "=== [5] fail-closed：杀掉 mihomo 后裸 curl 必须不通 ==="
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
PID=""
sleep 1
echo -n "  内核已停，裸 curl: "
curl -s --noproxy '*' --connect-timeout 3 --max-time 7 https://api.ipify.org || echo "(失败/不通) ← 期望"
echo ""
