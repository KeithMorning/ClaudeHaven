#!/usr/bin/env bash
# 首次启动的欢迎引导。
# 用 Chrome 的 app 模式打开本地页面 → 无地址栏、无标签页，看起来像系统自带的小应用，
# 而不是一个「远程终端里敲命令」的服务器界面。
# TUN 全量接管出口，浏览器无需 --proxy-server / local-proxy。

SANDBOX_FLAG=""
[ "$(id -u)" = "0" ] && SANDBOX_FLAG="--no-sandbox"

# 以前这里的 --lang 写死成英文：台北画像首次启动时 Chrome 用英文建 Profile，
# 之后即使切了语言也容易残留（坑 25）。改成跟画像的 CHROME_LANG 走。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env
WELCOME_LANG="${CHROME_LANG:-en-US}"

exec google-chrome-stable \
  --app=file:///opt/config/welcome/index.html \
  --window-size=780,570 \
  --window-position=250,140 \
  --lang="$WELCOME_LANG" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --test-type \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  $SANDBOX_FLAG
