#!/usr/bin/env bash
# ============================================================
# net-guard.sh — 容器内内核 + TUN 链路的「启动预检 + 运行看门狗」（2.0）
#
# 网络形态（唯一）：
#   应用（无显式代理）→ TUN Meta → 容器内 mihomo → YAML 里选中的节点
#   net-guard 删掉 main 表默认路由，作为 fail-closed 底座。
#   内核一挂 → TUN 与 table 2022 策略路由一起消失 → 没有默认路由 → 立刻全断。
#
# 顺序是刻意的，别调换：
#   [0] 立刻 lock 路由（纯 netlink，毫秒级）→ 此刻起没有直连这条路
#   [1] 才做网络预检 —— 所有探测都是裸 curl，流量自然进 TUN
#   [2] 验证「内核 + Meta 网卡都在」，缺一即判 blocked
#
# 预检/看门狗一律**裸 curl**：2.0 没有代理端口可填，加 -x 会去测一个
# 不存在的地址（1.0.36 前的假绿来源）。
#
# 状态文件 /run/claude-vm/net-guard.state（KV，可被 shell source / 客户端读取）
#   state=guarded|blocked|proxy_down|off
#   reason=ok|proxy-unreachable|exit-region-risk|split-exit|
#          anthropic-unreachable|leak-detected|lock-failed
# ============================================================

GUARD_DIR=/run/claude-vm
STATE="$GUARD_DIR/net-guard.state"
PIDFILE="$GUARD_DIR/net-guard.pid"
PY=/opt/scripts/net-guard.py
LOG_PREFIX="[net-guard]"

# 客户端传入：strict（默认，强制熔断）/ off（退回旧行为，仅告警）
NET_GUARD="${NET_GUARD:-strict}"
# 严格模式按本地保存的 Anthropic 官方支持地区快照核验出口国家码。
STRICT_REGION="${NET_GUARD_STRICT_REGION:-1}"
# 3 秒一轮 re-assert：WSL 在网络重置/休眠恢复时可能把默认路由加回来，
# 这是唯一需要周期性兜住的情况（代理断开本身不需要看门狗，路由表里就没那条路）。
INTERVAL="${NET_GUARD_INTERVAL:-3}"
MODE="${1:-daemon}"

mkdir -p "$GUARD_DIR"

# 2.0：容器内核是唯一出口，没有「代理 URL」这个概念。
# 预检与看门狗一律裸 curl；宿主 Clash 的模式与本环境无关。
# 这个空值只用于让状态文件里的 proxy= 字段保持为空，不做任何探测。
PROXY_URL=''

log() { echo "$LOG_PREFIX $*"; }

# 原子写状态：先写 tmp 再 mv。读的一方（自检/界面）永远不会读到半截文件。
write_state() {
  local st="$1" reason="$2" msg="$3" extra="${4:-}"
  local tmp="$STATE.tmp.$$"
  {
    echo "state=$st"
    echo "reason=$reason"
    echo "message=\"$msg\""
    echo "proxy=$PROXY_URL"
    echo "exit_ip=${EXIT_IP:-}"
    echo "exit_country=${EXIT_COUNTRY:-}"
    echo "exit_city=${EXIT_CITY:-}"
    echo "exit_timezone=${EXIT_TIMEZONE:-}"
    echo "direct_leak=${DIRECT_LEAK:-unknown}"
    echo "preflight=${PREFLIGHT:-unknown}"
    echo "locked=${LOCKED:-0}"
    echo "ts=$(date +%s)"
    if [ -n "$extra" ]; then echo "$extra"; fi
  } > "$tmp"
  mv -f "$tmp" "$STATE"
}

guard_status() { python3 "$PY" status 2>/dev/null; }

# ------------------------------------------------------------
# 关闭模式：恢复路由，明确写状态，不做任何熔断
# ------------------------------------------------------------
if [ "$NET_GUARD" = "off" ]; then
  if guard_status | grep -q '"locked": *true'; then
    python3 "$PY" unlock >/dev/null 2>&1 && log "已按 NET_GUARD=off 恢复默认路由"
  fi
  PREFLIGHT=skipped LOCKED=0 write_state off disabled \
    "网络熔断已关闭：内核退出时流量可能直连出网，存在暴露真实环境的风险。"
  log "NET_GUARD=off，未启用熔断（不推荐）"
  exit 0
fi

# 防止同模式重启时叠多个看门狗
if [ -f "$PIDFILE" ]; then
  _old=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$_old" ] && [ "$_old" != "$$" ] && kill -0 "$_old" 2>/dev/null; then
    log "已有看门狗在跑（pid $_old），本次跳过"
    exit 0
  fi
