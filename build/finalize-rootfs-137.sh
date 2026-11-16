#!/usr/bin/env bash
# 只做校验 + 原子替换：新包已由 rebuild-rootfs-137.sh 完整生成
set -euo pipefail
NEW=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz.new137
ROOTFS=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
BACKUP=/mnt/e/Web/FuckCladue/build/rootfs-pre-137-backup.tar.gz

echo "=== 1. gzip 完整性 ==="
gzip -t "$NEW" || { echo "gzip 校验失败，保留旧包"; exit 1; }
echo OK

echo "=== 2. 条目数（新应比旧多）==="
# WSL 会把 "localhost proxy configuration was detected ..." 警告混进 stdout，
# 必须丢掉 stderr，否则精确匹配会被那一行干扰。
NEW_COUNT=$(tar tzf "$NEW" 2>/dev/null | wc -l)
OLD_COUNT=$(tar tzf "$BACKUP" 2>/dev/null | wc -l)
echo "旧=$OLD_COUNT 新=$NEW_COUNT"
[ "$NEW_COUNT" -gt "$OLD_COUNT" ] || { echo "条目数没增加"; exit 1; }

echo "=== 3. 关键文件（先整表再比对，避免 SIGPIPE）==="
# 用 case 在整串里做精确行匹配：不启子进程、不建管道，彻底避开 SIGPIPE / pipefail。
ENTRIES="$(tar tzf "$NEW" 2>/dev/null)"
NL='
'
for k in ./usr/local/bin/mihomo ./opt/mihomo/geoip.metadb \
         ./opt/scripts/tun-core.sh ./opt/scripts/tun-merge.py \
         ./opt/scripts/entrypoint.sh ./opt/scripts/net-guard.sh \
         ./usr/lib/os-release; do
  case "$NL$ENTRIES$NL" in
    *"$NL$k$NL"*) echo "  OK $k" ;;
    *) echo "缺少 $k"; exit 1 ;;
  esac
done

echo "=== 4. 原子替换 ==="
mv -f "$NEW" "$ROOTFS"
rm -rf /root/rootfs-rebuild-137
echo "DONE $(stat -c %s "$ROOTFS") bytes  mtime=$(stat -c %y "$ROOTFS")"
