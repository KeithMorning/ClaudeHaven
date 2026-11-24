#!/usr/bin/env bash
set -e

# The Mac launcher reads phase milestones from this file during startup.
report_startup() {
  if [ "${HAVEN_STARTUP_PROGRESS:-}" = 1 ]; then
    printf '%s\n' "$1" > /run/claude-vm/startup-stage || true
  fi
}
report_startup network

# WSL 导入后不继承镜像 ENV。Node 和 Claude Code 的入口统一在 /usr/local/bin。
export PATH="/usr/local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  _claude_bin="$(npm prefix -g 2>/dev/null || true)/bin/claude"
  if [ -x "$_claude_bin" ]; then
    ln -sf "$_claude_bin" /usr/local/bin/claude
  fi
fi

# XDG_RUNTIME_DIR：WSL 的默认运行时目录属主是 uid 1000，而本会话以 root 运行 ——
# 属主不匹配会让 GTK3 应用卡死在初始化（进程活着、窗口永远不出现、无任何报错）。
# 换成 root 自己的运行时目录，GTK 应用立刻正常。2.0 只走串流桌面，但这条仍必须保留。
export XDG_RUNTIME_DIR=/tmp/claude-vm-runtime
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
# WSL 可能在启动早期同步宿主时区。设置需要在桌面进程继承 TZ 前完成。
apply_tz() {
  [ -n "${TZ:-}" ] || return 0
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime 2>/dev/null || true
  echo "$TZ" > /etc/timezone 2>/dev/null || true
}

# 1.5) 语言环境
#     镜像里只预生成了 en_US / en_GB / ja_JP / de_DE。台北画像要 zh_TW.UTF-8，
#     不重建 720MB rootfs：开机时用已装的 locales 包现场生成一次即可，之后持久保留。
if [ -n "$LANG" ]; then
  _lwant=$(printf '%s' "${LANG%%.*}" | tr 'A-Z' 'a-z')
  if ! locale -a 2>/dev/null | tr 'A-Z' 'a-z' | grep -q "^${_lwant}"; then
    _lg="${LANG%%.*}.UTF-8"
    sed -i -E "s/^# *(${_lg//./\\.})/\1/" /etc/locale.gen 2>/dev/null || true
    locale-gen >/dev/null 2>&1 || true
    echo "[claude-vm] 已生成 locale: $_lg"
  fi
  export LANG
  export LC_ALL="${LC_ALL:-$LANG}"
  if [ -z "$LANGUAGE" ]; then
    _base="${LANG%%.*}"; _lang="${_base%%_*}"
    export LANGUAGE="${_base}:${_lang}"
  fi
fi

# 2) 出口链路（2.0：容器内 mihomo + TUN 是唯一网络路径）
#    宿主 Clash 只是「导入/编辑 YAML」的辅助工具，运行时链路里没有它 ——
#    宿主切 Global 还是 Direct、甚至关掉，都与本环境的出口无关。
#    必须在 net-guard 熔断**之前**启动：内核要在还有默认路由时解析节点域名、
#    预置 GeoIP、补 /32 主机路由；默认路由一删，这些就都做不了了。
#    路由和 TUN 状态以当前运行时检查结果为准。
if [ -s /opt/config/clash.yaml ] && [ -x /opt/scripts/tun-core.sh ]; then
  /opt/scripts/tun-core.sh &
  TUN_CORE_PID=$!
  echo "[claude-vm] 容器内内核启动中（pid=$TUN_CORE_PID, node=${TUN_NODE:-auto}）"
  # 等「DNS 已切进内核」的显式标记再进入熔断，最多 15 秒。
  # 只看 Meta 网卡不够：网卡先于 resolv.conf 切换出现，那个窗口里
  # getent 仍会问到 WSL 的 DNS 代理（宿主 fake-ip 198.18.x）。
  for _ in $(seq 1 30); do
    [ "$(cat /run/claude-vm/tun-ready 2>/dev/null)" = "ready" ] && break
    sleep 0.5
  done
  if [ "$(cat /run/claude-vm/tun-ready 2>/dev/null)" != "ready" ]; then
    echo "[claude-vm] 严重：TUN 未就绪，net-guard 将保持全断网（fail-closed）"
  fi
  # 应用侧不设任何显式代理：流量由 TUN 在网络层接管。
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
  # 清掉 1.0.x 环境可能残留的旧代理端点文件（只读清理，不写新值）
  rm -f /opt/config/local-proxy
else
  # 没有配置就不要放行网络：宁可全断，也不能拉起一台「显示就绪、其实裸奔」的环境。
  echo "[claude-vm] 严重：缺少 clash.yaml / tun-core.sh，网络保持全断网（fail-closed）"
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
  rm -f /opt/config/local-proxy
fi

