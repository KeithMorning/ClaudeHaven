#!/usr/bin/env bash
# ============================================================
# tun-core.sh — 容器内自带代理内核（mihomo）+ TUN 全局接管
#
# 与旧链路的根本区别：
#   旧：应用显式走宿主代理端口，宿主代理软件是运行时依赖。
#   新：容器内内核自己决定出口，宿主 Clash 只是「导入/编辑 YAML」的辅助工具，
#       运行时链路里没有它 —— 它切 Global 还是 Direct 与本环境无关。
#
# 分工（别调换顺序）：
#   [1] tun-merge.py  在还有默认路由时解析节点、补 /32 主机路由、生成配置
#   [2] mihomo 启动   TUN 网卡 + 策略路由(table 2022) + DNS(fake-ip) 接管
#   [3] resolv.conf   DNS 指向 127.0.0.1，宿主 fake-ip 从此插不进来
#   [4] net-guard.sh  随后删掉 main 表默认路由，作为 fail-closed 底座
#
# fail-closed 是结构性的，不依赖任何检测动作：
#   mihomo 活着 -> table 2022 覆盖路由把所有流量送进 TUN；
#   mihomo 一挂 -> table 2022 随 TUN 消失，而 main 表没有默认路由 -> 立刻全断。
#
# 凭据隔离：/opt/config/mihomo.yaml 为 600 root:root，含节点 UUID/密码，
#   业务侧（Chrome / Claude Code）若后续降为非 root 就读不到。
# ============================================================
set -u

CORE=/usr/local/bin/mihomo
DATA=/opt/mihomo
USER_CFG=/opt/config/clash.yaml
CFG=/opt/config/mihomo.yaml
RESOLV_BAK=/run/claude-vm/resolv.conf.pre-tun
GUARD_DIR=/run/claude-vm
LOG=$GUARD_DIR/tun-core.log
READY_FILE=$GUARD_DIR/tun-ready

mkdir -p "$GUARD_DIR"
rm -f "$READY_FILE"
log() { echo "[tun-core] $*" | tee -a "$LOG"; }

if [ ! -s "$USER_CFG" ]; then
  log "严重：未找到导入的 Clash YAML（$USER_CFG），TUN 模式不启动，网络保持全断"
  exit 1
fi
if [ ! -x "$CORE" ]; then
  log "严重：容器内代理内核缺失（$CORE），请用新版 rootfs 重建虚拟环境"
  exit 1
fi
if [ ! -d "$DATA" ] || [ ! -f "$DATA/geoip.metadb" ]; then
  log "严重：GeoIP 数据库未预置，启动时会出现 DNS 死锁（内核要下 MMDB 但 DNS 已指向自己）"
  exit 1
fi

# [1] 合并配置 + 预补节点/DNS 的 /32 主机路由
MERGE_OUT="$(python3 /opt/scripts/tun-merge.py "$USER_CFG" "$CFG" 2>&1)"
if [ $? -ne 0 ] || [ ! -s "$CFG" ]; then
  log "严重：配置合并失败：$MERGE_OUT"
  exit 1
fi
log "merge: $MERGE_OUT"
if printf '%s' "$MERGE_OUT" | grep -q '"unresolved":\[[^]]'; then
  log "严重：有节点域名无法解析（此时还有默认路由都解析不了，锁路由后更不可能）"
  exit 1
fi
if printf '%s' "$MERGE_OUT" | grep -q '"route_errors":\[[^]]'; then
  log "警告：部分主机路由补失败，节点连通性可能受影响"
fi

# WSL 每次启动会重写 resolv.conf；关掉自动生成才能让我们写的值留得住。
# 已有 rootfs 没有这项时在这里补写，下次重建 rootfs 后由 Dockerfile 保证。
if ! grep -q '^generateResolvConf' /etc/wsl.conf 2>/dev/null; then
  printf '\n[network]\ngenerateResolvConf = false\n' >> /etc/wsl.conf 2>/dev/null || true
fi
cp /etc/resolv.conf "$RESOLV_BAK" 2>/dev/null || true

start_core() {
  "$CORE" -d "$DATA" -f "$CFG" >> "$LOG" 2>&1 &
  CORE_PID=$!
}

# [2] 启动内核，等 TUN 网卡与 DNS 监听就绪
start_core
READY=0
for _ in $(seq 1 20); do
  if grep -qE '^ *Meta:' /proc/net/dev 2>/dev/null \
     && grep -qiE '127\.0\.0\.1:53' "$LOG" 2>/dev/null; then
    READY=1
    break
  fi
  kill -0 "$CORE_PID" 2>/dev/null || break
  sleep 0.5
done
if [ "$READY" != "1" ]; then
  log "严重：TUN 网卡或 DNS 监听未就绪，内核日志尾部："
  tail -20 "$LOG"
  kill "$CORE_PID" 2>/dev/null || true
  cp "$RESOLV_BAK" /etc/resolv.conf 2>/dev/null || true
  exit 1
fi
log "内核已就绪 pid=$CORE_PID，TUN 网卡与 DNS(127.0.0.1:53) 均已监听"

# [3] DNS 收进容器内。fake-ip 由本内核分配，宿主 Clash 的 198.18.x 不再出现。
printf 'nameserver 127.0.0.1\n' > /etc/resolv.conf
log "resolv.conf -> 127.0.0.1（宿主 DNS 代理已旁路）"

# 显式就绪标记：entrypoint 与自检一律等这个，而不是只看 Meta 网卡。
# 网卡先于 DNS 切换出现，中间那个窗口里 getent 仍会问到 WSL 的 DNS 代理
# （宿主 Clash 返回 198.18.x fake-ip），看起来像污染，其实只是时序。
echo ready > "$READY_FILE"

# [4] 看门狗：内核意外退出时立即拉起。
#     此时 main 表已无默认路由，但 [1] 补的 /32 主机路由还在，节点与 DNS 仍可达；
#     MMDB 已预置，所以重启不会再撞上 DNS 死锁。
#     拉起失败期间 net-guard 会判 blocked，网络保持全断（fail-closed）。
while sleep 2; do
  if ! kill -0 "$CORE_PID" 2>/dev/null; then
    log "内核意外退出，正在拉起"
    rm -f "$READY_FILE"
    start_core
    sleep 2
    kill -0 "$CORE_PID" 2>/dev/null && echo ready > "$READY_FILE"
  fi
done
