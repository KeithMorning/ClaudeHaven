#!/usr/bin/env bash
# 2.0.1 rootfs 增量重建（在 WSL 内执行）
#
# 为什么不是全量 Dockerfile 重建：这台机器没有 Docker。
# 1.0.37 的 rootfs 里 /opt/scripts 仍是旧脚本（含已删除的 proxy-router.js），
# 而 syncScripts 曾经因 wsl.exe 吞 $ 静默失效 —— 全新安装第一次启动就可能跑旧脚本。
# 本脚本只替换 /opt/scripts 全套为 2.0 唯一真源，桌面/输入法/字体/Chrome/
# Claude Code/mihomo 内核/GeoIP 一个字节都不动。
set -euo pipefail

ROOT=/mnt/e/Web/FuckCladue
ROOTFS="$ROOT/claude-desktop/runtime/rootfs.tar.gz"
NEW="$ROOT/claude-desktop/runtime/rootfs.tar.gz.new2x"
BACKUP="$ROOT/build/rootfs-pre-2x-backup.tar.gz"
WORK=/root/rootfs-rebuild-2x
SRC="$ROOT/claude-vm/vm/scripts"

echo "[0] 前置检查"
for f in "$ROOTFS" "$SRC/entrypoint.sh" "$SRC/tun-merge.py"; do
  [ -f "$f" ] || { echo "缺少 $f"; exit 1; }
done
SRC_COUNT=$(find "$SRC" -maxdepth 1 -type f | wc -l)
# 2.0.3 新增 node-delay.py（23 个）。别再写死数字：新增工具脚本时重建不该被误拒。
[ "$SRC_COUNT" -ge 22 ] || { echo "源码脚本数异常：$SRC_COUNT"; exit 1; }
echo "源码脚本数：$SRC_COUNT"
df -h / | tail -1

echo "[1] 备份当前 rootfs（失败可回退）"
if [ ! -f "$BACKUP" ]; then cp -f "$ROOTFS" "$BACKUP"; fi
ls -lh "$BACKUP"

echo "[2] 解压 rootfs 到 ext4 临时目录"
rm -rf "$WORK"
mkdir -p "$WORK"
tar xzf "$ROOTFS" -C "$WORK"

echo "[3] 清空 /opt/scripts 旧脚本（含 proxy-router.js），全量注入 2.0 真源"
mkdir -p "$WORK/opt/scripts"
find "$WORK/opt/scripts" -maxdepth 1 -type f -delete
for f in "$SRC"/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  case "$b" in
    *.sh) install -m 755 "$f" "$WORK/opt/scripts/$b" ;;
    *)    install -m 644 "$f" "$WORK/opt/scripts/$b" ;;
  esac
done
echo "注入脚本数：$(find "$WORK/opt/scripts" -maxdepth 1 -type f | wc -l)"
[ ! -e "$WORK/opt/scripts/proxy-router.js" ] || { echo "proxy-router.js 未清除"; exit 1; }

echo "[4] 校验注入点（2.0 单态化口径）"
for f in entrypoint.sh net-guard.sh check-env.sh tun-core.sh tun-merge.py \
         chrome-lang.py chrome-login.sh show-welcome.sh node-delay.py; do
  src="$SRC/$f"; dst="$WORK/opt/scripts/$f"
  a=$(md5sum "$src" | cut -d' ' -f1)
  b=$(md5sum "$dst" | cut -d' ' -f1)
  [ "$a" = "$b" ] || { echo "md5 不一致: $f ($a vs $b)"; exit 1; }
  printf '  %-16s %s OK\n' "$f" "${b:0:8}"
done
grep -q 'TUN_NODE' "$WORK/opt/scripts/entrypoint.sh" || { echo "entrypoint 缺 TUN_NODE"; exit 1; }
grep -q 'pgrep -x mihomo' "$WORK/opt/scripts/net-guard.sh" || { echo "net-guard 缺内核探活"; exit 1; }
grep -q 'MATCH,' "$WORK/opt/scripts/tun-merge.py" || { echo "tun-merge 缺全量兜底规则"; exit 1; }
for f in entrypoint.sh net-guard.sh check-env.sh; do
  ! grep -q 'TUN_MODE\|UPSTREAM_PROXY\|no-proxy' "$WORK/opt/scripts/$f" || {
    echo "$f 里仍有 1.0 旧链路"; exit 1; }
done
[ -x "$WORK/usr/local/bin/mihomo" ] || { echo "mihomo 内核丢失"; exit 1; }
[ -f "$WORK/opt/mihomo/geoip.metadb" ] || { echo "GeoIP 数据库丢失"; exit 1; }
"$WORK/usr/local/bin/mihomo" -v 2>/dev/null | head -1 || true

echo "[5] 重新打包（gzip -1，与原包同级别）"
rm -f "$NEW"
tar czf - -C "$WORK" . > "$NEW"
ls -lh "$ROOTFS" "$NEW"

echo "[6] 校验新包 gzip 完整 + 关键条目 + 条目数"
gzip -t "$NEW" || { echo "gzip 校验失败，保留旧包"; exit 1; }
# 条目列表落盘再查：`tar tzf | grep -q` 会让 tar 收到 SIGPIPE；
# 即便先读进变量，`printf | grep -q` 在 pipefail 下同样会因 grep 提前退出而
# 返回非 0，把「匹配到了」误判成「缺少文件」（1.0.37 踩过，2.0.1 又踩一次）。
# 一律用「文件 + grep -Fxq」，没有管道、没有 SIGPIPE。
tar tzf "$NEW" > "$WORK/entries.txt"
tar tzf "$BACKUP" > "$WORK/entries-old.txt"
NEW_COUNT=$(wc -l < "$WORK/entries.txt")
OLD_COUNT=$(wc -l < "$WORK/entries-old.txt")
echo "条目数：旧 $OLD_COUNT → 新 $NEW_COUNT"
for k in ./usr/local/bin/mihomo ./opt/mihomo/geoip.metadb \
         ./opt/scripts/entrypoint.sh ./opt/scripts/tun-merge.py \
         ./opt/scripts/check-env.sh ./opt/scripts/node-delay.py \
         ./opt/scripts/chrome-lang.py ./usr/lib/os-release; do
  grep -Fxq -- "$k" "$WORK/entries.txt" || { echo "新包缺少 $k"; exit 1; }
done
if grep -Fxq -- './opt/scripts/proxy-router.js' "$WORK/entries.txt"; then
  echo "新包仍含 proxy-router.js"; exit 1
fi
echo "关键文件齐全，旧代理脚本已清除"

echo "[7] 从新包逐个校验脚本 md5（防止打包过程改写内容）"
T2=$(mktemp -d)
tar xzf "$NEW" -C "$T2" ./opt/scripts
for f in "$SRC"/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  a=$(md5sum "$f" | cut -d' ' -f1)
  c=$(md5sum "$T2/opt/scripts/$b" | cut -d' ' -f1)
  [ "$a" = "$c" ] || { echo "包内脚本与源码不一致: $b"; exit 1; }
done
rm -rf "$T2"
echo "$SRC_COUNT 个脚本与源码逐字节一致"

echo "[8] 原子替换"
mv -f "$NEW" "$ROOTFS"
rm -rf "$WORK"
echo "DONE rootfs=$(stat -c %s "$ROOTFS") bytes"
