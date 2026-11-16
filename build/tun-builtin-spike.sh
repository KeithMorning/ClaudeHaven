#!/usr/bin/env bash
# TUN spike 第四轮：按产品架构验证「容器内自带 mihomo 内核 + TUN 全局接管」。
#
# 与前三轮的根本区别：
#   前三轮把宿主 192.168.240.1:7897 当成「宿主代理软件」，纠结要不要关 Clash；
#   本轮把它当成「用户导入的 YAML 里的一个上游节点」—— 生产环境里换成真实
#   海外节点即可，宿主 Clash 只是编辑/导入配置的辅助工具，运行时链路里没有它。
#
# 架构：
#   应用（无 -x / 无 HTTP_PROXY）
#     -> TUN Meta（mihomo auto-route，table 2022 策略路由覆盖）
#     -> 容器内 mihomo（DNS 127.0.0.1:53，fake-ip 198.19.x，规则来自 YAML）
#     -> 上游节点（spike: 192.168.240.1:7897；生产: 用户 YAML 里的海外节点）
#     -> eth0 on-link 192.168.240.0/20（net-guard 保留的唯一通路）
#
#   net-guard lock 删掉 main 表默认路由 = fail-closed 底座：
#   mihomo 活着时 table 2022 覆盖路由把流量送进 TUN；mihomo 一挂，table 2022
#   随 TUN 消失，main 表又没有默认路由 -> 立刻全断。不需要任何检测动作。
#
# 全程不需要用户关闭或改动宿主 Clash：DNS 指向 127.0.0.1 后宿主 fake-ip
# 插不进来；main 表无默认路由后宿主网关侧接管也够不着。
#
# 只写 /tmp/tun-spike，trap 自动恢复路由/DNS/进程。
set -u
D=/tmp/tun-spike
RESOLV_BAK="$D/resolv-builtin.bak"
cp /etc/resolv.conf "$RESOLV_BAK"

cleanup() {
  echo ""
  echo "===== cleanup ====="
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
  sleep 1
  [ -n "${PID:-}" ] && kill -9 "$PID" 2>/dev/null || true
  cp "$RESOLV_BAK" /etc/resolv.conf
  python3 /opt/scripts/net-guard.py unlock >/dev/null 2>&1 || true
  python3 /mnt/e/Web/FuckCladue/build/tun-restore.py eth0 192.168.240.1 >/dev/null 2>&1 || true
  echo "resolv.conf: $(grep -E '^nameserver' /etc/resolv.conf | tr '\n' ' ')"
  echo "默认路由: $(awk '$2 == "00000000" {print $1" -> "$3}' /proc/net/route | tr '\n' ' ')"
  echo "Meta 网卡: $(grep -c Meta /proc/net/dev)"
  echo "mihomo 残留: $(pgrep -f 'tun-spike/mihomo' | tr '\n' ' ')"
}
trap cleanup EXIT

echo "===== [0] net-guard 锁死 main 表默认路由（fail-closed 底座）====="
LOCK_OUT="$(python3 /opt/scripts/net-guard.py lock http://192.168.240.1:7897 2>&1)"
echo "$LOCK_OUT"
if ! printf '%s' "$LOCK_OUT" | grep -q '"locked": *true'; then
  echo "!! lock 失败，终止（不解锁就测等于白测）"
  exit 1
fi
echo "-- 锁后 /proc/net/route（不应有 00000000 默认路由）--"
cat /proc/net/route

echo ""
echo "===== [1] 写容器内 mihomo 配置（等价于用户导入的 Clash YAML + TUN 增强段）====="
cat > "$D/builtin.yaml" <<'YAML'
mode: global
log-level: info
ipv6: false
tun:
  enable: true
  stack: mips
  auto-route: true
  auto-detect-interface: false
  interface-name: eth0
  strict-route: true
  dns-hijack:
    - any:53
  route-exclude-address:
    - 192.168.240.0/20
dns:
  enable: true
  listen: 127.0.0.1:53
  enhanced-mode: fake-ip
  fake-ip-range: 198.19.0.1/16
  nameserver:
    - 223.5.5.5
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
cat "$D/builtin.yaml"

echo ""
echo "===== [2] 启动（MMDB 已预置在 -d，不存在 DNS 死锁）====="
"$D/mihomo" -d "$D/data" -f "$D/builtin.yaml" > "$D/builtin.log" 2>&1 &
PID=$!
sleep 6
if ! kill -0 "$PID" 2>/dev/null; then
  echo "!! mihomo 启动失败"
  sed -E 's/^time="[^"]+" //' "$D/builtin.log" | tail -30
  exit 1
fi
echo "mihomo pid=$PID"
sed -E 's/^time="[^"]+" //' "$D/builtin.log" | grep -iE "tun|listening|error|fatal|MMDB" | head -10

echo ""
echo "===== [3] DNS 收进容器内（宿主 Clash 从此插不进来）====="
printf 'nameserver 127.0.0.1\n' > /etc/resolv.conf
sleep 1
echo -n "getent api.ipify.org -> "
getent hosts api.ipify.org || echo "(解析失败)"
echo "  期望 198.19.x（VM 内 mihomo 分配）；若仍是 198.18.x 说明宿主 fake-ip 污染"

echo ""
echo "===== [4] 应用侧裸 curl（无 -x、无代理环境变量）====="
CURL_NOPROXY=(env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  curl -s --noproxy '*' --connect-timeout 5 --max-time 15)
echo -n "  api.ipify.org -> "
"${CURL_NOPROXY[@]}" https://api.ipify.org || echo "(失败)"
echo ""
echo "-- 三源出口一致性 --"
for u in https://api.ipify.org https://ipinfo.io/ip https://api.ip.sb/ip; do
  printf "  %-32s -> " "$u"
  "${CURL_NOPROXY[@]}" "$u" || echo "(失败)"
  echo ""
done

echo ""
echo "===== [5] 全路由表（确认 table 2022 指向 Meta）====="
python3 /mnt/e/Web/FuckCladue/build/tun-routes.py during 2>&1 | tail -18

echo ""
echo "===== [6] fail-closed：杀掉容器内内核后必须立刻全断 ====="
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
PID=""
sleep 2
echo -n "  内核已停，裸 curl api.ipify.org: "
"${CURL_NOPROXY[@]}" --max-time 7 https://api.ipify.org || echo "(失败/不通) ← 期望"
echo ""
echo "-- 内核停机后 /proc/net/route（main 表仍无默认路由）--"
cat /proc/net/route
echo ""
echo "-- 内核停机后 table 2022 是否随 TUN 消失 --"
python3 /mnt/e/Web/FuckCladue/build/tun-routes.py after 2>&1 | tail -10