fi
echo $$ > "$PIDFILE"
# 注意：退出时**不 unlock**。fail-closed 的语义就是「守卫死了，网络也应保持封锁」，
# 不能在脚本异常退出时把直连放回去。要恢复只有显式 NET_GUARD=off 或重启发行版。
trap 'if [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ]; then rm -f "$PIDFILE"; fi' EXIT
trap 'exit 0' INT TERM

# ------------------------------------------------------------
# [0] 先熔断。没配代理也要锁 —— 用一个不可达的占位地址，效果是全断网。
#     这正对应用户第 2 个诉求：代理没配好，宁可没网，也不能裸奔。
# ------------------------------------------------------------
# 占位地址让 lock 只做「删默认路由 + 关 IPv6」：这条锁正是内核挂掉后
# 全断网的依据。2.0 恒用占位，不需要任何真实代理端点。
LOCK_ARG="http://127.0.0.1:1"
log "容器内内核接管出口，路由熔断保留作 fail-closed 底座"

LOCK_OUT="$(python3 "$PY" lock "$LOCK_ARG" 2>&1)"
log "lock: $LOCK_OUT"
if printf '%s' "$LOCK_OUT" | grep -q '"ok": *true'; then
  LOCKED=1
else
  LOCKED=0
  LOCK_ERR="$(printf '%s' "$LOCK_OUT" | sed -n 's/.*"error": *"\([^"]*\)".*/\1/p')"
  PREFLIGHT=fail
  write_state blocked lock-failed "网络熔断失败，已拒绝放行：${LOCK_ERR:-未知错误}。请重启虚拟环境后重试。" \
    "lock_error=\"${LOCK_ERR:-unknown}\""
  log "熔断失败，保持拒绝状态：${LOCK_ERR:-未知错误}"
  # 熔断失败时绝不进入正常看门狗循环，但仍要周期性重试封锁
  while sleep "$INTERVAL"; do
    R="$(python3 "$PY" lock "$LOCK_ARG" 2>&1)"
    if printf '%s' "$R" | grep -q '"ok": *true'; then
      LOCKED=1
      log "重试熔断成功"
      break
    fi
  done
fi

# ------------------------------------------------------------
# [1] 预检 —— 此时直连已断，所有探测只能经代理，探测本身不会泄漏真实出口
#     出口信息请求最多等待 10 秒。
# ------------------------------------------------------------
preflight() {
  # Validate the local protection prerequisites before any external request.
  DIRECT_LEAK=unknown
  EXIT_IP=''; EXIT_COUNTRY=''; EXIT_CITY=''; EXIT_ORG=''; EXIT_TIMEZONE=''
  if ! pgrep -x mihomo >/dev/null 2>&1 || ! grep -qE '^ *Meta:' /proc/net/dev 2>/dev/null; then
    PF_REASON=leak-detected
    PF_MSG="代理内核或 TUN 网卡不可用，已拒绝放行。"
    return 1
  fi
  if [ "$LOCKED" != "1" ] || ! python3 "$PY" status 2>/dev/null | python3 -c 'import json,sys; x=json.load(sys.stdin); sys.exit(0 if x.get("locked") is True and x.get("ipv6_disabled") is True else 1)' 2>/dev/null; then
    PF_REASON=lock-failed
    PF_MSG="无法确认路由封锁和 IPv6 状态，已拒绝放行。"
    return 1
  fi
  if [ "$(awk '/^nameserver[[:space:]]/{print $2}' /etc/resolv.conf)" != "127.0.0.1" ]; then
    PF_REASON=dns-not-ready
    PF_MSG="无法确认虚拟机 DNS 配置，已拒绝放行。"
    return 1
  fi
  local T; T="$(mktemp -d)"
  curl -fsS --noproxy '*' --connect-timeout 3 --max-time 10 https://ipinfo.io/json > "$T/via" 2>/dev/null || true
  mapfile -t INFO < <(python3 - "$T/via" <<'PY'
import ipaddress, json, re, sys
from pathlib import Path
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        data = json.load(f)
    ip = ipaddress.ip_address(data.get('ip', ''))
    if not ip.is_global:
        raise ValueError('not a public address')
    for value in (str(ip), data.get('country', ''), data.get('city', ''), data.get('org', '')):
        print(str(value or '').replace('\n', ' ').replace('\r', ' '))
    zone = data.get('timezone')
    if isinstance(zone, str) and re.fullmatch(r'[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)*', zone):
        root = Path('/usr/share/zoneinfo')
        try:
            path = (root / zone).resolve(strict=True)
            with path.open('rb') as f:
                if f.read(4) == b'TZif':
                    print(path.relative_to(root))
        except (OSError, ValueError):
            pass
except (OSError, ValueError, TypeError):
    pass
PY
)
  rm -rf "$T"
  EXIT_IP="${INFO[0]:-}"
  EXIT_COUNTRY="${INFO[1]:-}"
  EXIT_CITY="${INFO[2]:-}"
  EXIT_ORG="${INFO[3]:-}"
  EXIT_TIMEZONE="${INFO[4]:-}"
  if [ -z "$EXIT_IP" ]; then
    PF_REASON=proxy-unreachable
    PF_MSG="无法获取有效的公网出口信息，请检查节点或稍后重试。"
    return 1
  fi
  if [ "$STRICT_REGION" = "1" ]; then
    _region_status=$(python3 /opt/scripts/claude-supported-regions.py "$EXIT_COUNTRY" 2>/dev/null || true)
    case "$_region_status" in
      supported) ;;
      unsupported)
        PF_REASON=exit-region-risk
        PF_MSG="出口地区未列入本地保存的 Anthropic 支持地区名单，请检查所选节点。"
        return 1 ;;
      *)
        PF_REASON=exit-region-unknown
        PF_MSG="无法确认出口地区或支持地区名单不可用，已拒绝放行。"
        return 1 ;;
    esac
  fi
  PF_REASON=ok
  PF_MSG="网络保护条件和出口地区检查通过。出口 ${EXIT_IP}${EXIT_COUNTRY:+ · $EXIT_COUNTRY}${EXIT_CITY:+ · $EXIT_CITY}。"
  return 0
}

