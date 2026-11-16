#!/usr/bin/env bash
# 1.0.37 rootfs 增量重建（Windows 宿主 / WSL 里运行，本脚本在 WSL 内执行）
#
# 为什么不用 Dockerfile 全量重建：这台机器既没有 Docker Desktop 也没有 docker CLI。
# 增量只往 1.0.36 已验证过的 rootfs 里加「容器内 mihomo 内核 + GeoIP 数据库 +
# 1.0.37 新脚本」，桌面/输入法/字体/Chrome/Claude Code 一个字都不动，风险更低。
# 新脚本同时写进 rootfs，保证全新安装第一次启动（syncScripts 之前）也是新版。
set -euo pipefail

ROOT=/mnt/e/Web/FuckCladue
ROOTFS="$ROOT/claude-desktop/runtime/rootfs.tar.gz"
NEW="$ROOT/claude-desktop/runtime/rootfs.tar.gz.new137"
BACKUP="$ROOT/build/rootfs-pre-137-backup.tar.gz"
WORK=/root/rootfs-rebuild-137
SCRIPTS_SRC="$ROOT/claude-vm/vm/scripts"
CORE_SRC=/usr/local/bin/mihomo
META_SRC=/opt/mihomo/geoip.metadb

echo "[0] 前置检查"
for f in "$ROOTFS" "$CORE_SRC" "$META_SRC"; do
  [ -f "$f" ] || { echo "缺少 $f"; exit 1; }
done
[ "$(stat -c %s "$CORE_SRC")" -gt 50000000 ] || { echo "内核二进制异常"; exit 1; }
df -h / | tail -1

echo "[1] 备份当前 rootfs（失败可回退）"
if [ ! -f "$BACKUP" ]; then
  cp -f "$ROOTFS" "$BACKUP"
fi
ls -lh "$BACKUP"

echo "[2] 解压 rootfs 到 ext4 临时目录"
rm -rf "$WORK"
mkdir -p "$WORK"
tar xzf "$ROOTFS" -C "$WORK"
echo "解压完成：$(ls "$WORK" | tr '\n' ' ')"

echo "[3] 注入容器内内核与 GeoIP 数据库"
mkdir -p "$WORK/usr/local/bin" "$WORK/opt/mihomo" "$WORK/opt/scripts"
install -m 755 "$CORE_SRC" "$WORK/usr/local/bin/mihomo"
install -m 644 "$META_SRC" "$WORK/opt/mihomo/geoip.metadb"
if [ -f /opt/mihomo/geosite.dat ]; then
  install -m 644 /opt/mihomo/geosite.dat "$WORK/opt/mihomo/geosite.dat"
  echo "geosite.dat 已注入"
else
  echo "geosite.dat 缺失（可选，用户 YAML 自带规则时不依赖）"
fi
ls -lh "$WORK/usr/local/bin/mihomo" "$WORK/opt/mihomo/"

echo "[4] 注入 1.0.37 全部运行时脚本（含 tun-core / tun-merge）"
for f in "$SCRIPTS_SRC"/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  case "$b" in
    *.sh) install -m 755 "$f" "$WORK/opt/scripts/$b" ;;
    *)    install -m 644 "$f" "$WORK/opt/scripts/$b" ;;
  esac
done
echo "脚本数：$(ls -1 "$WORK/opt/scripts" | wc -l)"
ls -l "$WORK/opt/scripts/tun-core.sh" "$WORK/opt/scripts/tun-merge.py" \
      "$WORK/opt/scripts/entrypoint.sh" "$WORK/opt/scripts/net-guard.sh"

echo "[5] 校验关键注入点"
grep -q 'tun-core.sh &' "$WORK/opt/scripts/entrypoint.sh" || { echo "entrypoint 未含 TUN 分支"; exit 1; }
grep -q 'TUN_MODE' "$WORK/opt/scripts/net-guard.sh" || { echo "net-guard 未含 TUN 分支"; exit 1; }
"$WORK/usr/local/bin/mihomo" -v | head -1

echo "[6] 重新打包 rootfs.tar.gz（gzip -1，与原包同级别）"
rm -f "$NEW"
tar czf - -C "$WORK" . > "$NEW"
ls -lh "$ROOTFS" "$NEW"

echo "[7] 校验新包 gzip 完整 + 关键文件 + 条目数"
gzip -t "$NEW" || { echo "gzip 校验失败，保留旧包"; exit 1; }
NEW_COUNT=$(tar tzf "$NEW" | wc -l)
OLD_COUNT=$(tar tzf "$BACKUP" | wc -l)
echo "条目数：旧 $OLD_COUNT → 新 $NEW_COUNT"
[ "$NEW_COUNT" -gt "$OLD_COUNT" ] || { echo "条目数没增加，异常"; exit 1; }
# 先把条目列表整个读进变量再比对：直接 `tar tzf | grep -q` 会让 tar 收到
# SIGPIPE 返回非 0，在 set -e 下被误判成「缺少文件」（连续踩了两次，别再犯）。
ENTRIES="$(tar tzf "$NEW")"
for k in ./usr/local/bin/mihomo ./opt/mihomo/geoip.metadb \
         ./opt/scripts/tun-core.sh ./opt/scripts/tun-merge.py \
         ./opt/scripts/entrypoint.sh ./usr/lib/os-release; do
  printf '%s\n' "$ENTRIES" | grep -qx "$k" || { echo "新包缺少 $k"; exit 1; }
done
echo "关键文件齐全"

echo "[8] 原子替换"
mv -f "$NEW" "$ROOTFS"
rm -rf "$WORK"
echo "DONE rootfs=$(stat -c %s "$ROOTFS") bytes"
