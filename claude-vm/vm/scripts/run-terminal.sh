#!/bin/sh
# 工作区终端。GTK/VTE 可用时使用共用标签窗口，保留轻量回退。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env

if python3 -c 'import gi; gi.require_version("Vte", "2.91"); from gi.repository import Vte' >/dev/null 2>&1; then
  exec python3 /opt/scripts/haven-terminal.py --shell
fi

if command -v lxterminal >/dev/null 2>&1; then
  exec lxterminal --no-remote --title="Terminal" --geometry=120x34 \
    -e /opt/scripts/session-shell.sh
fi

# The base image includes xterm even when input method setup was interrupted.
exec xterm -T "Terminal" -geometry 120x34 -e /opt/scripts/session-shell.sh
