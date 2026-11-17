#!/usr/bin/env bash
echo "=== WSL 能否读到带空格的安装路径 ==="
P='/mnt/c/Users/KeithXi/AppData/Local/Programs/Claude VM/resources/scripts'
if [ -d "$P" ]; then
  echo "目录存在，文件数=$(ls -1 "$P" | wc -l)"
  ls -1 "$P" | head -5
else
  echo ">>> 目录不存在或不可达 <<<"
fi
echo "=== 模拟 syncScripts 的 for 循环（只统计，不复制）==="
N=0
for f in '/mnt/c/Users/KeithXi/AppData/Local/Programs/Claude VM/resources/scripts'/*; do
  [ -f "$f" ] && N=$((N+1))
done
echo "glob 匹配到 $N 个文件"
echo "=== 实际挂载情况 ==="
ls -ld /mnt/c 2>/dev/null
echo "=== 系统内 TZ / locale 来源（解释报告纽约）==="
grep -rn "TZ=" /etc/profile /etc/environment /root/.bashrc /etc/profile.d/ 2>/dev/null | head -10
cat /run/claude-vm/runtime-env 2>/dev/null | head -12
