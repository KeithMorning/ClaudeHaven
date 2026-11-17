#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2.0：net-guard.sh 单态化 —— PROXY_URL 恒空、裸 curl、恒验内核与 Meta 网卡。"""
import sys

P = r'E:\Web\FuckCladue\claude-vm\vm\scripts\net-guard.sh'
with open(P, 'r', encoding='utf-8', newline='') as f:
    s = f.read()
n = 0


def between(start, end, new, label):
    global s, n
    for m, name in ((start, '起始'), (end, '结束')):
        c = s.count(m)
        if c != 1:
            sys.exit(f'[FAIL] {label}: {name}标记出现 {c} 次: {m[:70]}')
    i, j = s.index(start), s.index(end)
    if j <= i: sys.exit(f'[FAIL] {label}: 顺序错')
    s = s[:i] + new + s[j:]
    n += 1


def once(old, new, label):
    global s, n
    c = s.count(old)
    if c != 1: sys.exit(f'[FAIL] {label}: 出现 {c} 次')
    s = s.replace(old, new, 1)
    n += 1


# 1) 头注释
between(
    '# ============================================================\n# net-guard.sh',
    '# ============================================================\n\nGUARD_DIR=',
    r'''# ============================================================
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

GUARD_DIR=''',
    '头注释')

# 2) PROXY_URL / TUN_MODE 块 → 恒空说明
between(
    '# 代理地址以「实际生效」的那个为准',
    'log() { echo "$LOG_PREFIX $*"; }',
    r'''# 2.0：容器内核是唯一出口，没有「代理 URL」这个概念。
# 预检与看门狗一律裸 curl；宿主 Clash 的模式与本环境无关。
PROXY_URL=""

''',
    'PROXY_URL 块')

# 3) lock 块：恒用占位地址
between(
    'NO_PROXY_CFG=0\nif [ "$TUN_MODE" = "1" ]; then',
    'LOCK_OUT="$(python3 "$PY" lock "$LOCK_ARG" 2>&1)"',
    r'''# 占位地址让 lock 只做「删默认路由 + 关 IPv6」：这条锁正是内核挂掉后
# 全断网的依据。2.0 恒用占位，不需要任何真实代理端点。
LOCK_ARG="http://127.0.0.1:1"
log "容器内内核接管出口，路由熔断保留作 fail-closed 底座"

''',
    'lock 块')

# 4) preflight 里 px=() 条件 → 直接删（恒裸 curl）
once(
    '  local px=()\n  if [ -n "$PROXY_URL" ]; then px=(-x "$PROXY_URL"); fi\n',
    '',
    'preflight px')

# 所有 "${px[@]}" 直接去掉
s = s.replace(' "${px[@]}"', '')
n += 1

# 5) 直连泄漏判定：去掉 TUN_MODE 外壳，恒验内核 + Meta
between(
    '  # TUN 模式下 `--noproxy \'*\'` 只是不让 curl 用应用层代理',
    '  # 判定按严重度从高到低，第一个命中即返回',
    r'''  # `--noproxy '*'` 只是不让 curl 用应用层代理，包照样被 TUN 抓走，
  # 所以「直连探测能通」不等于泄漏。真正的前提是：容器内内核活着 + Meta 网卡存在。
  if pgrep -x mihomo >/dev/null 2>&1 && grep -qE '^ *Meta:' /proc/net/dev 2>/dev/null; then
    DIRECT_LEAK=no
  else
    DIRECT_LEAK=yes
  fi

''',
    '直连泄漏判定')

# 6) leak-detected 文案 + NO_PROXY_CFG 分支 + 空出口文案
between(
    '  if [ "$DIRECT_LEAK" = "yes" ]; then\n    PF_REASON=leak-detected',
    '  if [ "$LOCKED" != "1" ]; then',
    r'''  if [ "$DIRECT_LEAK" = "yes" ]; then
    PF_REASON=leak-detected
    PF_MSG="容器内内核或 TUN 网卡不存在，出口未被接管，已拒绝放行。请查看 /run/claude-vm/tun-core.log。"
    return 1
  fi
''',
    'leak 文案')

once(
    '  if [ "$NO_PROXY_CFG" = "1" ] && [ "$TUN_MODE" != "1" ]; then\n'
    '    PF_REASON=no-proxy\n'
    '    PF_MSG="未配置代理，网络已被完全切断。请在设置里填好代理地址（并确认代理软件已开启「允许局域网连接」）后重新启动。"\n'
    '    return 1\n'
    '  fi\n',
    '',
    'NO_PROXY_CFG 分支')

