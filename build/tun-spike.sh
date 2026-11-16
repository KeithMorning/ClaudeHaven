#!/usr/bin/env bash
# ============================================================
# TUN 技术验证 spike —— 不改产品代码，跑到 /tmp/tun-spike 隔离目录
#
# 目的：在真实 WSL2 内核上验证内置 mihomo + TUN 全局网卡是否成立，
#       落地代码前先把三个没有文档保证的坑实测掉：
#   [A] 环路：mihomo 自己连代理节点的出站不能被 TUN 抓回去
#   [B] 接管：普通 curl 不带任何 -x 也能经 TUN 出去（终端程序全覆盖）
#   [C] fail-closed：杀掉 mihomo 后 TUN 消失，默认路由无处可去 → 立刻不通
#   [D] DNS：53 端口被劫持进 mihomo 内部 DNS，不漏到宿主解析器
#
# 安全：trap 在 EXIT 时无条件恢复默认路由 / 关掉 mihomo，
#       绝不把当前 VM 的网络留在半截状态。只写 /tmp，不碰 /opt/scripts。
# ============================================================
set -u

D=/tmp/tun-spike
GW="$(awk '$2 == "00000000" {print $3}' /proc/net/route | head -1)"
# /proc/net/route 网关是小端 hex；换成可读 IP
gw_ip() {
  python3 - "$1" <<'PY'
import sys, struct, socket
h = sys.argv[1]
print(socket.inet_ntoa(struct.pack('<I', int(h, 16))))
PY
}
GW_IP="$(gw_ip "$GW" 2>/dev/null || echo 192.168.240.1)"
IFACE="$(awk '$2 == "00000000" {print $1; exit}' /proc/net/route)"
NODE_HOST="$(cat /opt/config/local-proxy 2>/dev/null | tr -d '\r\n' | sed -E 's#^[a-z]+://##; s#:[0-9]+$##')"
NODE_PORT="$(cat /opt/config/local-proxy 2>/dev/null | tr -d '\r\n' | sed -E 's#.*:([0-9]+)$#\1#')"
[ -n "$NODE_HOST" ] || NODE_HOST=192.168.240.1
[ -n "$NODE_PORT" ] || NODE_PORT=7897

MIHOMO_PID=""
cleanup() {
  echo ""
  echo "===== cleanup ====="
  if [ -n "$MIHOMO_PID" ] && kill -0 "$MIHOMO_PID" 2>/dev/null; then
    kill "$MIHOMO_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$MIHOMO_PID" 2>/dev/null || true
  fi
  # mihomo 的 auto-route 会加覆盖路由、也可能删原默认路由；sing-tun 退出时不保证全撤。
  # 显式用 netlink 加回物理网关，再调项目 unlock 做二次兜底。
  python3 /mnt/e/Web/FuckCladue/build/tun-restore.py "$IFACE" "$GW_IP" || true
  python3 /opt/scripts/net-guard.py unlock >/dev/null 2>&1 || true
  echo "默认路由现状（应能看到指向 $GW_IP 的 00000000 一条）："
  awk '$2 == "00000000" {print}' /proc/net/route
  echo "残留 mihomo 进程：$(pgrep -f 'tun-spike/mihomo' | tr '\n' ' ')"
  echo "若路由仍未恢复，执行：python3 /mnt/e/Web/FuckCladue/build/tun-restore.py $IFACE $GW_IP，或 wsl --shutdown 后重启发行版"
}
trap cleanup EXIT

echo "=== 基线 ==="
echo "iface=$IFACE gw=$GW_IP node=$NODE_HOST:$NODE_PORT"
ls -l /dev/net/tun || { echo "/dev/net/tun 缺失，spike 终止"; exit 1; }
gzip -dc "$D/mihomo.gz" > "$D/mihomo" && chmod +x "$D/mihomo"
"$D/mihomo" -v 2>&1 | head -2

mkdir -p "$D/data"

