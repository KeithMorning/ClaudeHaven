#!/usr/bin/env bash
NEW=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz.new137
[ -f "$NEW" ] || NEW=/mnt/e/Web/FuckCladue/claude-desktop/runtime/rootfs.tar.gz
ENTRIES="$(tar tzf "$NEW" 2>/dev/null)"
echo "变量行数: $(printf '%s\n' "$ENTRIES" | wc -l)"
printf '%s\n' "$ENTRIES" | grep -i 'bin/mihomo' | cat -A | head -3
echo "--- grep -F 测试 ---"
printf '%s\n' "$ENTRIES" | grep -Fxq './usr/local/bin/mihomo' && echo "精确匹配 OK" || echo "精确匹配 FAIL"
printf '%s\n' "$ENTRIES" | grep -Fq 'usr/local/bin/mihomo' && echo "子串匹配 OK" || echo "子串匹配 FAIL"
echo "--- 逐个 cat -A ---"
printf '%s\n' "$ENTRIES" | grep -i 'mihomo' | while IFS= read -r line; do printf 'len=%s [' "${#line}"; printf '%s' "$line" | cat -A; echo ']'; done
