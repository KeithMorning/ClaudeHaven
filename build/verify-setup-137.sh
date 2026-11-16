#!/usr/bin/env bash
# 核验 1.0.37 安装包：win-unpacked 里的 asar 版本 / rootfs / 脚本 / TUN 接线
set -u
D=/mnt/e/Web/FuckCladue/claude-desktop/dist/win-unpacked
RES=$D/resources
echo "=== 产物 ==="
ls -lh /mnt/e/Web/FuckCladue/claude-desktop/dist/ClaudeVM-Setup-1.0.37-x64.exe
echo "=== 随包资源 ==="
ls -lh "$RES/app.asar" "$RES/rootfs.tar.gz" 2>/dev/null
echo "=== 随包脚本（打包副本）==="
ls -1 "$RES/scripts" 2>/dev/null | wc -l
for f in entrypoint.sh net-guard.sh tun-core.sh tun-merge.py; do
  printf "  %-16s " "$f"; [ -f "$RES/scripts/$f" ] && echo OK || echo MISSING
done
echo "=== asar 内关键代码（解包到临时目录检查）==="
T=$(mktemp -d)
/mnt/e/Web/FuckCladue/claude-desktop/node_modules/.bin/asar extract "$RES/app.asar" "$T" 2>/dev/null || \
  node /mnt/e/Web/FuckCladue/claude-desktop/node_modules/@electron/asar/bin/asar.js extract "$RES/app.asar" "$T" 2>/dev/null
if [ -f "$T/package.json" ]; then
  echo -n "  app 版本: "; grep -m1 '"version"' "$T/package.json"
  echo -n "  main.js TUN_MODE: "; grep -c TUN_MODE "$T/app/main.js" 2>/dev/null
  echo -n "  tun-config.js: "; [ -f "$T/app/lib/tun-config.js" ] && echo OK || echo MISSING
  echo -n "  界面 TUN 开关: "; grep -c 'id="tunMode"' "$T/app/renderer/index.html" 2>/dev/null
  echo -n "  一键重置: "; grep -c 'id="reset"' "$T/app/renderer/index.html" 2>/dev/null
else
  echo "  asar 解包失败（工具路径问题），下面用 strings 兜底"
  strings "$RES/app.asar" 2>/dev/null | grep -c 'TUN_MODE' | xargs echo "  TUN_MODE 出现次数:"
fi
rm -rf "$T"
echo "=== rootfs 内的内核（从随包 tar 直接查）==="
tar tzf "$RES/rootfs.tar.gz" 2>/dev/null | grep -E '^\./usr/local/bin/mihomo$|^\./opt/mihomo/geoip.metadb$' | sort
