#!/usr/bin/env bash
echo "=== /opt/scripts 文件时间（判断最后一次同步）==="
ls -l --time-style=long-iso /opt/scripts/ | head -28
echo "=== /opt/assets 关键文件时间 ==="
ls -l --time-style=long-iso /opt/assets/ 2>/dev/null | head -12
echo "=== clash.yaml 头几行（确认是不是 2.0 注入的）==="
head -5 /opt/config/clash.yaml 2>/dev/null
echo "=== 残留旧脚本 ==="
ls /opt/scripts/ | grep -E 'proxy-router|local-proxy' || echo "  无"
