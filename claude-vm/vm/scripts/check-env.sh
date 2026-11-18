#!/usr/bin/env bash
# ============================================================
# check-env.sh — 对照 check-cc 的封号/受限风险维度，校对本地虚拟环境
#
# 用法：
#   check-env.sh          人类可读输出（命令行用）
#   check-env.sh --json   结构化 JSON（桌面程序渲染用）
#
# 设计原则：每个维度给出「结论 + 实测值 + 为什么重要 + 怎么修」，
# 而不是把原始日志直接丢给用户。
# ============================================================

MODE=text
[ "${1:-}" = "--json" ] && MODE=json
SCOPE=all
if [ "${1:-}" = "--network-json" ]; then MODE=json; SCOPE=network; fi

# 独立会话（桌面程序点「自检」）继承不到 entrypoint 导出的变量，先读回落盘的环境
if [ -f /opt/config/runtime-env ]; then
  . /opt/config/runtime-env
fi

REGION_LABEL="${REGION_LABEL:-${TZ:-未知}}"
US=$'\x1f'
PASS=0; WARN=0; FAIL=0; INFO=0
ITEMS=()

# 运行时是否真的起来了（决定这次检查结论是否有意义）
# 注意：/opt/config/runtime-env 是上次运行留下的，环境停掉后它还在，
# 所以要认 entrypoint 写的就绪标记 + 会话进程，不能只看文件。
# 2.0 只有一种显示模式：Xtigervnc + openbox + websockify 串流桌面。
RUNTIME_UP=0
if [ -f /run/claude-vm/ready ]; then
  { pgrep -x Xtigervnc >/dev/null 2>&1 || pgrep -f "websockify --web" >/dev/null 2>&1; } && RUNTIME_UP=1
fi

# add <分组> <状态> <名称> <实测值> <说明> <建议>
add() {
  ITEMS+=("$1${US}$2${US}$3${US}$4${US}$5${US}$6")
  case "$2" in
    pass) PASS=$((PASS+1)) ;;
    warn) WARN=$((WARN+1)) ;;
    fail) FAIL=$((FAIL+1)) ;;
    *)    INFO=$((INFO+1)) ;;
  esac
}

gtitle() {
  case "$1" in
    region)      echo "地区与语言" ;;
    desktop)     echo "浏览器与运行环境" ;;
    network)     echo "内核与出口" ;;
    consistency) echo "一致性判断" ;;
    *)           echo "$1" ;;
  esac
}

jesc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\r'/}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# 从 ipinfo.io 的 JSON 里取字段（零依赖，仅供出口探测使用）
_pick() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }

# ------------------------------------------------------------
# 1. 地区与语言
# ------------------------------------------------------------
if [ "$SCOPE" = all ]; then
_tzsys=$(cat /etc/timezone 2>/dev/null)
# 以「浏览器/JS 实际读到的时区」为准：Chrome 与 Node 都按 TZ 环境变量解析
_intl_tz=$(node -e "console.log(new Intl.DateTimeFormat().resolvedOptions().timeZone)" 2>/dev/null)
if [ -z "${TZ:-}" ]; then
  add region warn "系统时区" "未设置" \
    "没有指定时区，浏览器会按默认 UTC 上报，与所选地区不符。" \
    "在左侧选择目标地区后重启环境。"
elif [ -n "$_intl_tz" ] && [ "$_intl_tz" = "$TZ" ]; then
  if [ "$_tzsys" = "$TZ" ]; then
    add region pass "系统时区" "$TZ" "系统与浏览器读到的时区一致。" ""
  else
    add region pass "系统时区" "$TZ" \
      "浏览器读到的时区正确（系统文件为 ${_tzsys:-未知}，WSL 会把它同步成 Windows 时区，不影响浏览器）。" ""
  fi
else
  add region warn "系统时区" "${_intl_tz:-未知}（期望 $TZ）" \
    "浏览器脚本读到的时区与所选地区不一致，会暴露出另一个地区。" \
    "点「停止」再「启动」；若仍不一致，说明运行时用了旧脚本。"
fi

if [ -n "${LANG:-}" ] && [ "$LANG" != "C" ] && [ "$LANG" != "POSIX" ]; then
  if [ "$LANG" = "${LC_ALL:-$LANG}" ]; then
    add region pass "系统语言" "$LANG" "LANG 与 LC_ALL 一致，各程序读到的语言相同。" ""
  else
    add region warn "系统语言" "LANG=$LANG / LC_ALL=${LC_ALL:-空}" \
      "两个变量不一致，不同程序可能读到不同语言，形成矛盾信号。" \
      "重启虚拟环境即可，程序启动时会统一写入。"
  fi