# ------------------------------------------------------------
# [A] 环路验证：故意不排除节点 IP，看 mihomo 自己能否连上上游
#     再对比加了 route-exclude-address 后是否能通
# ------------------------------------------------------------
mk_cfg() {
  local exclude="$1"
  cat > "$D/config.yaml" <<YAML
mode: global
log-level: info
ipv6: false
external-controller: 127.0.0.1:19090
tun:
  enable: true
  stack: mips
  auto-route: true
  auto-detect-interface: true
  strict-route: false
  dns-hijack:
    - any:53
  route-exclude-address:
$exclude
dns:
  enable: true
  listen: 0.0.0.0:1053
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 1.1.1.1
    - 8.8.8.8
proxies:
  - name: upstream
    type: http
    server: $NODE_HOST
    port: $NODE_PORT
proxy-groups:
  - name: GLOBAL
    type: select
    proxies: [upstream]
YAML
}

run_once() {
  local label="$1" exclude="$2"
  echo ""
  echo "===== [$label] ====="
  mk_cfg "$exclude"
  "$D/mihomo" -d "$D/data" -f "$D/config.yaml" > "$D/mihomo.log" 2>&1 &
  MIHOMO_PID=$!
  sleep 4
  if ! kill -0 "$MIHOMO_PID" 2>/dev/null; then
    echo "mihomo 启动失败，日志："; tail -20 "$D/mihomo.log"; return 1
  fi
  echo "-- TUN 网卡 --"
  awk 'NR==1 || $1 ~ /tun|Mihomo|utun/ {print}' /proc/net/dev
  echo "-- 路由表（默认 + TUN） --"
  awk '$2 == "00000000" || $1 ~ /tun|Mihomo/ {print}' /proc/net/route
  echo "-- [B] 裸 curl（不带 -x）经 TUN 的出口 --"
  curl -s --noproxy '*' --connect-timeout 4 --max-time 12 https://api.ipify.org || echo "(取不到 IP)"
  echo ""
  echo "-- [D] DNS：随机子域名是否进 mihomo 日志 --"
  Q="spike-$(date +%s).example.com"
  curl -s --noproxy '*' --connect-timeout 3 --max-time 8 "https://$Q" >/dev/null 2>&1 || true
  grep -c "$Q" "$D/mihomo.log" 2>/dev/null | sed 's/^/日志命中次数=/'
  echo "-- mihomo 日志末尾（看有无 dial 到自身 TUN 的环路报错）--"
  tail -8 "$D/mihomo.log"
  kill "$MIHOMO_PID" 2>/dev/null || true
  wait "$MIHOMO_PID" 2>/dev/null || true
  MIHOMO_PID=""
  sleep 2
  python3 /opt/scripts/net-guard.py unlock >/dev/null 2>&1 || true
}

# A1：只排除一个无关网段（节点 IP 不在排除项里）—— 预期回灌 TUN 形成环路
run_once "A1 节点 IP 未排除（预期环路/失败）" "    - 10.255.255.1/32"

# A2：把节点 IP 和网关网段排除 —— 预期成功
run_once "A2 节点 IP 已排除（预期成功）" "    - $NODE_HOST/32
    - 192.168.240.0/20"

# ------------------------------------------------------------
# [C] fail-closed：起 TUN → 确认能通 → 杀内核 → 必须立刻不通
# ------------------------------------------------------------
echo ""
echo "===== [C] fail-closed ====="
mk_cfg "    - $NODE_HOST/32
    - 192.168.240.0/20"
"$D/mihomo" -d "$D/data" -f "$D/config.yaml" > "$D/mihomo.log" 2>&1 &
MIHOMO_PID=$!
sleep 4
echo -n "内核活着时裸 curl: "; curl -s --noproxy '*' --connect-timeout 3 --max-time 8 https://api.ipify.org || echo "(失败)"
echo ""
kill "$MIHOMO_PID" 2>/dev/null || true
wait "$MIHOMO_PID" 2>/dev/null || true
MIHOMO_PID=""
sleep 1
echo -n "内核死后裸 curl: "; curl -s --noproxy '*' --connect-timeout 3 --max-time 8 https://api.ipify.org || echo "(失败)"
echo ""
echo "-- 内核死后默认路由（TUN 没了就不该有指向它的默认路由）--"
awk '$2 == "00000000" {print}' /proc/net/route

echo ""
echo "===== spike 结束（cleanup 会恢复网络）====="
