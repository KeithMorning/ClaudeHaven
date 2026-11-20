#!/usr/bin/env bash
# 用真实 Chrome 在容器内完成 claude.ai 登录。
# TUN 全量接管出口：流量在网络层被容器内 mihomo 抓走，浏览器不需要任何
# --proxy-server，也没有 local-proxy 文件可读。

# WSL/容器内以 root 运行时 Chrome 需要 --no-sandbox
SANDBOX_FLAG=""
[ "$(id -u)" = "0" ] && SANDBOX_FLAG="--no-sandbox"

# 浏览器语言唯一真源 = 画像派生、主进程写入 runtime-env 的 CHROME_LANG（坑 25）。
# 老环境可能没有这个变量，才退回从 LANG 推导；新链路不该走到这个兜底。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env
case "${CHROME_LANG:-}" in
  zh-TW|ja-JP|de-DE|en-GB|en-US) : ;;
  *)
    case "${LANG:-en_US.UTF-8}" in
      zh_CN*) CHROME_LANG="zh-CN" ;;
      zh_TW*) CHROME_LANG="zh-TW" ;;
      ja_JP*) CHROME_LANG="ja-JP" ;;
      de_DE*) CHROME_LANG="de-DE" ;;
      en_GB*) CHROME_LANG="en-GB" ;;
      *)      CHROME_LANG="en-US" ;;
    esac ;;
esac

# --lang 只改 Chrome 的 UI 语言，不会重写已有 Profile 的 Accept-Language。
# 每次启动前把语言偏好固定成与画像一致（原子写、幂等）。
if [ -f /opt/scripts/chrome-lang.py ]; then
  python3 /opt/scripts/chrome-lang.py --set >/dev/null 2>&1 || true
fi

# Chrome 的 SingletonLock 记的是「hostname-PID」。1.0.26 起环境身份随机化成
# DESKTOP-XXXXXXX，旧锁仍指向 HomeVisionPC-324 这类已不存在的主机，socket 也早失效；
# Chrome 会据此判定 Profile 正被另一台机器占用，拒绝启动（串流桌面里「Chrome 打不开」）。
# 只在没有活着的 Chrome 进程时清 —— 正常多开仍复用同一实例。
CHROME_PROFILE="${HOME:-/root}/.config/google-chrome"
if [ -d "$CHROME_PROFILE" ] && ! pgrep -f '[g]oogle-chrome-stable' >/dev/null 2>&1; then
  rm -f "$CHROME_PROFILE/SingletonLock" \
        "$CHROME_PROFILE/SingletonCookie" \
        "$CHROME_PROFILE/SingletonSocket" 2>/dev/null || true
fi

# 从桌面打开浏览器时展示常用页面；显式传入的链接用于登录等外部调用。
if [ "$#" -eq 0 ]; then
  set -- https://fuck-claude.vercel.app/
fi

chrome_guest_flags=()
if [ -d /var/lib/haven-data ]; then
  chrome_guest_flags=(--use-gl=angle --use-angle=swiftshader --disk-cache-dir=/tmp/claude-haven-chrome-cache)
fi

exec google-chrome-stable \
  --lang="$CHROME_LANG" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --start-maximized \
  --test-type \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  "${chrome_guest_flags[@]}" \
  $SANDBOX_FLAG \
  "$@"