else
  add region warn "系统语言" "${LANG:-未设置}" \
    "当前是 C/POSIX 语言环境，会被识别为非本地化环境。" \
    "在左侧选择目标地区后重启环境。"
fi

# 该 locale 是否真的生成过（没生成会导致中日文显示成方块）
_norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed 's/utf-\?8/utf8/g'; }
if command -v locale >/dev/null 2>&1 && [ -n "${LANG:-}" ]; then
  _want=$(_norm "$LANG"); _found=0
  while read -r _l; do
    [ "$(_norm "$_l")" = "$_want" ] && _found=1
  done < <(locale -a 2>/dev/null)
  if [ "$_found" -eq 1 ]; then
    add region pass "语言包" "$LANG 已生成" "系统里存在该 locale，界面与文档不会出现方块字。" ""
  else
    add region warn "语言包" "$LANG 未生成" \
      "系统里没有这个 locale，中日文会显示为方块，属于明显的虚拟环境特征。" \
      "点「停止」再「启动」让 entrypoint 现场生成该 locale（台北画像需 zh_TW.UTF-8）。"
  fi
fi

# Node/浏览器的 Intl 语言
_intl=$(node -e "console.log(new Intl.DateTimeFormat().resolvedOptions().locale)" 2>/dev/null)
if [ -n "$_intl" ]; then
  _intl_n=$(printf '%s' "$_intl" | tr '_' '-' | tr 'A-Z' 'a-z')
  _lang_n=$(printf '%s' "${LANG%%.*}" | tr '_' '-' | tr 'A-Z' 'a-z')
  if [ "$_intl_n" = "$_lang_n" ]; then
    add region pass "浏览器语言(Intl)" "$_intl" "JavaScript 侧语言与系统语言一致。" ""
  else
    add region warn "浏览器语言(Intl)" "$_intl（系统 $LANG）" \
      "浏览器脚本读到的语言与系统语言不同，两边会互相矛盾。" \
      "重启虚拟环境；若仍不一致，检查是否被 LANG 覆盖。"
  fi
fi

# Chrome 实际发出的 Accept-Language（--lang 管不到已存在 Profile 的偏好）
# 用真实 Profile 的副本跑一次 headless 回显，量到的就是登录 claude.ai 真正发出的头。
if [ -f /opt/scripts/chrome-lang.py ]; then
  mapfile -t _CL < <(python3 /opt/scripts/chrome-lang.py --shell 2>/dev/null)
  _cl_mode="${_CL[0]:-error}"
  _cl_hdr="${_CL[1]:-}"
  _cl_ok="${_CL[2]:-false}"
  _cl_detail="${_CL[3]:-}"
  _cl_ui="${_CL[4]:-}"
  # 期望语言跟画像的 CHROME_LANG 走；老环境没有该变量时才退回从 LANG 推。
  _cl_want="${CHROME_LANG:-$(printf '%s' "${LANG%%.*}" | tr '_' '-')}"
  # 浏览器界面语言由 Profile 的 intl.app_locale 决定，--lang 在有旧实例时会被忽略。
  # 只测 Accept-Language 会「报告全绿、实际界面还是繁中」，所以单独列一项。
  if [ -n "$_cl_ui" ] && [ "$_cl_ui" != "$_cl_want" ]; then
    add region fail "浏览器 UI 语言" "$_cl_ui（期望 ${_cl_want}）" \
      "Chrome 界面语言与画像不一致：切换画像后若仍有旧 Chrome 实例，它会保持旧语言，并在退出时把旧值写回磁盘。" \
      "点「停止」再「启动」重建会话；新版本启动时会清掉残留 Chrome 并写入 app_locale。"
  elif [ -n "$_cl_ui" ]; then
    add region pass "浏览器 UI 语言" "$_cl_ui" "Chrome 界面语言与画像一致。" ""
  fi
  if [ -z "$_cl_hdr" ]; then
    add region fail "浏览器语言头" "未配置" \
      "Chrome Profile 里没有语言偏好，登录请求会退回 en-US，与系统 ${LANG} 矛盾。" \
      "执行 /opt/scripts/chrome-lang.py --set，或重启虚拟环境让 entrypoint 自动修正。"
  elif [ "$_cl_ok" = "true" ]; then
    add region pass "浏览器语言头" "$_cl_hdr" \
      "${_cl_mode}：首选 ${_cl_want}，与系统 locale 一致；${_cl_detail}。" ""
  else
    add region fail "浏览器语言头" "$_cl_hdr（期望 ${_cl_want}）" \
      "浏览器语言头不合格（${_cl_detail}）：可能与系统地区不一致，或含重复 q 权重这种畸形写法，登录时比 en-US 更可疑。" \
      "执行 /opt/scripts/chrome-lang.py --set（Chrome 正在运行时先关掉它），再重启环境。"
  fi
fi

