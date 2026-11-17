#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2.0：check-env.sh 改成 TUN 口径的检查报告数据源。

保留 emit_text / emit_json 的输出契约（报告窗口依赖 data.groups 是数组），
保留地区语言 / 浏览器 / 字体 / 身份 / 输入法 / 熔断 / 心跳 / 一致性检查，
把「网络与代理」整段换成「容器内内核 + TUN」检查项。
"""
import sys

P = r'E:\Web\FuckCladue\claude-vm\vm\scripts\check-env.sh'
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


# 1) 头部说明与 RUNTIME_UP 判定（单模式）
between(
    '# 运行时是否真的起来了',
    '# add <分组>',
    r'''# 运行时是否真的起来了（决定这次检查结论是否有意义）
# 注意：/opt/config/runtime-env 是上次运行留下的，环境停掉后它还在，
# 所以要认 entrypoint 写的就绪标记 + 会话进程，不能只看文件。
# 2.0 只有一种显示模式：Xtigervnc + openbox + websockify 串流桌面。
RUNTIME_UP=0
if [ -f /run/claude-vm/ready ]; then
  { pgrep -x Xtigervnc >/dev/null 2>&1 || pgrep -f "websockify --web" >/dev/null 2>&1; } && RUNTIME_UP=1
fi

''',
    'RUNTIME_UP')

# 2) 分组标题
once('    network)     echo "网络与代理" ;;',
     '    network)     echo "内核与出口" ;;',
     '分组标题')

# 3) 显示会话 wslg 分支
between(
    'if [ "$DISPLAY_MODE" = "wslg" ]; then',
    '# Claude Code CLI 是否真的能跑',
    r'''if [ -n "${DISPLAY:-}" ]; then
  add desktop pass "桌面会话" "DISPLAY=$DISPLAY（串流桌面）" \
    "Xtigervnc :1 + openbox + noVNC 是 2.0 唯一的显示模式，有真实 X11 桌面，不是无头环境。" ""
else
  add desktop warn "桌面会话" "无 DISPLAY" \
    "没有图形会话，Chrome 可能以 headless 方式运行，容易被判定为自动化。" \
    "先点「启动虚拟环境」，等桌面出现后再运行检查。"
fi

''',
    '显示会话')

# 4) 网络与代理整段 → TUN 口径
between(
    '# ------------------------------------------------------------\n# 3. 网络与代理',
    '# ------------------------------------------------------------\n# 2.4) 网络熔断（fail-closed）',
    r'''# ------------------------------------------------------------
# 3. 容器内内核与出口（2.0：mihomo + TUN 全量接管）
#    所有探测一律裸 curl —— 没有代理端口可填，流量自然进 TUN。
# ------------------------------------------------------------
TUN_NODE="${TUN_NODE:-}"
CORE_UP=0
pgrep -x mihomo >/dev/null 2>&1 && CORE_UP=1
META_UP=0
grep -qE '^ *Meta:' /proc/net/dev 2>/dev/null && META_UP=1

if [ "$RUNTIME_UP" != "1" ]; then
  add network info "容器内内核" "环境未运行" \
    "环境启动后才会拉起 mihomo 内核与 TUN 网卡。" \
    "先点「启动虚拟环境」，再运行检查。"
elif [ "$CORE_UP" = "1" ]; then
  add network pass "容器内内核" "mihomo 运行中 · 节点 ${TUN_NODE:-自动}" \
    "内核随镜像运行在虚拟环境内部，宿主代理软件不参与运行时链路。" ""
else
  add network fail "容器内内核" "mihomo 未运行" \
    "内核没起来时 TUN 与策略路由一起消失，而默认路由已被熔断，网络应立刻全断。" \
    "查看 /run/claude-vm/tun-core.log；确认已导入 YAML 并选中节点，再「停止 → 启动」。"
fi

if [ "$RUNTIME_UP" != "1" ]; then
  add network info "TUN 网卡" "环境未运行" "环境启动后才会创建 Meta 网卡。" ""
elif [ "$META_UP" = "1" ]; then
  add network pass "TUN 网卡" "Meta 已就绪" \
    "table 2022 覆盖路由把全部流量送进 TUN，DNS/UDP/IPv6 一并接管。" ""
else
  add network fail "TUN 网卡" "Meta 不存在" \
    "没有 TUN 网卡说明流量没被接管，此时不应放行业务。" \
    "检查 tun-core.sh 日志与 GeoIP 数据库是否随镜像预置。"
fi

if [ "$RUNTIME_UP" = "1" ]; then
  _dns=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)
  _fake=$(getent hosts api.ipify.org 2>/dev/null | awk '{print $1; exit}')
  if [ "$_dns" = "127.0.0.1" ]; then
    if printf '%s' "${_fake:-}" | grep -q '^198\.19\.'; then
      add network pass "DNS 归属" "127.0.0.1 · fake-ip ${_fake}" \
        "DNS 由容器内内核自己接管，宿主 DNS 代理与它的 fake-ip 段都插不进来。" ""
    else
      add network warn "DNS 归属" "127.0.0.1 · 解析 ${_fake:-无}" \
        "nameserver 已指向内核，但 getent 没落到 198.19.x 的 fake-ip 段，需要确认 DNS 劫持是否生效。" \
        "检查 tun-core.sh 的 ready 标记与 mihomo 的 dns 段。"
    fi
  else
    add network fail "DNS 归属" "nameserver ${_dns:-未知}" \
      "DNS 没有收进容器内内核，域名解析可能走 WSL 的 DNS 代理，出口地区会与 API 不一致。" \
      "确认 tun-core.sh 已切 resolv.conf；必要时「停止 → 启动」重建会话。"
  fi
fi

add network info "选中节点" "${TUN_NODE:-（未选择）}" \
  "全量单节点模式：所有流量走这一个节点，订阅原有的 proxy-groups / rules 被忽略。" \
  "换节点会进配置指纹，点「停止 → 启动」后生效。"

# 出口一致性：同一时刻问三个独立源，必须给出同一个 IP
_s1=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null | tr -d '[:space:]')
_s2=$(curl -s --max-time 8 https://ipinfo.io/ip 2>/dev/null | tr -d '[:space:]')
_s3=$(curl -s --max-time 8 https://api.ip.sb/ip 2>/dev/null | tr -d '[:space:]')
_uniq=$(printf '%s\n%s\n%s\n' "$_s1" "$_s2" "$_s3" | grep -E '^[0-9a-fA-F:.]{7,}$' | sort -u | tr '\n' ' ')
_n=$(printf '%s' "$_uniq" | wc -w | tr -d ' ')
if [ "${_n:-0}" -eq 0 ]; then
  add network warn "多源出口一致性" "无法验证" \
    "三个 IP 情报源都没有返回地址，内核或选中节点此刻不可用。" \
    "检查节点是否可达、mihomo 日志是否有连接错误。"
elif [ "$_n" -eq 1 ]; then
  add network pass "多源出口一致性" "三源一致 → ${_uniq% }" \
    "ipify / ipinfo / ip.sb 在同一时刻给出同一个出口，说明没有分叉。" ""
else
  add network fail "多源出口一致性" "出现 ${_n} 个出口：${_uniq% }" \
    "不同网站看到的出口 IP 不一致，说明分流规则没被忽略、或节点链路异常。" \
    "确认 YAML 已被 tun-merge.py 改成全量单节点。"
fi

# 直连封锁：显式绕过应用层代理，包仍会被 TUN 抓走，所以这里只作参考；
# 真正的 fail-closed 证据是「main 表没有默认路由」，见下一节的 netlink 查询。
if curl -s --max-time 4 --noproxy '*' https://ipinfo.io/ip >/dev/null 2>&1; then
  add network pass "出口可达性" "裸 curl 可出网" \
    "应用不需要任何显式代理配置，流量由 TUN 在网络层接管。" ""
else
  add network warn "出口可达性" "裸 curl 无回包" \
    "内核可能没起来、节点不可达，或熔断正处于预检未通过状态。" \
    "看 /run/claude-vm/net-guard.state 的 reason 与检查报告的网络分项。"
fi

# Anthropic 可达性（裸 curl）
_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.anthropic.com 2>/dev/null)
if [ -n "$_code" ] && [ "$_code" != "000" ]; then
  add network pass "Anthropic 可达" "HTTP $_code" \
    "经容器内内核访问 api.anthropic.com 成功，链路完整。" ""
else
  add network fail "Anthropic 可达" "无响应" \
    "Claude Code 会直接不可用。检查选中的节点是否可达、出口是否落在受限地区。" \
    "在设置里换一个节点后「停止 → 启动」。"
fi

# claude.ai 是否被 Cloudflare 人机校验拦着
_ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
_ca=$(curl -sI --max-time 10 -A "$_ua" https://claude.ai/ 2>/dev/null)
if printf '%s' "$_ca" | grep -qi 'cf-mitigated:[[:space:]]*challenge'; then
  add network warn "claude.ai 人机校验" "被 CF 挑战（403）" \
    "Cloudflare 把当前节点判为可疑；跨域探活会被 CORP 头挡掉，看起来像超时。" \
    "换住宅/ISP 节点可显著缓解；网页里遇到验证码通过即可继续登录。"
elif printf '%s' "$_ca" | grep -qE '^HTTP/[0-9.]+ 200'; then
  add network pass "claude.ai 人机校验" "未触发" \
    "claude.ai 直接返回页面，当前节点没有被判为可疑。" ""
fi

# 系统 DNS：只判断有没有企业后缀污染
_sfx=$(grep -E '^(search|domain)[[:space:]]' /etc/resolv.conf 2>/dev/null | head -1)
if [ -n "$_sfx" ]; then
  add network warn "系统 DNS" "残留企业后缀 ${_sfx#* }" \
    "WSL 把宿主网卡的 DNS 搜索域写进了 resolv.conf，会混进诊断包与应用日志。" \
    "重启环境让 entrypoint 自动清掉；或在 /etc/wsl.conf 加 [network] generateResolvConf=false。"
else
  add network pass "系统 DNS" "127.0.0.1（无企业后缀）" \
    "DNS 由容器内内核接管，没有宿主继承的企业搜索域。" ""
fi

''',
    '网络与代理段')

# 5) 熔断段文案：代理 → 内核（逐条替换具体句子）
for old, new in [
    ('"默认路由已移除、IPv6 已关闭：非代理目标内核直接不可达，代理断开时不会回落到本机直连。"',
     '"默认路由已移除、IPv6 已关闭：内核退出时 TUN 与策略路由一起消失，立刻全断，不会回落到本机直连。"'),
    ('"按提示修好代理后，点「停止」再「启动」重新预检；这期间网络保持切断。"',
     '"按提示修好节点/内核后，点「停止」再「启动」重新预检；这期间网络保持切断。"'),
    ('"代理探活连续失败，但路由封锁仍在，流量不会改走本机直连（这正是预期保护）。" \\\n      "检查代理软件是否还在运行；恢复后看门狗会自动重跑预检。"',
     '"内核链路探活连续失败，但路由封锁仍在，流量不会改走本机直连（这正是预期保护）。" \\\n      "检查 mihomo 与选中节点；恢复后看门狗会自动重跑预检。"'),
    ('"熔断被显式关闭，代理一旦断开，流量会直接走本机网络出网，真实环境会暴露。"',
     '"熔断被显式关闭，内核一旦退出，流量可能走本机网络出网，真实环境会暴露。"'),
    ('"没有读到 net-guard.state，无法确认网络是否被强制约束在代理链路上。"',
     '"没有读到 net-guard.state，无法确认默认路由是否已被移除。"'),
    ('"网络层没有完全封锁，代理断开时流量可能从直连或 IPv6 出网。"',
     '"网络层没有完全封锁，内核退出时流量可能从直连或 IPv6 出网。"'),
    ('"显式绕过代理后依然能访问外网，说明存在没走代理的流量。"',
     '"绕过应用层代理后依然能出网；TUN 模式下这是正常的（流量被网卡抓走），需结合 main 表默认路由判断。"'),
    ('"绕过代理的请求无法出网，链路是真正的 fail-closed。"',
     '"内核未接管时裸请求无法出网，链路是真正的 fail-closed。"'),
    ('"代理可达、出口地区安全、多源出口一致、Anthropic 可达，预检通过后网络才允许使用。"',
     '"内核与 TUN 网卡存活、出口地区安全、多源出口一致、Anthropic 可达，预检通过后网络才允许使用。"'),
    ('"修好代理后重新启动；预检不通过时网络保持切断，不会带病放行。"',
     '"修好节点/内核后重新启动；预检不通过时网络保持切断，不会带病放行。"'),
    ('"看门狗在持续确认默认路由没有被 WSL 重新加回来。"',
     '"看门狗在持续确认默认路由没有被 WSL 重新加回来、内核与 TUN 网卡仍在。"'),
]:
    once(old, new, '熔断文案')

# 6) 输入法 WSLg 提示
once(
    '    "WSLg 不转发 Windows IME 组合事件；中文可用宿主输入法打好后 Ctrl+Shift+V 粘贴。" ""',
    '    "串流桌面里中文可用宿主输入法打好后 Ctrl+Shift+V 粘贴，或启用 fcitx5 在虚拟环境内直接输入。" ""',
    '输入法提示')

# 7) 出口信息段：裸 curl，去掉「代理不通退回直连」逻辑
between(
    '# 出口信息：优先经代理探测；代理不通时退回直连，并如实标注',
    '# 出口类型：机房 IP 是 Cloudflare 判定自动化的主要依据',
    r'''# 出口信息：裸 curl 探测（流量自然进 TUN）
_eg=$(curl -s --max-time 10 https://ipinfo.io/json 2>/dev/null)
_eip=$(_pick "$_eg" ip)
_ecc=$(_pick "$_eg" country)
_eorg=$(_pick "$_eg" org)
_ecity=$(_pick "$_eg" city)

if [ -z "$_eip" ]; then
  add network warn "出口 IP" "无法探测" \
    "拿不到出口信息，内核或选中节点此刻不可用。" \
    "检查 tun-core.log 与选中节点的连通性。"
else
  _edet=""
  [ -n "$_ecity" ] && _edet="位于 $_ecity"
  [ -n "$_eorg" ] && _edet="${_edet}${_edet:+，}归属 $_eorg"
  add network pass "出口 IP" "$_eip" "$_edet" ""
fi

''',
    '出口信息')

# 8) 出口类型段：去掉 `UP` / ALL_ON 条件
once(
    'if [ -n "$_eorg" ] && { [ -z "$UP" ] || [ "$_egress_via" = "代理" ]; }; then',
    'if [ -n "$_eorg" ]; then',
    '出口类型条件')
once(
    '    if [ "$ALL_ON" = 1 ]; then\n'
    '      add network warn "出口类型" "机房 IP（IDC / 云主机）" \\\n'
    '        "这是你选的代理节点本身的属性，不是本地环境的问题：真的在那种服务器上用 Claude Code 也是这个结果。" \\\n'
    '        "想换掉只能改用住宅/ISP 节点的代理；在此之前保持时区、语言与节点所在地区一致即可。"\n'
    '    else\n'
    '      add network warn "出口类型" "机房 IP（IDC / 云主机）" \\\n'
    '        "Anthropic 与 Cloudflare 会把机房 IP 视为非家庭网络，是当前最明显的风险点。" \\\n'
    '        "条件允许时换成住宅或 ISP 静态代理，并让它与账号地区一致；这比任何本地改造都有效。"\n'
    '    fi',
    '    add network warn "出口类型" "机房 IP（IDC / 云主机）" \\\n'
    '      "这是选中的节点本身的属性，不是本地环境的问题。Anthropic 与 Cloudflare 会把机房 IP 视为非家庭网络。" \\\n'
    '      "想换掉只能改用住宅/ISP 节点；在此之前保持画像内部自洽即可。"',
    '出口类型分支')

# 9) checkcc 段：条件与 -x
once(
    'if [ -n "$UP" ] && [ -n "${_eip:-}" ]; then\n'
    '  _ccjson=$(curl -s --compressed --max-time 15 -x "$PROXY_EP" \\\n',
    'if [ -n "${_eip:-}" ] && [ "$CORE_UP" = "1" ]; then\n'
    '  _ccjson=$(curl -s --compressed --max-time 15 \\\n',
    'checkcc 条件')

# 10) 一致性段：白名单覆盖 → 单节点出口确认
between(
    '# 白名单是否覆盖登录所需域名',
    '# ------------------------------------------------------------\n# 输出',
    r'''# 全量单节点：确认订阅的分流规则已被忽略
if [ "$CORE_UP" = "1" ] && [ -f /opt/config/mihomo.yaml ]; then
  if grep -q 'MATCH,ClaudeVM' /opt/config/mihomo.yaml; then
    add consistency pass "出口规则" "全量单节点 → ${TUN_NODE:-自动}" \
      "订阅原有的 proxy-groups / rules 已被剥离，所有流量走选中的单一节点，不存在登录与 API 出口分叉。" ""
  else
    add consistency warn "出口规则" "未检测到单节点兜底规则" \
      "生成的内核配置里没有 MATCH,ClaudeVM，订阅的分流规则可能仍在生效。" \
      "点「停止 → 启动」让 tun-merge.py 重新生成配置。"
  fi
elif [ "$RUNTIME_UP" != "1" ]; then
  add consistency info "出口规则" "环境未运行" "启动后由 tun-merge.py 生成单节点配置。" ""
else
  add consistency warn "出口规则" "内核配置未生成" \
    "没有 /opt/config/mihomo.yaml，无法确认出口规则。" \
    "确认已导入 YAML 并选中节点。"
fi

''',
    '一致性白名单段')

# 11) 一致性段里「代理规则」措辞
once(
    '      "出口落在 CN/HK/MO 受限名单内，多半是代理规则把该域名直连了。" \\\n'
    '      "把代理切到全局/统一出口，检查分流规则，然后重启环境。" ;;',
    '      "出口落在 CN/HK/MO 受限名单内，多半是选中的节点在国内。" \\\n'
    '      "在设置里换一个境外节点，然后「停止 → 启动」。" ;;',
    '受限地区建议')

with open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print(f'OK: {n} 处替换，check-env.sh 现 {len(s.splitlines())} 行')
