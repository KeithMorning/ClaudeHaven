#!/usr/bin/env bash
N=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz.new137
O=/mnt/e/Web/FuckCladue/build/rootfs-pre-137-backup.tar.gz
echo "=== 文件大小 ==="
ls -lh "$N" "$O"
echo "=== gzip 完整性（无输出=OK）==="
gzip -t "$N" 2>&1 | head -3
echo "=== 条目数 ==="
printf '新: '; tar tzf "$N" 2>/dev/null | wc -l
printf '旧: '; tar tzf "$O" 2>/dev/null | wc -l
echo "=== os-release 类型 ==="
tar tvzf "$N" 2>/dev/null | grep -E 'etc/os-release|usr/lib/os-release' | head -4