# ------------------------------------------------------------
# 2. 浏览器与运行环境
# ------------------------------------------------------------
if command -v google-chrome-stable >/dev/null 2>&1; then
  _v=$(google-chrome-stable --version 2>/dev/null | awk '{print $NF}')
  add desktop pass "浏览器" "Chrome $_v" "运行的是真实 Chrome，不是 WebView 或 headless。" ""
else
  add desktop fail "浏览器" "未安装" \
    "找不到 google-chrome-stable，登录页无法用真实浏览器打开。" \
    "重新导入环境（删除发行版后重启程序会自动重建）。"
fi

if [ -n "${DISPLAY:-}" ]; then
  add desktop pass "桌面会话" "DISPLAY=$DISPLAY（串流桌面）" \
    "Xtigervnc :1 + openbox + noVNC 是 2.0 唯一的显示模式，有真实 X11 桌面，不是无头环境。" ""
else
  add desktop warn "桌面会话" "无 DISPLAY" \
    "没有图形会话，Chrome 可能以 headless 方式运行，容易被判定为自动化。" \
    "先点「启动虚拟环境」，等桌面出现后再运行检查。"
fi

# Claude Code CLI 是否真的能跑（自更新中断会把包换成报错桩，外表看不出来）
if command -v claude >/dev/null 2>&1; then
  _cv=$(timeout 20 claude --version 2>&1 | head -1)
  if printf '%s' "$_cv" | grep -qE '^[0-9]+\.[0-9]+'; then
    add desktop pass "Claude Code" "$_cv" "命令行能正常启动并报告版本。" ""
  else
    add desktop fail "Claude Code" "无法运行" \
      "claude 命令在，但跑不起来（常见于自更新中断：包变成了报错桩 + 残片）。" \
      "重启虚拟环境会重建入口链接；仍失败可在终端执行 npm i -g @anthropic-ai/claude-code。"
  fi
else
  add desktop fail "Claude Code" "未安装" \
    "PATH 里没有 claude 命令，终端里无法启动 Claude Code。" \
    "重启虚拟环境；仍失败请重新导入环境。"
fi

if command -v fc-list >/dev/null 2>&1; then
  _fc=$(fc-list 2>/dev/null | wc -l | tr -d ' ')
  # 镜像刻意不带中文字体（等宽 CJK 会把拉丁字符按全角排版，体积也大），
  # 所以「几十个」是设计值，不是缺陷。低于 20 才是真出了问题（字体包没装上）。
  if [ "${_fc:-0}" -ge 20 ]; then
    add desktop pass "字体" "$_fc 个已安装" "字体数量正常，页面渲染不会缺字形。" ""
  else
    add desktop warn "字体" "仅 $_fc 个" \
      "字体过少会让页面排版异常，是精简环境的明显特征。" \
      "重新导入环境（镜像自带 Fira Code / DejaVu / Liberation 字族）。"
  fi

  # 中文字体本身不是罪 —— 罪的是「被指纹名单点名的那几个家族名」。
  # 检测站用的是一份硬编码名单 + canvas 字宽比对，所以这里按同一份名单判，
  # 而不是见到中文字体就报警（Noto Sans SC 不在名单里，中文显示与它无关）。
  _bad_fonts=""
  for _n in "Microsoft YaHei" "Microsoft JhengHei" "PingFang SC" "Hiragino Sans GB" \
            "STHeiti" "STSong" "SimSun" "SimHei" "Noto Sans CJK SC" "Source Han Sans SC" \
            "WenQuanYi Micro Hei" "PingFang TC" "Noto Sans CJK TC" "Source Han Sans TC" \
            "MiSans" "HarmonyOS Sans" "OPPO Sans" "vivo Sans" "Honor Sans" \
            "Alibaba PuHuiTi" "WPS Fangzheng" "FZLanTingHeiS"; do
    if fc-list "$_n" 2>/dev/null | grep -q .; then _bad_fonts="${_bad_fonts} ${_n}"; fi
  done
  if [ -z "$_bad_fonts" ]; then
    add desktop pass "字体地区特征" "未命中名单" \
      "指纹名单里的中文字体一个都没有；中文显示由名单外的 Noto Sans SC / Noto Sans TC 承担，后者负责繁体笔形。" ""
  else
    add desktop warn "字体地区特征" "命中：${_bad_fonts# }" \
      "这些家族名在检测站的指纹名单里，会被 canvas 字宽比对判成「中国字体」并扣分。" \
      "卸载对应字体包（重启虚拟环境会自动清理 Noto CJK）。"
  fi
fi

