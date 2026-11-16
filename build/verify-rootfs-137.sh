#!/usr/bin/env bash
# 验证新 rootfs 能被 WSL 导入、内核可执行、脚本齐全、check-env 通过。
# 用临时发行版 claude-vm-verify137，测完 unregister，不碰现有 claude-vm。
set -euo pipefail
ROOT=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
D=claude-vm-verify137
WD=/root/verify137-rootfs
cleanup() {
  MSYS_NO_PATHCONV=1 wsl.exe --terminate "$D" >/dev/null 2>&1 || true
  MSYS_NO_PATHCONV=1 wsl.exe --unregister "$D" >/dev/null 2>&1 || true
  rm -rf "$WD"
}
trap cleanup EXIT

echo "=== 导入临时发行版 ==="
MSYS_NO_PATHCONV=1 wsl.exe --import "$D" "$WD" "$ROOT" 2>&1 | tr -d '\000' | tail -3
echo "导入完成"

echo "=== 内核与脚本检查 ==="
MSYS_NO_PATHCONV=1 wsl.exe -d "$D" -u root -- bash -c '
  echo -n "内核: "; /usr/local/bin/mihomo -v 2>/dev/null | head -1
  echo -n "数据库: "; ls -lh /opt/mihomo/geoip.metadb | awk "{print \$5}"
  echo -n "脚本数: "; ls -1 /opt/scripts | wc -l
  echo -n "entrypoint TUN: "; grep -c "tun-core.sh &" /opt/scripts/entrypoint.sh
  echo -n "net-guard TUN: "; grep -c TUN_MODE /opt/scripts/net-guard.sh
  echo -n "node: "; /usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/node -v
  echo -n "chrome: "; ls /opt/google/chrome/chrome >/dev/null 2>&1 && echo OK || echo MISSING
  echo -n "fcitx5: "; command -v fcitx5 || echo MISSING
  echo -n "中文字体: "; fc-list 2>/dev/null | grep -c "Noto Sans CJK SC"
' 2>&1 | tr -d '\000' | tail -12