# 2.4) 网络熔断（fail-closed 底座）
#
# 容器内内核活着时：TUN 的 table 2022 策略路由把全部流量送进 Meta。
# 内核一挂：TUN 与策略路由一起消失，而 net-guard 又删掉了 main 表默认路由 ——
# 于是没有任何一条路能出去，**立刻全断，不需要任何检测动作**。
# 它放在所有业务（X / 浏览器 / Claude Code）之前，业务一睁眼就已经被锁住。
# 预检也在 net-guard 内部、锁完之后才跑：内核/Meta 网卡存活、出口地区不是
# CN/HK/MO、多源出口一致、直连封锁验证，一律不过就保持封锁并写明原因。
NET_GUARD="${NET_GUARD:-strict}"
export NET_GUARD
if [ -x /opt/scripts/net-guard.sh ]; then
  rm -f /run/claude-vm/net-guard.state /run/claude-vm/session-timezone
  /opt/scripts/net-guard.sh &
  NET_GUARD_PID=$!
  echo "[claude-vm] 网络守卫已启动（pid=$NET_GUARD_PID, mode=$NET_GUARD）"
else
  # 脚本没同步成功时不能假装安全：宁可让检查报告报红，也不要静默裸奔。
  echo "[claude-vm] 严重：net-guard.sh 缺失，网络未受保护！请重新启动以同步脚本"
fi