# 环境身份：主机名 / machine-id 是否与同一镜像的其它安装区分开
# 这两项检测站看不到，但会混进诊断包、日志与遥测，构成批量镜像指纹。
_idf=/opt/config/identity
_tpl_mid="181553d0b62b293fb41e6ba46ae962c1"
if [ -s "$_idf" ]; then
  vm_hostname=""; vm_machine_id=""
  . "$_idf"
  _cur_hn=$(hostname 2>/dev/null)
  _cur_mid=$(cat /etc/machine-id 2>/dev/null)
  if [ -n "$vm_hostname" ] && [ "$_cur_hn" = "$vm_hostname" ] \
     && [ -n "$vm_machine_id" ] && [ "$_cur_mid" = "$vm_machine_id" ] \
     && [ "$_cur_mid" != "$_tpl_mid" ]; then
    add desktop pass "环境身份" "$_cur_hn" \
      "主机名与 machine-id 是首次启动时独立生成并持久化的，不会和同一镜像的其它安装撞车。" ""
  else
    add desktop warn "环境身份" "与持久化身份不一致" \
      "当前 hostname / machine-id 与 /opt/config/identity 记录的不同，可能是 WSL 覆盖了 /etc/hostname。" \
      "重启虚拟环境让 entrypoint 重新套用；身份值会复用，不会变成新机器。"
  fi
else
  add desktop info "环境身份" "尚未初始化" \
    "首次启动时生成一次独立的主机名与 machine-id；环境未运行时不需要这一项。" ""
fi
fi # SCOPE=all

# ------------------------------------------------------------
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
    "已检测到 Meta 网卡；这本身不能证明所有流量都经过代理。" ""
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
  "这是启动时保存的节点名称；实际出口需结合其他网络检查。" \
  "换节点会进配置指纹，点「停止 → 启动」后生效。"