preflight
PF=$?
if [ "$PF" -eq 0 ]; then PREFLIGHT=pass; else PREFLIGHT=fail; fi
log "预检：$PF_REASON | $PF_MSG"

if [ "$PF" -eq 0 ]; then
  write_state guarded ok "$PF_MSG" "exit_org=\"${EXIT_ORG:-}\""
else
  # 预检失败也**不解锁**：路由本来就只通代理（或全断），这是最安全的状态。
  write_state blocked "$PF_REASON" "$PF_MSG"
fi

# 顺带把出口信息写回旧的 exit.state，保持界面/自检已有字段的兼容性
{
  echo "state=$([ "$PF" -eq 0 ] && echo up || echo down)"
  echo "exit_ip=${EXIT_IP:-}"
  echo "exit_org=${EXIT_ORG:-}"
  echo "exit_city=${EXIT_CITY:-}"
  echo "mode=tun"
  echo "upstream=tun://Meta"
} > "$GUARD_DIR/exit.state"

[ "$MODE" = "once" ] && exit "$PF"

# ------------------------------------------------------------
# [2] 看门狗：周期性 re-assert 熔断 + 探活 + 把状态告诉界面
#     探活失败不会去"断网"（网络早就断了），只把 state 改成 proxy_down；
#     代理恢复后重跑一次预检再回到 guarded。
# ------------------------------------------------------------
CONSEC_FAIL=0
while sleep "$INTERVAL"; do
  # WSL 有可能把默认路由重新加回来（网络重置 / 休眠恢复），每轮都重新确认。
  # lock 是幂等的：已锁时只 re-assert IPv6 与代理主机路由，不会重复删。
  R="$(python3 "$PY" lock "${LOCK_ARG}" 2>&1)"
  if printf '%s' "$R" | grep -q '"locked": *true'; then LOCKED=1; else LOCKED=0; fi

  if [ "$PREFLIGHT" = "pass" ] && [ "$LOCKED" = "1" ] &&
     pgrep -x mihomo >/dev/null 2>&1 && grep -qE '^ *Meta:' /proc/net/dev 2>/dev/null &&
     [ "$(awk '/^nameserver[[:space:]]/{print $2}' /etc/resolv.conf)" = "127.0.0.1" ]; then
    CODE="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 6 \
            http://cp.cloudflare.com/generate_204 2>/dev/null)"
    if [ "$CODE" = "204" ] || [ "$CODE" = "200" ]; then
      CONSEC_FAIL=0
      write_state guarded ok "$PF_MSG" "exit_org=\"${EXIT_ORG:-}\""
      continue
    fi
    CONSEC_FAIL=$((CONSEC_FAIL + 1))
    [ "$CONSEC_FAIL" -lt 2 ] && continue
  fi

  # An unavailable health endpoint must not prevent a full exit check or recovery.
  previous_preflight="$PREFLIGHT"
  if preflight; then
    PREFLIGHT=pass
    CONSEC_FAIL=0
    write_state guarded ok "$PF_MSG" "exit_org=\"${EXIT_ORG:-}\""
  else
    PREFLIGHT=fail
    if [ "$previous_preflight" = "pass" ] && [ "$PF_REASON" = "proxy-unreachable" ]; then
      write_state proxy_down "$PF_REASON" "$PF_MSG"
    else
      write_state blocked "$PF_REASON" "$PF_MSG"
    fi
  fi
done
