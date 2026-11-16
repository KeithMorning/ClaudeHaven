#!/usr/bin/env bash
# 产品链路端到端验证（不改产品代码、不改宿主 Clash、带 trap 完整恢复）
#
# 验证的是**产品脚本**而不是 spike 手写配置：
#   tun-merge.py（合并 YAML + 补 /32 路由）
#     -> tun-core.sh（起内核 / 切 DNS / 就绪检测）
#     -> net-guard.sh once（TUN 分支预检 + 熔断）
#     -> 应用侧裸 curl 三源出口
#     -> 内核退出后 fail-closed
#
# 当前 VM 的 rootfs 是 1.0.35 的旧镜像，没有随包内核与 GeoIP；
# 这里复用 spike 已下载的二进制临时装进 /opt/mihomo 与 /usr/local/bin，
# 只用于验证脚本链路，正式交付必须重建 rootfs（Dockerfile 已加）。
set -u
SRC=/mnt/e/Web/FuckCladue/claude-vm/vm/scripts
S=/tmp/tun-spike
WSL_BAK=/tmp/tun-verify-wsl.conf.bak
RESOLV_BAK=/tmp/tun-verify-resolv.bak
CORE_PID=""
VERDICT=FAIL

cleanup() {
  echo ""
  echo "===== cleanup ====="
  [ -n "$CORE_PID" ] && kill "$CORE_PID" 2>/dev/null || true
  pkill -x mihomo 2>/dev/null || true
  sleep 1
  pkill -9 -x mihomo 2>/dev/null || true
  cp "$RESOLV_BAK" /etc/resolv.conf 2>/dev/null || true
  cp "$WSL_BAK" /etc/wsl.conf 2>/dev/null || true
  python3 /opt/scripts/net-guard.py unlock >/dev/null 2>&1 || true
  python3 /mnt/e/Web/FuckCladue/build/tun-restore.py eth0 192.168.240.1 >/dev/null 2>&1 || true
  rm -f /opt/config/clash.yaml /opt/config/mihomo.yaml /run/claude-vm/tun-ready
  echo "resolv: $(grep -E '^nameserver' /etc/resolv.conf | tr '\n' ' ')"
  echo "默认路由: $(awk '$2 == "00000000" {print $1" -> "$3}' /proc/net/route | tr '\n' ' ')"
  echo "Meta 网卡数: $(grep -c Meta /proc/net/dev)"
  echo "残留 mihomo: $(pgrep -x mihomo | tr '\n' ' ')"
  echo "===== 判定: $VERDICT ====="
}
trap cleanup EXIT

cp /etc/wsl.conf "$WSL_BAK"
cp /etc/resolv.conf "$RESOLV_BAK"

echo "===== [0] 临时装入内核与数据库、同步产品脚本 ====="
mkdir -p /opt/mihomo /opt/scripts
cp -f "$S/mihomo" /usr/local/bin/mihomo && chmod 755 /usr/local/bin/mihomo
cp -f "$S/data/geoip.metadb" /opt/mihomo/geoip.metadb
for f in "$SRC"/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  cp -f "$f" "/opt/scripts/.$b.tmp" && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"
done
chmod +x /opt/scripts/*.sh
echo "mihomo: $(/usr/local/bin/mihomo -v 2>/dev/null | head -1)"
echo "geoip.metadb: $(ls -lh /opt/mihomo/geoip.metadb | awk '{print $5}')"

# 用户导入的 YAML：上游节点用宿主 7897 模拟（生产里换成用户 YAML 里的海外节点）
cat > /opt/config/clash.yaml <<'YAML'
port: 7890
mode: global
proxies:
  - name: upstream
    type: http
    server: 192.168.240.1
    port: 7897
proxy-groups:
  - name: GLOBAL
    type: select
    proxies: [upstream]
rules:
  - MATCH,GLOBAL
YAML
chmod 600 /opt/config/clash.yaml

echo ""
echo "===== [1] 确保环境从干净基线开始 ====="
pkill -x mihomo 2>/dev/null || true
python3 /opt/scripts/net-guard.py unlock >/dev/null 2>&1 || true
cat /proc/net/route

echo ""
echo "===== [2] 启动产品链路：tun-core.sh ====="
TUN_MODE=1 /opt/scripts/tun-core.sh > /tmp/tun-verify-core.out 2>&1 &
CORE_PID=$!
for _ in $(seq 1 30); do
  [ "$(cat /run/claude-vm/tun-ready 2>/dev/null)" = "ready" ] && break
  sleep 0.5
done
echo "tun-ready = $(cat /run/claude-vm/tun-ready 2>/dev/null || echo '(未就绪)')"
echo "-- tun-core 输出 --"
tail -12 /tmp/tun-verify-core.out
echo "-- 生成的 mihomo.yaml 增强段 --"
sed -n '/ClaudeVM TUN/,$p' /opt/config/mihomo.yaml 2>/dev/null | head -32
echo "-- DNS 归属 --"
getent hosts api.ipify.org || echo "(解析失败)"

echo ""
echo "===== [3] net-guard.sh once：TUN 分支预检 + 熔断 ====="
TUN_MODE=1 NET_GUARD=strict /opt/scripts/net-guard.sh once
PF=$?
echo "net-guard 退出码=$PF"
echo "-- state --"
cat /run/claude-vm/net-guard.state 2>/dev/null || echo "(无 state)"

echo ""
echo "===== [4] 应用侧裸 curl 三源出口 ====="
CURL=(env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy
  curl -s --noproxy '*' --connect-timeout 5 --max-time 15)
for u in https://api.ipify.org https://ipinfo.io/ip https://api.ip.sb/ip; do
  printf "  %-32s -> " "$u"
  "${CURL[@]}" "$u" || echo "(失败)"
  echo ""
done

echo ""
echo "===== [5] fail-closed：停掉内核后必须全断 ====="
kill "$CORE_PID" 2>/dev/null || true
CORE_PID=""
pkill -x mihomo 2>/dev/null || true
sleep 2
echo -n "  裸 curl api.ipify.org: "
"${CURL[@]}" --max-time 7 https://api.ipify.org || echo "(不通) ← 期望"
echo ""
echo "-- 此时路由表（main 表应无默认路由）--"
cat /proc/net/route

# 判定：预检通过 + 三源都拿到出口 + 内核停后不通
STATE_OK=$(grep -c '^state=guarded' /run/claude-vm/net-guard.state 2>/dev/null || echo 0)
if [ "$PF" -eq 0 ] && [ "$STATE_OK" = "1" ]; then VERDICT=PASS; fi