# 出口一致性：同一时刻问三个独立源，必须给出同一个 IP
_s1=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null | tr -d '[:space:]')
_s2=$(curl -s --max-time 8 https://ipinfo.io/ip 2>/dev/null | tr -d '[:space:]')
_s3=$(curl -s --max-time 8 https://api.ip.sb/ip 2>/dev/null | tr -d '[:space:]')
mapfile -t _ip_check < <(printf '%s\n%s\n%s\n' "$_s1" "$_s2" "$_s3" | python3 -c '
import ipaddress, sys
addresses = []
for line in sys.stdin:
    try:
        addresses.append(str(ipaddress.ip_address(line.strip())))
    except ValueError:
        pass
unique = sorted(set(addresses))
print(len(addresses))
print(len(unique))
print(" ".join(unique))
' | tr -d '\r')
_responded=${_ip_check[0]:-0}
_n=${_ip_check[1]:-0}
_uniq=${_ip_check[2]:-}
if [ "${_n:-0}" -eq 0 ]; then
  add network warn "多源出口一致性" "无法验证" \
    "三个 IP 情报源都没有返回地址，内核或选中节点此刻不可用。" \
    "检查节点是否可达、mihomo 日志是否有连接错误。"
elif [ "$_n" -eq 1 ] && [ "$_responded" -ge 2 ]; then
  add network pass "多源出口一致性" "${_responded}/3 个来源一致 · ${_uniq% }" \
    "成功返回的检测源给出了相同的出口地址。" ""
elif [ "$_n" -eq 1 ]; then
  add network warn "多源出口一致性" "仅 1/3 个来源返回" \
    "只有一个检测源返回地址，无法比较不同来源。" "稍后重新检测。"
else
  add network fail "多源出口一致性" "出现 ${_n} 个出口：${_uniq% }" \
    "检测源返回了不同的出口地址，可能与节点链路或路由有关。" \
    "检查节点配置与线路后重新检测。"
fi

# 直连封锁：显式绕过应用层代理，包仍会被 TUN 抓走，所以这里只作参考；
# 真正的 fail-closed 证据是「main 表没有默认路由」，见下一节的 netlink 查询。
if curl -s --max-time 4 --noproxy '*' https://ipinfo.io/ip >/dev/null 2>&1; then
  add network pass "出口可达性" "裸 curl 可出网" \
    "请求未使用应用层代理并取得响应。此结果本身无法判断流量是否绕过 TUN。" ""
else
  add network warn "出口可达性" "裸 curl 无回包" \
    "内核可能没起来、节点不可达，或熔断正处于预检未通过状态。" \
    "看 /run/claude-vm/net-guard.state 的 reason 与检查报告的网络分项。"
fi

# Anthropic 可达性（裸 curl）
_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://api.anthropic.com 2>/dev/null)
if [ -n "$_code" ] && [ "$_code" != "000" ]; then
  add network info "Anthropic 接口响应" "HTTP $_code" \
    "api.anthropic.com 返回了 HTTP 状态码；不代表账号、地区或 API 调用已通过验证。" ""
else
  add network warn "Anthropic 接口响应" "无响应" \
    "本次请求没有获得 HTTP 响应；可能是节点、目标服务或暂时的网络问题。" \
    "在设置里换一个节点后「停止 → 启动」。"
fi

# claude.ai 是否被 Cloudflare 人机校验拦着
_ua='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
_ca=$(curl -sI --max-time 10 -A "$_ua" https://claude.ai/ 2>/dev/null)
if printf '%s' "$_ca" | grep -qi 'cf-mitigated:[[:space:]]*challenge'; then
  add network warn "claude.ai 人机校验" "被 CF 挑战（403）" \
    "本次 curl HEAD 响应包含 Cloudflare challenge 标记；不能代表实际浏览器登录结果。" \
    "可在虚拟桌面浏览器中核对实际访问情况。"
elif printf '%s' "$_ca" | grep -qE '^HTTP/[0-9.]+ 200'; then
  add network pass "claude.ai 人机校验" "未触发" \
    "本次 curl HEAD 请求收到 HTTP 200；不能代表浏览器登录时的结果。" ""
else
  add network info "claude.ai 人机校验" "本次无法判断" \
    "此项仅检查 curl HEAD 响应，未获得可判断的结果；不代表浏览器已通过或失败。" ""
fi

# 系统 DNS：只判断有没有企业后缀污染
_sfx=$(grep -E '^(search|domain)[[:space:]]' /etc/resolv.conf 2>/dev/null | head -1)
if [ -n "$_sfx" ]; then
  add network warn "系统 DNS" "残留企业后缀 ${_sfx#* }" \
    "WSL 把宿主网卡的 DNS 搜索域写进了 resolv.conf，会混进诊断包与应用日志。" \
    "重启环境让 entrypoint 自动清掉；或在 /etc/wsl.conf 加 [network] generateResolvConf=false。"
elif [ -n "${_dns:-}" ]; then
  add network info "DNS 搜索域" "未配置搜索域" \
    "仅检查 resolv.conf 中的 search 和 domain；DNS 服务器请参考 DNS 归属。" ""
else
  add network warn "DNS 搜索域" "无法确认 DNS 配置" \
    "没有读取到 DNS 服务器，不能将缺少搜索域视为 DNS 正常。" "检查虚拟环境中的 resolv.conf。"
fi

# ------------------------------------------------------------
# 2.4) 网络熔断（fail-closed）
#      状态文件只是「守卫自己怎么说」，不能全信：再直接问一次内核路由表，
#      并真的发一发绕过代理的请求，确认它出不去。
#      环境没运行时不判 fail —— 那时压根没在用 Claude，报一堆高危反而误导。
# ------------------------------------------------------------
if [ "$RUNTIME_UP" != "1" ]; then
  add network info "网络熔断" "环境未运行" \
    "虚拟环境启动后才会启用 fail-closed 熔断；当前网络状态不代表运行时的保护状态。" \
    "先点「启动虚拟环境」，再运行自检查看熔断分项。"
else
_GS=/run/claude-vm/net-guard.state
_kv() { sed -n "s/^$1=//p" "$_GS" 2>/dev/null | head -1 | sed 's/^"//; s/"$//'; }
_GUARD_STATE="$([ -f "$_GS" ] && _kv state || echo missing)"
_GUARD_REASON="$([ -f "$_GS" ] && _kv reason || echo unknown)"
_GUARD_MSG="$([ -f "$_GS" ] && _kv message || echo '没有读到守卫状态')"
_GUARD_TS="$([ -f "$_GS" ] && _kv ts || echo 0)"

case "$_GUARD_STATE" in
  guarded)
    add network info "网络守卫状态" "守卫报告已锁定" \
      "此项来自守卫状态文件；请同时查看路由状态和守卫心跳。" "" ;;
  blocked)
    add network fail "网络熔断" "已封锁 · $_GUARD_REASON" \
      "$_GUARD_MSG" "按提示修好节点/内核后，点「停止」再「启动」重新预检；这期间网络保持切断。" ;;
  proxy_down)
    add network warn "网络熔断" "代理断开 · 网络已切断" \
      "内核链路探活连续失败，但路由封锁仍在，流量不会改走本机直连（这正是预期保护）。" \
      "检查 mihomo 与选中节点；恢复后看门狗会自动重跑预检。" ;;
  off)
    add network fail "网络熔断" "已关闭（NET_GUARD=off）" \
      "熔断被显式关闭，内核一旦退出，流量可能走本机网络出网，真实环境会暴露。" \
      "在高级设置里把「网络熔断」改回 strict（推荐）。" ;;
  *)
    add network warn "网络熔断" "守卫未运行" \
      "没有读到 net-guard.state，无法确认默认路由是否已被移除。" \
      "点「停止」再「启动」让 entrypoint 拉起 net-guard；反复如此说明脚本没同步成功。" ;;
