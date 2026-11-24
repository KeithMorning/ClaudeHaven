#!/bin/sh
# 工作区中的 Claude Code。与终端共用 GTK/VTE 标签窗口。
# 新 WSL 会话需先读回桌面环境变量，才能连接当前显示与输入法。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env

if python3 -c 'import gi; gi.require_version("Vte", "2.91"); from gi.repository import Vte' >/dev/null 2>&1; then
  exec python3 /opt/scripts/haven-terminal.py --claude
fi

if command -v lxterminal >/dev/null 2>&1; then
  exec lxterminal --no-remote --title="Claude Code" --geometry=112x32 \
    -e /opt/scripts/session-claude.sh
fi

# The base image includes xterm even when input method setup was interrupted.
exec xterm -T "Claude Code" -geometry 112x32 -e /opt/scripts/session-claude.sh
