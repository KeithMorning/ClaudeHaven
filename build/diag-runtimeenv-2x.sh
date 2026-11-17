#!/usr/bin/env bash
echo "=== /opt/config/runtime-env ==="
cat /opt/config/runtime-env 2>/dev/null || echo "(不存在)"
echo "=== /etc/timezone & localtime ==="
cat /etc/timezone 2>/dev/null; ls -l /etc/localtime 2>/dev/null