esac

_RS=$(python3 /opt/scripts/net-guard.py status 2>/dev/null)
_locked=$(printf '%s' "$_RS" | sed -n 's/.*"locked": *\([a-z]*\).*/\1/p')
_v6off=$(printf '%s' "$_RS" | sed -n 's/.*"ipv6_disabled": *\([a-z]*\).*/\1/p')
if [ "$_locked" = "true" ] && [ "$_v6off" = "true" ]; then
  add network pass "直连封锁验证" "IPv4 默认路由已移除 · IPv6 已关闭" \
    "已检查 IPv4 主路由表的默认路由和 IPv6 开关；这不是内核退出后的断网实测。" ""
elif [ -z "$_locked" ] || [ -z "$_v6off" ]; then
  add network warn "直连封锁验证" "无法读取路由状态" \
    "没有取得完整的路由和 IPv6 状态，无法确认熔断条件。" \
    "检查虚拟环境中的 net-guard.py 是否可运行。"
else
  add network fail "直连封锁验证" "IPv4 locked=${_locked:-未知} / IPv6 off=${_v6off:-未知}" \
    "网络层没有完全封锁，内核退出时流量可能从直连或 IPv6 出网。" \
    "点「停止」再「启动」让 net-guard 重新熔断；反复失败请确认以 root 运行、CAP_NET_ADMIN 未被禁用。"
fi

case "$_GUARD_REASON" in
  ok)
    add network pass "代理预检" "通过 · 出口 $([ -f "$_GS" ] && _kv exit_ip || echo 未知)/$([ -f "$_GS" ] && _kv exit_country || echo 未知)" \
      "守卫记录的最近一次预检已通过；当前状态请结合路由与心跳检查。" "" ;;
  skipped|unknown|"")
    add network info "代理预检" "未执行" \
      "熔断关闭或守卫尚未运行时没有预检结果，此时无法保证代理配置正确。" "" ;;
  *)
    add network fail "代理预检" "$_GUARD_REASON" "$_GUARD_MSG" \
      "修好节点/内核后重新启动；预检不通过时网络保持切断，不会带病放行。" ;;
esac