once(
    '    PF_MSG="经代理取不到出口信息：代理软件可能没开、端口填错，或没开启「允许局域网连接（Allow LAN）」。网络已保持切断，不会直连泄漏。"',
    '    PF_MSG="容器内内核取不到出口信息：内核可能没起来、选中节点不可达，或 YAML 配置有误。网络已保持切断，不会直连泄漏。"',
    '空出口文案')
once(
    '      PF_MSG="代理出口落在受限地区（$EXIT_COUNTRY）。多半是代理规则把流量直连了，或选中的节点在国内。请切到全局模式 / 换境外节点后重启。"',
    '      PF_MSG="出口落在受限地区（$EXIT_COUNTRY）。多半是选中的节点在国内，或订阅分流把流量直连了。请换境外节点后重启。"',
    '受限地区文案')
once(
    '    PF_MSG="同一次检测出现多个出口（$MULTI_IPS），说明代理按域名分流、不同站点看到的 IP 不同。请把代理切到全局统一出口后重启。"',
    '    PF_MSG="同一次检测出现多个出口（$MULTI_IPS），说明订阅的分流规则没被忽略、或内核仍按域名选路。应全量走选中的单一节点。"',
    '多源分叉文案')
once(
    '    PF_MSG="经代理访问 api.anthropic.com 失败（HTTP ${ANTH_CODE:-000}）。Claude Code 会直接不可用，请检查代理规则。"',
    '    PF_MSG="访问 api.anthropic.com 失败（HTTP ${ANTH_CODE:-000}）。Claude Code 会直接不可用，请检查选中的节点。"',
    'anthropic 文案')

# 7) PF_MSG 的双分支 → 单条
between(
    '  PF_REASON=ok\n  if [ "$TUN_MODE" = "1" ]; then',
    '  return 0\n}',
    r'''  PF_REASON=ok
  PF_MSG="网络已锁定：容器内内核经 TUN 接管全部流量，内核退出即断网，宿主代理软件的模式与本机无关。出口 ${EXIT_IP}${EXIT_COUNTRY:+ · $EXIT_COUNTRY}${EXIT_CITY:+ · $EXIT_CITY}。"
''',
    'PF_MSG 单条')

# 8) exit.state 固定
between(
    '{\n  echo "state=$([ "$PF" -eq 0 ] && echo up || echo down)"',
    '} > "$GUARD_DIR/exit.state"',
    r'''{
  echo "state=$([ "$PF" -eq 0 ] && echo up || echo down)"
  echo "exit_ip=${EXIT_IP:-}"
  echo "exit_org=${EXIT_ORG:-}"
  echo "exit_city=${EXIT_CITY:-}"
  echo "mode=tun"
  echo "upstream=tun://Meta"
''',
    'exit.state')

# 9) 看门狗：删 NO_PROXY_CFG 分支、wpx 条件、TUN_MODE 外壳
between(
    '  if [ -z "$PROXY_URL" ] && [ "$TUN_MODE" != "1" ]; then',
    '  if [ "$CODE" = "204" ] || [ "$CODE" = "200" ]; then',
    r'''  # 裸 curl：流量自然进 TUN。加 -x 反而会去测一个不存在的代理端口。
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 6 \
          http://cp.cloudflare.com/generate_204 2>/dev/null)"
  # 内核或 TUN 网卡消失时，即使 204 还能通（例如宿主网关侧接管），也必须判失败。
  if ! pgrep -x mihomo >/dev/null 2>&1 || ! grep -qE '^ *Meta:' /proc/net/dev 2>/dev/null; then
    CODE=000
  fi
''',
    '看门狗 curl')

once(
    '      log "代理恢复，重跑预检：$PF_REASON"',
    '      log "内核链路恢复，重跑预检：$PF_REASON"',
    '恢复日志')
once(
    '          "代理已断开（连续 ${CONSEC_FAIL} 次探活失败），网络维持切断状态，不会回落到本机直连。请检查代理软件后等待自动恢复。"',
    '          "内核链路已断开（连续 ${CONSEC_FAIL} 次探活失败），网络维持切断状态，不会回落到本机直连。请检查选中的节点后等待自动恢复。"',
    'proxy_down 文案')

# 10) off 分支文案
once(
    '    "网络熔断已关闭：代理断开时流量可能直连出网，存在暴露真实环境的风险。"',
    '    "网络熔断已关闭：内核退出时流量可能直连出网，存在暴露真实环境的风险。"',
    'off 文案')

with open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print(f'OK: {n} 处替换，net-guard.sh 现 {len(s.splitlines())} 行')
