#!/usr/bin/env bash
p=/opt/scripts/check-env.sh
for k in '全量单节点' '2.0 唯一' '选中节点' 'mihomo 未运行' 'Meta 不存在' '内核配置未生成'; do
  printf '  %-18s %s\n' "$k" "$(grep -c "$k" "$p")"
done
echo "  size=$(wc -c < $p)"
echo "  CRLF行数=$(grep -c $'\r' $p)"