_now=$(date +%s)
_guard_pid=$(cat /run/claude-vm/net-guard.pid 2>/dev/null)
if ! [[ "$_guard_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$_guard_pid" 2>/dev/null \
   || ! tr '\0' ' ' < "/proc/$_guard_pid/cmdline" 2>/dev/null | grep -q 'net-guard.sh'; then
  add network warn "守卫心跳" "守卫进程未确认" \
    "无法确认状态文件对应的守卫进程仍在运行。" "检查守卫进程与网络保护状态。"
elif [ -f "$_GS" ] && [[ "$_GUARD_TS" =~ ^[0-9]+$ ]] && [ "$_GUARD_STATE" != "off" ]; then
  _age=$((_now - _GUARD_TS))
  if [ "$_age" -gt 30 ]; then
    add network warn "守卫心跳" "已停滞 ${_age} 秒" \
      "看门狗超过 30 秒没有刷新状态，熔断规则可能已失去周期性 re-assert 保护。" \
      "点「停止」再「启动」重建会话。"
  elif [ "$_age" -lt -5 ]; then
    add network warn "守卫心跳" "时间戳异常" \
      "守卫状态时间晚于当前系统时间，无法确认心跳。" "检查系统时间和守卫状态。"
  else
    add network pass "守卫心跳" "正常（${_age} 秒前刷新）" \
      "守卫状态文件最近一次刷新距今 ${_age} 秒。" ""
  fi
else
  add network warn "守卫心跳" "无法读取心跳" \
    "守卫状态或时间戳不可用，无法确认其最新状态。" "检查守卫状态后重试。"
fi
fi

# ------------------------------------------------------------
# 2.5) 中文输入法（可选，仅 INPUT_METHOD=rime 时要求 fcitx5 正常）
# ------------------------------------------------------------
if [ "$SCOPE" = all ]; then
_IM="${INPUT_METHOD:-off}"
if [ "$RUNTIME_UP" != "1" ]; then
  add desktop info "中文输入法" "环境未运行" \
    "启动虚拟环境后才能检查输入法服务。" ""
elif [ "$_IM" != "rime" ]; then
  add desktop info "中文输入法" "未启用" \
    "串流桌面里中文可用宿主输入法打好后 Ctrl+Shift+V 粘贴，或启用 fcitx5 在虚拟环境内直接输入。" ""
elif ! ls /usr/lib/*/gtk-3.0/*/immodules/im-fcitx5.so >/dev/null 2>&1; then
  # fcitx5 没有 XIM 前端，缺 GTK 原生模块 = GTK 应用输入直接哑掉
  add desktop warn "中文输入法" "已启用但缺 GTK 输入模块" \
    "没有 fcitx5-frontend-gtk3，lxterminal / Chrome 连不到 fcitx5：终端可能一个中文都打不进。" \
    "点「停止」再「启动」，rime-setup 会按需补装（约 1MB）。"
elif [ "$RUNTIME_UP" = "1" ] && fcitx5-remote >/dev/null 2>&1; then
  add desktop pass "中文输入法" "fcitx5 + Rime（GTK 原生）" \
    "输入法跑在虚拟机内部；面板跟手、横排候选，Ctrl+Space 开关、Shift 中英切换。" ""
else
  add desktop warn "中文输入法" "已启用但 fcitx5 服务未就绪" \
    "fcitx5 没能在会话总线上注册，终端里可能打不出中文。" \
    "点「停止」再「启动」重建会话；反复失败查看 /tmp/fcitx5.log。"
fi
fi # SCOPE=all

# 出口信息：裸 curl 探测（流量自然进 TUN）
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

# 节点延迟：主界面「测延迟」经内核控制 API 实测后落盘，自检只读结果，
# 不在这里重新发起一轮测速（那会让每次检查多等十几秒）。
if [ "$SCOPE" = all ] && [ -f /opt/scripts/node-delay.py ]; then
  _nd_line=$(python3 /opt/scripts/node-delay.py --summary 2>/dev/null)
  if [ -n "$_nd_line" ]; then
    add network pass "节点延迟" "$_nd_line" \
      "经容器内核实测到 gstatic 的往返延迟；「超时」表示该节点当前不可达。" ""
  else
    add network warn "节点延迟" "未测" \
      "还没有节点延迟数据，无法判断当前出口链路快慢。" \
      "启动环境后在主界面点「测延迟」，或等启动后的自动测速完成。"
  fi
fi

# 出口类型：机房 IP 是 Cloudflare 判定自动化的主要依据
HOSTING_RE='Amazon|Google|Microsoft|Cloudflare|Vultr|Constant Company|Choopa|DigitalOcean|Linode|Hetzner|OVH|Contabo|Tencent|Alibaba|Aliyun|Oracle|Akamai|Leaseweb|M247|Hostinger|Scaleway|UpCloud|ColoCrossing|FranTech|BuyVM|Psychz|Quadranet|Cogent|SoftLayer|Rackspace|Kamatera|Ionos|Gcore|Clouvider|DataCamp|Zenlayer|UCloud|Huawei'
if [ -n "$_eorg" ]; then
  if printf '%s' "$_eorg" | grep -qiE "$HOSTING_RE"; then
    add network info "出口网络组织" "$_eorg" \
      "组织名称匹配已知服务商名单；仅凭名称无法确定 IP 的用途或服务商的判定。" ""
  else
    # 名字不在名单里不等于「家庭宽带」：NTT / Cogent 这类骨干与托管商的段，
    # 检测站照样按 IP 段判数据中心（实测 NTT America 就是 +13）。
    # 所以这里只陈述事实，不替对方下结论。
    # 名字不在名单里 ≠ 家庭宽带：NTT / Cogent 这类骨干与托管商的段，检测站照样按 IP 段
    # 判数据中心（实测 AS2914 NTT America 就是 +13 分）。旧版给 pass 是虚假安心。
    add network info "出口网络组织" "$_eorg" \
      "这是 IP 信息服务返回的网络组织名称，无法单独确定出口类型。" ""
  fi
fi

# Legacy JSON fields remain null for older report consumers. We do not infer a
# third-party browser score from undocumented API fields or send a checkcc request.
CC_SERVER=null; CC_BROWSER=null; CC_TOTAL=null

# ------------------------------------------------------------
# 4. 一致性判断
#    只拦「出口落在受限地区」这个真风险。
#    「系统时区与出口国家不同」**不是**风险：台北用户为了加速/隐私挂商业 VPN 出境是日常，
#    风控若按此扣分，会把全球所有挂 VPN 的合法用户一起误杀。检测站实际抓的是被点名的
#    中国时区 / zh-CN / 名单内字体，不是时区与 IP 的地理匹配。
#    旧版这里有个 _expected_cc() 按时区反推期望国家，不匹配就判 fail 并建议改地区，
#    逻辑错误且映射表漏了 Asia/Taipei，导致默认台北画像下整项被静默跳过。1.0.25 删除。
# ------------------------------------------------------------
_region_status=$(python3 /opt/scripts/claude-supported-regions.py "${_ecc:-}" 2>/dev/null || true)
case "$_region_status" in
  supported)
    add consistency pass "出口地区" "${_ecc}" \
      "IP 信息服务报告的地区在本地官方名单快照中，不代表实际所在地或账号资格。" "" ;;
  unsupported)
    add consistency fail "出口地区" "${_ecc}" \
      "IP 信息服务报告的地区不在本地官方名单快照中。" \
      "核对官方支持地区与所选节点。" ;;
  *)
    add consistency warn "出口地区" "无法确认" \
      "没有取得有效地区信息或支持地区名单不可用。" "检查网络后重试。" ;;
