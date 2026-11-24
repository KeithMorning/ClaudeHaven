#!/bin/sh
# 菜单：在工作区打开 Claude Haven 文件管理器。
[ -f /opt/config/runtime-env ] && . /opt/config/runtime-env
exec python3 /opt/scripts/haven-files.py /workspace
