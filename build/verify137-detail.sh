#!/usr/bin/env bash
echo "=== GeoIP 数据库 ==="
ls -lh /opt/mihomo/geoip.metadb
echo "=== claude 二进制（entrypoint 启动时软链，镜像里在 node 目录）==="
ls -lh /usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/claude 2>/dev/null || echo "(node bin 无 claude)"
ls -lh /usr/local/lib/nodejs/node-v20.18.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code/bin/ 2>/dev/null | head -5
echo "=== 按需安装项（rime-setup 首次启动装，镜像里没有是正常的）==="
for c in fcitx5 fcitx5-remote lxterminal; do printf "%-16s " "$c"; command -v "$c" || echo "(按需装)"; done
echo "=== 字体（HanaMin 按需装，镜像里预置的是 Fira/DejaVu）==="
fc-list 2>/dev/null | grep -ciE 'Fira|DejaVu' | xargs echo "预置拉丁字体数:"
echo "=== 启动器脚本检查 ==="
grep -n 'ln -sf.*claude' /opt/scripts/entrypoint.sh | head -3
echo "=== /etc/wsl.conf ==="
cat /etc/wsl.conf
