#!/bin/bash
# 在图形终端里启动 Claude Code。
# 关键：把 entrypoint 落盘的运行时环境（时区/语言/桌面会话）读进来。
# TUN 全量接管出口，Claude Code 无需任何代理环境变量即可出网。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env 2>/dev/null
export PATH="/usr/local/bin:$PATH"
export TERM=xterm-256color
export BROWSER=/opt/scripts/chrome-login.sh
cd /workspace 2>/dev/null || cd ~
# The native Mac runtime installs this link when it syncs the guest scripts.
if [[ -x /usr/local/bin/mac && /usr/local/bin/mac -ef /opt/scripts/host-npm.py ]]; then
  exec /usr/local/bin/mac claude
fi
exec claude
