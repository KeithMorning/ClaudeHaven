#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""2.0：entrypoint.sh 单态化 —— 容器内 mihomo/TUN 唯一网络路径 + desktop 唯一显示模式。

只改 claude-vm/vm/scripts/entrypoint.sh。所有替换带唯一性断言。
"""
import sys

P = r'E:\Web\FuckCladue\claude-vm\vm\scripts\entrypoint.sh'
with open(P, 'r', encoding='utf-8', newline='') as f:
    s = f.read()

n = 0


def between(start, end, new, label):
    global s, n
    for marker, name in ((start, '起始'), (end, '结束')):
        c = s.count(marker)
        if c != 1:
            sys.exit(f'[FAIL] {label}: {name}标记出现 {c} 次 (应为 1): {marker[:60]}')
    i, j = s.index(start), s.index(end)
    if j <= i:
        sys.exit(f'[FAIL] {label}: 结束标记在起始之前')
    s = s[:i] + new + s[j:]
    n += 1


def once(old, new, label):
    global s, n
    c = s.count(old)
    if c != 1:
        sys.exit(f'[FAIL] {label}: 出现 {c} 次')
    s = s.replace(old, new, 1)
    n += 1


# 1) 头部注释：WSLg 说明改成历史注记，XDG_RUNTIME_DIR 保留
once(
    "# XDG_RUNTIME_DIR：WSLg 把默认运行时目录建在 /mnt/wslg/runtime-dir 且属主是 uid 1000，\n"
    "# 而本会话以 root 运行 —— 属主不匹配会让 GTK3 应用卡死在初始化（进程活着、窗口永远\n"
    "# 不出现、无任何报错）。lxterminal 起不来、输入法「像坏了一样」都是这个原因。\n"
    "# 换成 root 自己的运行时目录，GTK 应用立刻正常（实测 im-ibus + Rime 直接出「你好」）。",
    "# XDG_RUNTIME_DIR：WSL 的默认运行时目录属主是 uid 1000，而本会话以 root 运行 ——\n"
    "# 属主不匹配会让 GTK3 应用卡死在初始化（进程活着、窗口永远不出现、无任何报错）。\n"
    "# 换成 root 自己的运行时目录，GTK 应用立刻正常。2.0 只走串流桌面，但这条仍必须保留。",
    '头部 XDG 注释')

# 2) 第 2 节：整个旧代理链路 + TUN 开关 → 单态 TUN 无条件启动
between(
    '# 2) 出口链路',
    '# 2.4) 网络熔断',
    r'''# 2) 出口链路（2.0：容器内 mihomo + TUN 是唯一网络路径）
#    宿主 Clash 只是「导入/编辑 YAML」的辅助工具，运行时链路里没有它 ——
#    宿主切 Global 还是 Direct、甚至关掉，都与本环境的出口无关。
#    必须在 net-guard 熔断**之前**启动：内核要在还有默认路由时解析节点域名、
#    预置 GeoIP、补 /32 主机路由；默认路由一删，这些就都做不了了。
#    实测结论见 build/TUN-SPIKE-结果.md（第四轮 tun-builtin-spike.sh 全绿）。
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
  rm -f /opt/config/local-proxy
else
  # 没有配置就不要放行网络：宁可全断，也不能拉起一台「显示就绪、其实裸奔」的环境。
  echo "[claude-vm] 严重：缺少 clash.yaml / tun-core.sh，网络保持全断网（fail-closed）"
  unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy
  rm -f /opt/config/local-proxy
fi

''',
    '出口链路')

# 3) 网络熔断注释改成 TUN 口径
between(
    '# 2.4) 网络熔断',
    "# 2.5) 工作区",
    r'''# 2.4) 网络熔断（fail-closed 底座）
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
  /opt/scripts/net-guard.sh &
  NET_GUARD_PID=$!
  echo "[claude-vm] 网络守卫已启动（pid=$NET_GUARD_PID, mode=$NET_GUARD）"
else
  # 脚本没同步成功时不能假装安全：宁可让检查报告报红，也不要静默裸奔。
  echo "[claude-vm] 严重：net-guard.sh 缺失，网络未受保护！请重新启动以同步脚本"
fi

''',
    '网络熔断注释')

# 4) Chrome DoH 策略：恒开启（TUN 下 DNS 由容器内内核接管）
between(
    '# 2.6) Chrome 策略',
    '# 2.65) 固定 Chrome 的语言偏好',
    r'''# 2.6) Chrome 策略：堵住两条「不走内核」的旁路
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

''',
    'Chrome DoH 策略')

# 5) 显示后端：去掉 wslg 分支与 if 外壳，只留 desktop
between(
    '# 4) 显示后端：两种模式',
    '# 2.45) 中文输入法 —— 刻意放在 DISPLAY_MODE 分支之后',
    r'''# 4) 显示后端（2.0：只有串流桌面一种模式）
#    启动 Xtigervnc（WSL 把 /tmp/.X11-unix 挂成只读，故禁用 unix socket，
#    仅用 TCP 5901）。分辨率只是「初始值」：客户端连上后会用 RFB 的
#    SetDesktopSize 按窗口实际大小重设，所以放大窗口是真正的 1:1 像素。
DISPLAY_MODE=desktop

# 4d) 启动 Xtigervnc
VENV_GEOMETRY="${NOVNC_GEOMETRY:-1600x900}"
mkdir -p ~/.vnc
pkill -x Xtigervnc 2>/dev/null || true
pkill -f "websockify --web" 2>/dev/null || true
sleep 1
rm -f /tmp/.X1-lock 2>/dev/null || true
export DISPLAY=:1
Xtigervnc :1 -geometry "$VENV_GEOMETRY" -depth 24 -rfbport 5901 -localhost \
  -SecurityTypes None -nolisten unix > ~/.vnc/Xtigervnc.log 2>&1 &
sleep 2

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

''',
    '显示后端')

# 6) 输入法段开头注释里的 WSLg 表述
once(
    '# 2.45) 中文输入法 —— 刻意放在 DISPLAY_MODE 分支之后\n'
    '#   （DISPLAY 必须先确定；输入法服务要注册到正确的 X server / 会话总线，\n'
    '#    且早于 runtime-env 写盘 —— 7) 落盘会把 DBUS/GTK_IM_MODULE 传给独立会话。）',
    '# 2.45) 中文输入法 —— 刻意放在 `export DISPLAY=:1` 之后\n'
    '#   （输入法服务要注册到正确的 X server / 会话总线，且早于 runtime-env 写盘。）',
    '输入法段注释')

# 7) runtime-env：删旧代理变量，加 TUN_NODE
between(
    '# 7) 落盘「运行时实际生效的环境」',
    'chmod 644 /opt/config/runtime-env',
    r'''# 7) 落盘「运行时实际生效的环境」，供独立会话读取
#    （检查报告是新开一个 WSL 会话，继承不到本脚本 export 的变量）
{
  echo "export TZ='${TZ:-}'"
  echo "export LANG='${LANG:-}'"
  echo "export LC_ALL='${LC_ALL:-}'"
  echo "export LANGUAGE='${LANGUAGE:-}'"
  echo "export DISPLAY='${DISPLAY}'"
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
''',
    'runtime-env')

# 8) 结尾：就绪标记、wslg 弹终端、双模式日志、wait 注释
between(
    '# 就绪标记：客户端不再只靠 6080 端口判断',
    'wait\n',
    r'''# 就绪标记：客户端主要靠 6080 端口判活，这里再写一份明确信号。
mkdir -p /run/claude-vm
printf '%s\n' "$DISPLAY_MODE" > /run/claude-vm/ready

echo "[claude-vm] 就绪（串流桌面）。noVNC: ${NOVNC_BIND:-127.0.0.1}:${NOVNC_PORT:-6080}"
echo "[claude-vm] 工作区已挂载到 /workspace"
# wait 会一直等到最后一个后台子进程结束；上面显式放了 sleep infinity
# 把会话兜住，否则任一桌面组件退出就会让整个发行版变 Stopped。
wait
''',
    '结尾')

with open(P, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print(f'OK: {n} 处替换，entrypoint.sh 现 {len(s.splitlines())} 行')
