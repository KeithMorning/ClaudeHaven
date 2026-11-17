#!/usr/bin/env bash
# 只读：列出 rootfs 内 /opt/scripts、/opt/config 的条目，供重建前比对
set -u
R=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
echo "=== rootfs 大小 ==="
ls -lh "$R"
echo "=== /opt/scripts 条目 ==="
tar tzf "$R" 2>/dev/null | grep '^./opt/scripts/' | sed 's#^./opt/scripts/##' | sort
echo "=== /opt/config 条目 ==="
tar tzf "$R" 2>/dev/null | grep '^./opt/config/' | sed 's#^./opt/config/##' | sort | head -30
echo "=== 内核与 GeoIP ==="
tar tzf "$R" 2>/dev/null | grep -E 'mihomo|geoip|geosite' | head -10
echo "=== 磁盘空间 ==="
df -h / | tail -1