# 手动设置优先。仅在没有已保存时区时等待本轮守卫预检，不发出额外请求。
valid_timezone() {
  [[ "$1" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] &&
    [ "$(head -c 4 "/usr/share/zoneinfo/$1" 2>/dev/null)" = TZif ]
}
timezone_cache=/opt/config/detected-timezone
mkdir -p /run/claude-vm
timezone_source=manual
if valid_timezone "${HAVEN_TIMEZONE:-}"; then
  TZ="$HAVEN_TIMEZONE"
else
  timezone_source=auto
  TZ="$(cat "$timezone_cache" 2>/dev/null || true)"
  if ! valid_timezone "$TZ"; then
    TZ=''
    guard_state=/run/claude-vm/net-guard.state
    for _ in $(seq 1 60); do
      if [ -s "$guard_state" ]; then
        TZ=$(awk -F= '$0 == "state=guarded" { ok=1 } $1 == "exit_timezone" { zone=$2 } END { if (ok) print zone }' "$guard_state")
        break
      fi
      [ -n "${NET_GUARD_PID:-}" ] && kill -0 "$NET_GUARD_PID" 2>/dev/null || break
      sleep 0.2
    done
    if valid_timezone "$TZ"; then
      printf '%s\n' "$TZ" > "$timezone_cache.tmp"
      mv -f "$timezone_cache.tmp" "$timezone_cache"
    else
      TZ=UTC
      timezone_source=fallback
    fi
  fi
fi
export TZ
apply_tz
(
  for _ in $(seq 1 8); do sleep 1; apply_tz; done
) >/dev/null 2>&1 &
zone_path=$(readlink -f "/usr/share/zoneinfo/$TZ")
printf 'active_timezone=%s\ntimezone_source=%s\n' "${zone_path#/usr/share/zoneinfo/}" "$timezone_source" > /run/claude-vm/session-timezone.tmp
mv -f /run/claude-vm/session-timezone.tmp /run/claude-vm/session-timezone

# 2.5) 工作区：WSL 已 automount Windows 盘符，把宿主工作区软链到 /workspace
if [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE" ] && [ ! -e /workspace ]; then
  ln -sfn "$WORKSPACE" /workspace || true
fi
mkdir -p /workspace

# 2.6) Chrome 策略：堵住两条「不走内核」的旁路
#   · WebRTC 走 UDP，网页能直接读到真实出口 IP
#   · DNS over HTTPS 由容器内内核统一解析，出口地区才与 API 一致
# 2.0 下容器内核恒在，DoH 无条件开启。
CHROME_POLICY_DIR=/etc/opt/chrome/policies/managed
mkdir -p "$CHROME_POLICY_DIR"
cat > "$CHROME_POLICY_DIR/claude-vm.json" <<'JSON'
{
  "WebRtcIPHandling": "disable_non_proxied_udp",
  "DnsOverHttpsMode": "secure",
  "DnsOverHttpsTemplates": "https://cloudflare-dns.com/dns-query"
}
JSON

# 2.65) 固定 Chrome 的语言偏好（坑 25）
#   --lang 只改 UI 语言，管不到已存在 Profile 的 intl.accept_languages / app_locale。
#   更隐蔽的是：只要还有 Chrome 实例活着，chrome-login.sh 的 exec 会把 URL 交给
#   旧实例，新的 --lang 被完全忽略；旧实例退出时还会把内存里的旧语言写回磁盘。
#   结果就是「画像切到美区、报告和磁盘都是 en-US，实际浏览器仍是繁中」。
#   环境启动这一步一律先清残留实例，再按画像 CHROME_LANG 写 Profile。
if pgrep -x chrome >/dev/null 2>&1; then
  pkill -x chrome >/dev/null 2>&1 || true
  sleep 1
fi
if [ -f /opt/scripts/chrome-lang.py ]; then
  python3 /opt/scripts/chrome-lang.py --set >/dev/null 2>&1 || true
fi

# 2.66) 清掉 WSL 从宿主网卡继承来的企业 DNS 后缀
#   /etc/resolv.conf 由 WSL 自动生成，实测带 `search ljstaff.com`。它不会被检测站看到，
#   但会混进诊断包与应用日志，也让自检误报「DNS 被劫持」。
#   刻意**不改 nameserver**：熔断后直连 DNS 本来就不通；走 HTTP 代理的 HTTPS 由 CONNECT
#   在代理侧解析域名，本地 getent 的结果根本不参与（预演已验证 CONNECT 成功、
#   本地给的是 10.36.28.73 内网黑洞且直连不可达）。
mkdir -p /run/claude-vm
_dns_sfx=""
if grep -qE '^(search|domain)[[:space:]]' /etc/resolv.conf 2>/dev/null; then
  _dns_sfx=$(grep -E '^(search|domain)[[:space:]]' /etc/resolv.conf | head -1)
  _dns_tmp=$(mktemp)
  grep -vE '^(search|domain)[[:space:]]' /etc/resolv.conf > "$_dns_tmp" 2>/dev/null
  cat "$_dns_tmp" > /etc/resolv.conf 2>/dev/null || true   # 保留 inode，避免 WSL 重新挂载
  rm -f "$_dns_tmp"
  echo "[claude-vm] 已清除 DNS 后缀: $_dns_sfx"
fi
{
  echo "removed_suffix=${_dns_sfx:-none}"
  echo "nameserver=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)"
  echo "ts=$(date +%s)"
} > /run/claude-vm/dns.state

# 2.67) 首次启动生成主机名和 machine-id，并在此实例中保留。
#   同一基础镜像导入多个实例时，各实例有独立标识。
ID_FILE=/opt/config/identity
if [ ! -s "$ID_FILE" ]; then
  _hn=$(python3 -c 'import secrets; print("host-" + secrets.token_hex(5))')
  _mid=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
  (umask 077; printf 'vm_hostname=%s\nvm_machine_id=%s\ncreated=%s\n' \
    "$_hn" "$_mid" "$(date -u +%FT%TZ)" > "$ID_FILE")
  echo "[claude-vm] 已初始化实例标识"
fi
. "$ID_FILE"
if [ -n "$vm_hostname" ]; then
  hostname "$vm_hostname" 2>/dev/null || true
  echo "$vm_hostname" > /etc/hostname 2>/dev/null || true
fi
if [ -n "$vm_machine_id" ]; then
  echo "$vm_machine_id" > /etc/machine-id 2>/dev/null || true
  echo "$vm_machine_id" > /var/lib/dbus/machine-id 2>/dev/null || true
fi

report_startup fonts

# 2.7) 清掉镜像里残留的「名单内」CJK 字体
#     旧版 rootfs 装了 fonts-noto-cjk（早期为了中文界面），浏览器能枚举到它，
#     体检直接记为「字体地区特征 → 中国」并扣 13 分。
#     判断条件按名字来，不能用 fc-list :lang=zh —— 下面 2.8 装的 Noto Sans SC 也算中文。
if fc-list 2>/dev/null | grep -qE 'Noto Sans CJK|Noto Serif CJK' \
   || dpkg -s fonts-noto-cjk >/dev/null 2>&1; then
  dpkg --purge fonts-noto-cjk >/dev/null 2>&1 || true
  rm -f /usr/share/fonts/opentype/noto/NotoSansCJK*.ttc \
        /usr/share/fonts/opentype/noto/NotoSerifCJK*.ttc 2>/dev/null || true
  fc-cache -f >/dev/null 2>&1 || true
  echo "[claude-vm] 已移除残留的 Noto CJK 字体"
fi

# 2.8) 装「名单外」的中文字体，避免中文页面全是豆腐块
#      全删中文字体确实能让字体指纹归零，但代价是用户打开任何中文站点都是方块字。
#      checkcc 的字体名单是硬编码的 17 个家族名（Noto Sans CJK SC / Source Han Sans SC /
#      WenQuanYi Micro Hei / Microsoft YaHei …），Google Fonts 的 Noto Sans SC 不在其中；
#      实测 canvas 字宽比对对它完全不触发，而中文渲染正常。
# Link the verified asset already in this filesystem instead of keeping another copy.
if [ -f /opt/assets/fonts/NotoSansSC.ttf ] && ! fc-list | grep -q 'Noto Sans SC'; then
  mkdir -p /usr/share/fonts/truetype/claude-sc
  ln -sfn /opt/assets/fonts/NotoSansSC.ttf /usr/share/fonts/truetype/claude-sc/NotoSansSC.ttf
  fc-cache -f >/dev/null 2>&1 || true
  echo "[claude-vm] 已安装 Noto Sans SC（中文渲染，非指纹名单字体）"
fi

# 2.85) 繁体笔形：台北画像下 SC 显示繁体字笔形偏简，补一份 Noto Sans TC。
#       检测站名单里是 `Noto Sans CJK TC` / `PingFang TC` / `Source Han Sans TC`，
#       Google Fonts 的 `Noto Sans TC` 家族名**不在**其中（fc-scan 已验证），不增加扣分。
if [ -f /opt/assets/fonts/NotoSansTC.ttf ] && ! fc-list | grep -q 'Noto Sans TC'; then
  mkdir -p /usr/share/fonts/truetype/claude-tc
  ln -sfn /opt/assets/fonts/NotoSansTC.ttf /usr/share/fonts/truetype/claude-tc/NotoSansTC.ttf
  fc-cache -f >/dev/null 2>&1 || true
  echo "[claude-vm] 已安装 Noto Sans TC（繁体笔形，非指纹名单字体）"
fi

# 3) 桌面外观：壁纸 / 图标 / 面板 / 窗口管理器 / 终端配色
#    这里的原则是「别让它看起来像一台裸服务器」：
#    有壁纸、有 dock、有像样的终端字体，窗口标题不出现 root@host。
mkdir -p ~/.config/openbox ~/.config/tint2 ~/.config/gtk-3.0 \
         ~/.local/share/applications /opt/icons /opt/wall /usr/share/themes

# 让桌面应用通过 xdg-open 打开 URL 时也走同一个 Chrome 启动器。
cat > ~/.local/share/applications/claude-vm-browser.desktop <<'BROWSER_DESKTOP'
[Desktop Entry]
Type=Application
Name=Chrome
Exec=/opt/scripts/chrome-login.sh %U
Terminal=false
Categories=Network;WebBrowser;
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
BROWSER_DESKTOP
if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default claude-vm-browser.desktop x-scheme-handler/http x-scheme-handler/https text/html >/dev/null 2>&1 || true
fi

# 3.1) 启动器：面板上的四个图标 + 桌面右键菜单
cp -f /opt/config/apps/*.desktop ~/.local/share/applications/ 2>/dev/null || true
cp -f /opt/config/apps/*.desktop /usr/share/applications/ 2>/dev/null || true
cp -f /opt/assets/config/apps/*.desktop ~/.local/share/applications/ 2>/dev/null || true
cp -f /opt/assets/config/apps/*.desktop /usr/share/applications/ 2>/dev/null || true
cp -f /opt/config/menu.xml ~/.config/openbox/menu.xml
# 窗口管理器配置优先取随客户端更新的副本（1.0.27 修了标题栏 ✕ 点了没反应），
# 没有才回退镜像内 /opt/config 的旧版 —— 这样不用重建 620MB rootfs 就能让修复生效。
_obrc=/opt/assets/config/openbox-rc.xml
[ -f "$_obrc" ] || _obrc=/opt/config/openbox-rc.xml
cp -f "$_obrc" ~/.config/openbox/rc.xml
_tint2rc=/opt/assets/config/tint2rc
[ -f "$_tint2rc" ] || _tint2rc=/opt/config/tint2rc
cp -f "$_tint2rc" ~/.config/tint2/tint2rc
# 3.0.1) GTK 终端配置（1.0.31）：终端从 xterm 换成 lxterminal，
#   镜像里现成的 lxterminal.conf 与旧 xterm 深色主题是同一套色值，直接沿用。
#   lxterminal 走 GTK3 的 im-ibus.so，中文由 Pango 渲染，双宽字符宽度算得准。
mkdir -p ~/.config/lxterminal
TERMINAL_CONFIG=/opt/assets/config/lxterminal.conf
[ -f "$TERMINAL_CONFIG" ] || TERMINAL_CONFIG=/opt/config/lxterminal.conf
cp -f "$TERMINAL_CONFIG" ~/.config/lxterminal/lxterminal.conf

# 3.1.1) 串流页面：用自带的极简版，去掉 noVNC 那个悬浮控制条
#        优先用 /opt/assets（随客户端版本更新），没有才回退镜像内自带的旧副本
# noVNC 1.7 supports the extended clipboard protocol (UTF-8); the Ubuntu
# bundled version uses the legacy Latin-1 clipboard and corrupts Chinese.
if [ -f /opt/assets/novnc/novnc-1.7.0.tgz ]; then
  tar -xzf /opt/assets/novnc/novnc-1.7.0.tgz -C /usr/share/novnc --strip-components=1 \
    package/core package/vendor 2>/dev/null || { echo '[claude-vm] noVNC 更新失败，已中止启动'; exit 1; }
fi
if [ -f /opt/assets/novnc/desktop.html ]; then
  cp -f /opt/assets/novnc/desktop.html /usr/share/novnc/desktop.html
else
  cp -f /opt/config/novnc/desktop.html /usr/share/novnc/desktop.html 2>/dev/null || true
fi
if [ -f /opt/assets/welcome/index.html ]; then
  mkdir -p /opt/config/welcome && cp -f /opt/assets/welcome/index.html /opt/config/welcome/index.html
fi

# 3.1.1b) 根路径直达定制页
#   websockify 的 --web 目录里没有 index.html 时，访问 http://host:6080/ 得到的是
#   一份目录列表（desktop.html / vnc.html / vnc_lite.html 全列出来），
#   而 noVNC 原版的 vnc.html 界面完全不同 —— 手动打开根路径的人会以为「不是那个页面」。
#   放一个只做跳转的 index.html，让根路径直接进定制页。
cat > /usr/share/novnc/index.html <<'NOVNC_INDEX'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Claude Workspace</title>
<meta http-equiv="refresh" content="0;url=desktop.html?autoconnect=1">
<style>
  html, body { margin: 0; height: 100%; background: #0d1017; color: #8b98ab;
    font: 13px/1.5 "DejaVu Sans", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center; }
</style>
</head>
<body><div>正在连接桌面…</div></body>
</html>
NOVNC_INDEX

# 3.1.2) 窗口主题（旧镜像里没有，运行时补上，省得重建 rootfs）
mkdir -p /usr/share/themes/Claude/openbox-3
_theme=/opt/assets/config/themes/Claude/openbox-3/themerc
[ -f "$_theme" ] || _theme=/opt/config/themes/Claude/openbox-3/themerc
cp -f "$_theme" /usr/share/themes/Claude/openbox-3/themerc 2>/dev/null || true
_theme_dir=/opt/assets/config/themes/Claude/openbox-3
[ -d "$_theme_dir" ] || _theme_dir=/opt/config/themes/Claude/openbox-3
cp -f "$_theme_dir"/*.xbm /usr/share/themes/Claude/openbox-3/ 2>/dev/null || true

# 3.2) 图标与壁纸
node /opt/scripts/gen-art.js icons /opt/icons 64 >/dev/null 2>&1 || true
[ ! -f /opt/assets/icons/chrome.png ] || cp -f /opt/assets/icons/chrome.png /opt/icons/chrome.png
[ ! -f /opt/assets/icons/claude-mascot.png ] || cp -f /opt/assets/icons/claude-mascot.png /opt/icons/claude.png
if ! python3 /opt/scripts/normalize-launcher-icons.py /opt/icons; then
  mkdir -p /opt/icons/launcher
  for icon in chrome claude terminal folder; do
    cp -f "/opt/icons/$icon.png" "/opt/icons/launcher/$icon.png" || true
  done
fi
_wallpaper=/opt/assets/wallpaper/claude-haven.png
[ -f "$_wallpaper" ] || _wallpaper=/opt/wall/source.png
if [ -f "$_wallpaper" ] && ! cmp -s "$_wallpaper" /opt/wall/wall.png; then
  cp -f "$_wallpaper" /opt/wall/wall.png
fi
# 旧版客户端仍用这个标记决定是否重新生成渐变图，保留它以免旧程序覆盖新壁纸。
printf 'graphite-1' > /opt/wall/.theme-version

# 3.3) GTK 深色外观（文件管理器 / 对话框）
cat > ~/.config/gtk-3.0/settings.ini <<'GTK3'
[Settings]
gtk-theme-name=Adwaita-dark
gtk-icon-theme-name=Adwaita
gtk-application-prefer-dark-theme=1
gtk-font-name=DejaVu Sans 10
GTK3
cat > ~/.gtkrc-2.0 <<'GTK2'
gtk-theme-name="Adwaita-dark"
gtk-icon-theme-name="Adwaita"
gtk-font-name="DejaVu Sans 10"
style "default" {
  fg[NORMAL] = "#f3efeb"
  fg[PRELIGHT] = "#ffffff"
  bg[NORMAL] = "#1b1a19"
  bg[PRELIGHT] = "#30251f"
  bg[SELECTED] = "#d47b49"
  base[NORMAL] = "#141414"
  text[NORMAL] = "#f3efeb"
}
class "GtkWidget" style "default"
GTK2
cat > ~/.config/gtk-3.0/gtk.css <<'GTKCSS'
menubar, .menubar { background: #1b1a19; color: #f3efeb; }
menubar > menuitem:hover, .menubar > menuitem:hover { background: #30251f; }
notebook > header { background: #171615; border-bottom: 1px solid #373330; }
notebook > header > tabs > tab { min-height: 32px; padding: 4px 16px; background: #171615; color: #b8ada5; border: 0; }
notebook > header > tabs > tab:checked { background: #27211e; color: #f3efeb; border-bottom: 2px solid #ff914b; }
scrollbar.vertical { min-width: 11px; background: #1e1d1c; border: 0; }
scrollbar.vertical slider { min-width: 6px; margin: 2px; border-radius: 6px; background: #895337; }
scrollbar.vertical slider:hover { background: #c87542; }
GTKCSS

# 3.4) 终端提示符：去掉 user@host（那是最像服务器的记号）
if ! grep -q 'bashrc.extra' ~/.bashrc 2>/dev/null; then
  printf '\n[ -f /opt/scripts/bashrc.extra ] && . /opt/scripts/bashrc.extra\n' >> ~/.bashrc
fi

# 3.9) Claude Code 入口体检 + 自愈
#      正常布局里 bin/claude.exe 是 ~245MB 的原生二进制（对，后缀就是 .exe）；
#      但它的自更新只要中断一次，就会把整包换成「500 字节报错桩 + 残片」，
#      表现为终端里敲 claude 报 command not found 或 Bus error，且没有任何提示。
#      这里两种布局都认，每次启动都验一遍。
_cb_dir="$(ls -d /usr/local/lib/nodejs/*/lib/node_modules/@anthropic-ai/claude-code 2>/dev/null | head -1)"
if [ -n "$_cb_dir" ]; then
  for _cand in "$_cb_dir/bin/claude.exe" \
               "$_cb_dir/node_modules/@anthropic-ai/claude-code-linux-x64/claude"; do
    [ -f "$_cand" ] || continue
    [ -x "$_cand" ] || chmod +x "$_cand" 2>/dev/null || true
    ln -sf "$_cand" /usr/local/bin/claude
    if timeout 20 claude --version >/tmp/claude-ver 2>&1 && grep -qE '^[0-9]+\.[0-9]+' /tmp/claude-ver; then
      echo "[claude-vm] Claude Code $(head -1 /tmp/claude-ver)"
      break
    fi
    echo "[claude-vm] 警告：$(basename "$_cand") 无法运行 —— $(head -1 /tmp/claude-ver)"
  done
fi

report_startup desktop

# 4) 显示后端（2.0：只有串流桌面一种模式）
#    启动 Xtigervnc（WSL 把 /tmp/.X11-unix 挂成只读，故禁用 unix socket，
#    仅用 TCP 5901）。分辨率只是「初始值」：客户端连上后会用 RFB 的
#    SetDesktopSize 按窗口实际大小重设，所以放大窗口是真正的 1:1 像素。
DISPLAY_MODE=desktop

# 4d) 启动 Xtigervnc
VENV_GEOMETRY="${NOVNC_GEOMETRY:-1600x900}"
mkdir -p ~/.vnc
pkill -x Xtigervnc 2>/dev/null || true
pkill -f "websockify --web" 2>/dev/null || true
for _ in $(seq 1 10); do
  pgrep -x Xtigervnc >/dev/null 2>&1 || break
  sleep 0.1
done
rm -f /tmp/.X1-lock 2>/dev/null || true
# The streamed desktop and its clipboard live on X11, even when WSLg is present.
unset WAYLAND_DISPLAY WAYLAND_SOCKET
export GDK_BACKEND=x11
export DISPLAY=:1
Xtigervnc :1 -geometry "$VENV_GEOMETRY" -depth 24 -rfbport 5901 -localhost \
  -SecurityTypes None -nolisten unix -SendPrimary=0 -SetPrimary=0 \
  > ~/.vnc/Xtigervnc.log 2>&1 &
_vnc_pid=$!
if command -v xdpyinfo >/dev/null 2>&1; then
  _display_ready=0
  for _ in $(seq 1 100); do
    if xdpyinfo -display :1 >/dev/null 2>&1; then _display_ready=1; break; fi
    kill -0 "$_vnc_pid" 2>/dev/null || break
    sleep 0.1
  done
  if [ "$_display_ready" != 1 ]; then
    echo "[claude-vm] 虚拟显示未就绪，请查看 ~/.vnc/Xtigervnc.log"
    exit 1
  fi
else
  sleep 2
fi

# TigerVNC uses vncconfig to exchange the X clipboard with connected clients.
if command -v vncconfig >/dev/null 2>&1; then
  vncconfig -nowin >/tmp/claude-vm-vncconfig.log 2>&1 &
fi

# 5) 桌面：壁纸 → 窗口管理器 → 面板
node /opt/scripts/fix-chrome-prefs.js >/dev/null 2>&1 || true
# 覆盖从桌面图标启动的路径；会话被强杀后残留的锁必须由启动段先清掉。
rm -f /root/.config/google-chrome/SingletonLock \
      /root/.config/google-chrome/SingletonCookie \
      /root/.config/google-chrome/SingletonSocket 2>/dev/null || true
node /opt/scripts/seed-claude-state.js >/dev/null 2>&1 || true

if [ -f /opt/wall/wall.png ]; then
  feh --bg-fill /opt/wall/wall.png >/dev/null 2>&1 || true
fi
openbox >/dev/null 2>&1 &
sleep 1
tint2 >/dev/null 2>&1 &

# 5.1) 首次启动：弹出欢迎引导（HTML 应用窗口，不是黑底终端）
if [ ! -f ~/.config/claude-vm-welcomed ]; then
  mkdir -p ~/.config
  touch ~/.config/claude-vm-welcomed
  (
    sleep 2
    /opt/scripts/show-welcome.sh >/dev/null 2>&1 &
  ) &
fi

# 6) 启动 noVNC 网页流服务
#    只绑回环：Windows 侧的 WSL localhost 转发能到达发行版自己的 127.0.0.1。
#    绑 0.0.0.0 的唯一后果是同网段任何人都能打开 6080 直接操作登录态。
websockify --web=/usr/share/novnc "${NOVNC_BIND:-127.0.0.1}:${NOVNC_PORT:-6080}" localhost:5901 &

# 会话兜底 + 桌面自愈：任一组件以非 0 退出，末尾的 wait 就会返回，
# 加上开头的 set -e 会让整个 entrypoint 结束、发行版变 Stopped。
# 放一个永不退出的子进程把 wait 挂住；desktop-guard.sh 负责把崩掉的组件拉回来。
# D-Bus 必须在 guard 之前就位：guard 的输入法探活走 fcitx5-remote，
# 没有它 guard 会把 fcitx5 误判成死掉，4 秒一轮杀掉重拉。
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  if command -v dbus-launch >/dev/null 2>&1; then
    eval "$(dbus-launch --sh-syntax)" 2>/dev/null || true
  fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && command -v dbus-daemon >/dev/null 2>&1; then
    _bus_sock=/tmp/claude-vm-dbus.sock
    rm -f "$_bus_sock"
    DBUS_SESSION_BUS_ADDRESS="unix:path=$_bus_sock"
    dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork \
      >/tmp/dbus-session.log 2>&1 || true
  fi
  export DBUS_SESSION_BUS_ADDRESS
fi

sleep infinity &
nohup /opt/scripts/desktop-guard.sh >/tmp/desktop-guard.log 2>&1 &

# 2.45) 中文输入法 —— 刻意放在 `export DISPLAY=:1` 之后
#   （输入法服务要注册到正确的 X server / 会话总线，且早于 runtime-env 写盘。）
# 2.45) 中文输入法（可选）：fcitx5 + Rime 万象拼音（1.0.34 起）
#   WSLg 不转发 Windows IME 的 preedit 组合串，但按键本身是转发的 ——
#   所以输入法跑在虚拟机内部，组合与提交都在 Linux 侧完成。
#   壳是 fcitx5（面板跟手、横排候选、字体正常），引擎是 Rime。
#   历史：1.0.31~1.0.33 用 IBus，输入能进了，但 IBus 面板在 VNC 里
#   候选窗不跟光标、竖排老样式、豆腐块 —— 面板天花板，换 fcitx5 根治。
#   fcitx5 依赖 D-Bus 会话总线（ibus 可以 autolaunch，fcitx5-remote 直接报错），
#   所以这里显式起一个 session bus 并写进 runtime-env。
#   daemon 必须挂在本会话下：拉起它的 wsl.exe 一旦退出，输入法服务跟着消失。
report_startup input

INPUT_METHOD="${INPUT_METHOD:-off}"
if [ "$INPUT_METHOD" = "rime" ]; then
  if [ "${HAVEN_PREINSTALLED_INPUT:-0}" != 1 ]; then
    /opt/scripts/rime-setup.sh || echo "[claude-vm] 输入法安装失败，本次不启用"
  fi
  if command -v fcitx5 >/dev/null 2>&1; then
    pkill -x fcitx5 2>/dev/null || true
    # D-Bus 会话总线：fcitx5 的前端/面板/探活全走它，没有它 fcitx5 直接起不来
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
      if command -v dbus-launch >/dev/null 2>&1; then
        eval "$(dbus-launch --sh-syntax)" 2>/dev/null || true
      fi
      if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && command -v dbus-daemon >/dev/null 2>&1; then
        _bus_sock=/tmp/claude-vm-dbus.sock
        rm -f "$_bus_sock"
        DBUS_SESSION_BUS_ADDRESS="unix:path=$_bus_sock"
        dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork \
          >/tmp/dbus-session.log 2>&1 || true
      fi
      export DBUS_SESSION_BUS_ADDRESS
    fi
    export XMODIFIERS="@im=fcitx"
    export GTK_IM_MODULE="fcitx"
    export QT_IM_MODULE="fcitx"
    # 开头是 set -e，daemon 启动失败不能带走整个 entrypoint（否则整台桌面消失）
    fcitx5 -d --replace >/tmp/fcitx5.log 2>&1 || true
    _im_ok=0
    for _ in $(seq 1 12); do
      if fcitx5-remote >/dev/null 2>&1; then _im_ok=1; break; fi
      sleep 0.5
    done
    if [ "$_im_ok" = "1" ]; then
      # 起来 ≠ 可用：fcitx5 默认处于「关闭」态（按键直接透传成 ASCII）。
      # 实测 -s rime 切引擎这步才会真正激活（-o 单独用只到 inactive），
      # 两个都发并留一次重试，保证用户开机打字就是中文态。
      fcitx5-remote -s rime >/dev/null 2>&1 || true
      fcitx5-remote -o >/dev/null 2>&1 || true
      sleep 1
      fcitx5-remote -o >/dev/null 2>&1 || true
      echo "[claude-vm] 输入法已启用：fcitx5 + Rime 万象拼音（Shift 中英，Win+Space / Ctrl+Space 开关）"
    else
      echo "[claude-vm] fcitx5 未能就绪，中文输入可能不可用（详见 /tmp/fcitx5.log）"
    fi
  fi
fi

# 7) 落盘「运行时实际生效的环境」，供独立会话读取
#    （检查报告是新开一个 WSL 会话，继承不到本脚本 export 的变量）
{
  echo "export TZ='${TZ:-}'"
  echo "export LANG='${LANG:-}'"
  echo "export LC_ALL='${LC_ALL:-}'"
  echo "export LANGUAGE='${LANGUAGE:-}'"
  # 画像派生的浏览器语言：chrome-login.sh / chrome-lang.py / 自检都读它
  echo "export CHROME_LANG='${CHROME_LANG:-}'"
  echo "export DISPLAY='${DISPLAY}'"
  echo 'unset WAYLAND_DISPLAY WAYLAND_SOCKET'
  echo 'export GDK_BACKEND=x11'
  echo "export BROWSER='/opt/scripts/chrome-login.sh'"
  echo "export XDG_RUNTIME_DIR='${XDG_RUNTIME_DIR:-}'"
  echo "export DBUS_SESSION_BUS_ADDRESS='${DBUS_SESSION_BUS_ADDRESS:-}'"
  echo "export DISPLAY_MODE='${DISPLAY_MODE}'"
  # 2.0：出口由容器内内核 + 选中节点决定，不再有任何显式代理地址
  echo "export TUN_NODE='${TUN_NODE:-}'"
  echo "export NET_GUARD='${NET_GUARD:-strict}'"
  echo "export NET_GUARD_STRICT_REGION='${NET_GUARD_STRICT_REGION:-1}'"
  echo "export INPUT_METHOD='${INPUT_METHOD:-off}'"
  echo "export XMODIFIERS='${XMODIFIERS:-}'"
  echo "export GTK_IM_MODULE='${GTK_IM_MODULE:-}'"
  echo "export QT_IM_MODULE='${QT_IM_MODULE:-}'"
  # 关掉 Claude Code 的自动更新：它是在原地覆盖自己的包，网络一断就会留下
  # 「报错桩 + 残片」，整个 CLI 直接废掉，而且没有任何提示。版本随镜像走更稳。
  echo "export DISABLE_AUTOUPDATER='1'"
} > /opt/config/runtime-env
chmod 644 /opt/config/runtime-env

# 就绪标记：客户端主要靠 6080 端口判活，这里再写一份明确信号。
mkdir -p /run/claude-vm
printf '%s\n' "$DISPLAY_MODE" > /run/claude-vm/ready

# On the native Mac VM, read Chrome's startup files out of SquashFS into
# the guest's page cache. Do this once in the background at low CPU priority.
# The cache is reclaimable and warming it does not open Chrome or its profile.
if mountpoint -q /var/lib/haven-data && [ -r /opt/google/chrome/chrome ]; then
  (
    cd /opt/google/chrome || exit 0
    shopt -s nullglob
    exec nice -n 15 cat -- chrome *.pak icudtl.dat *snapshot*.bin \
      libEGL.so libGLESv2.so libvk_swiftshader.so
  ) >/dev/null 2>&1 &
fi

echo "[claude-vm] 就绪（串流桌面）。noVNC: ${NOVNC_BIND:-127.0.0.1}:${NOVNC_PORT:-6080}"
echo "[claude-vm] 工作区已挂载到 /workspace"
# wait 会一直等到最后一个后台子进程结束；上面显式放了 sleep infinity
# 把会话兜住，否则任一桌面组件退出就会让整个发行版变 Stopped。
wait
wait