esac

if [ -n "$_ecc" ]; then
  add consistency info "时区 ↔ 出口地区" "系统 ${TZ:-未知} / 出口 ${_ecc}" \
    "分别显示系统时区和检测到的出口地区。此项不对两者作风险判断。" ""
fi

# 全量单节点：确认订阅的分流规则已被忽略
if [ "$CORE_UP" = "1" ] && [ -f /opt/config/mihomo.yaml ]; then
  if grep -q 'MATCH,ClaudeVM' /opt/config/mihomo.yaml; then
    add consistency pass "出口规则" "全量单节点 → ${TUN_NODE:-自动}" \
      "配置文件中存在单节点兜底规则；实际出口请结合多源检测结果查看。" ""
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

# ------------------------------------------------------------
# 输出
# ------------------------------------------------------------
emit_text() {
  echo "环境一致性自检 · 目标地区 $REGION_LABEL"
  echo "────────────────────────────────────────────────────────"
  [ "$RUNTIME_UP" -eq 0 ] && echo "⚠ 虚拟环境当前未运行，部分项目无法检测。"
  _last=""
  for _rec in "${ITEMS[@]}"; do
    IFS="$US" read -r _g _st _lb _val _det _adv <<< "$_rec"
    if [ "$_g" != "$_last" ]; then echo; echo "▸ $(gtitle "$_g")"; _last="$_g"; fi
    case "$_st" in
      pass) _i="✔" ;; warn) _i="!" ;; fail) _i="✘" ;; *) _i="·" ;;
    esac
    echo "  $_i $_lb · $_val"
    if [ "$_st" != "pass" ] && [ -n "$_det" ]; then echo "      $_det"; fi
    if [ -n "$_adv" ]; then echo "      → $_adv"; fi
  done
  echo
  echo "────────────────────────────────────────────────────────"
  echo "汇总：通过 $PASS · 注意 $WARN · 失败 $FAIL · 信息 $INFO"
  if [ "$FAIL" -gt 0 ]; then
    echo "结论：存在必修项，修好再登录 Claude。"
  elif [ "$WARN" -gt 0 ]; then
    echo "结论：可正常使用，但有 $WARN 项值得留意。"
  else
    echo "结论：各维度一致，环境状态良好。"
  fi
  echo "说明：本脚本只校对本地环境，不代表 Anthropic 的判定结果。"
}

emit_json() {
  _order=()
  for _rec in "${ITEMS[@]}"; do
    _g="${_rec%%"$US"*}"
    _seen=0
    for _o in ${_order[@]+"${_order[@]}"}; do [ "$_o" = "$_g" ] && _seen=1; done
    [ "$_seen" -eq 0 ] && _order+=("$_g")
  done

  printf '{"version":1,"runtimeUp":%s,"regionLabel":"%s","tz":"%s","lang":"%s",' \
    "$RUNTIME_UP" "$(jesc "$REGION_LABEL")" "$(jesc "${TZ:-}")" "$(jesc "${LANG:-}")"
  # Historical fields retained for older clients; null means unavailable.
  printf '"checkcc":{"total":%s,"serverSide":%s,"browserSide":%s},' \
    "${CC_TOTAL:-0}" "${CC_SERVER:-0}" "${CC_BROWSER:-0}"
  printf '"summary":{"pass":%d,"warn":%d,"fail":%d,"info":%d},"groups":[' \
    "$PASS" "$WARN" "$FAIL" "$INFO"

  _fg=1
  for _g in "${_order[@]}"; do
    [ "$_fg" -eq 1 ] || printf ','
    _fg=0
    printf '{"id":"%s","title":"%s","items":[' "$(jesc "$_g")" "$(jesc "$(gtitle "$_g")")"
    _fi=1
    for _rec in "${ITEMS[@]}"; do
      [ "${_rec%%"$US"*}" = "$_g" ] || continue
      IFS="$US" read -r _gg _st _lb _val _det _adv <<< "$_rec"
      [ "$_fi" -eq 1 ] || printf ','
      _fi=0
      printf '{"label":"%s","status":"%s","value":"%s","detail":"%s","advice":"%s"}' \
        "$(jesc "$_lb")" "$_st" "$(jesc "$_val")" "$(jesc "$_det")" "$(jesc "$_adv")"
    done
    printf ']}'
  done
  printf ']}\n'
}

if [ "$MODE" = "json" ]; then emit_json; else emit_text; fi
