#!/usr/bin/env bash
# 只读验证 + 幂等覆盖：把修复后的脚本同步进当前发行版，然后完整跑一遍
# tun-merge.py，检查生成的 mihomo.yaml 是否含选中节点与规则。
# 不启动 mihomo、不改路由（启动会动网络，交给用户点「停止→启动」）。
set -u
ROOT=/mnt/e/Web/FuckCladue
SRC="$ROOT/claude-vm/vm/scripts"
NODE=LAX-Cogent-Reality

echo "[1] 同步修复后的脚本到 /opt/scripts"
for f in "$SRC"/*; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  cp -f "$f" "/opt/scripts/.$b.tmp" && mv -f "/opt/scripts/.$b.tmp" "/opt/scripts/$b"
done
chmod +x /opt/scripts/*.sh
echo "  tun-merge.py md5=$(md5sum /opt/scripts/tun-merge.py | cut -c1-8)"
echo "  net-guard.sh 垃圾行=$(grep -c '^[A-Z_][A-Z0-9_]*=#' /opt/scripts/net-guard.sh || true)"

echo "[2] 完整跑 tun-merge.py（输出到临时文件，不覆盖 /opt/config/mihomo.yaml）"
OUT=/tmp/mihomo-verify-2x.yaml
rm -f "$OUT"
python3 /opt/scripts/tun-merge.py /opt/config/clash.yaml "$OUT" "$NODE" > /tmp/merge-out-2x.json 2>/tmp/merge-err-2x.txt
RC=$?
echo "  exit=$RC"
echo "  stderr: $(cat /tmp/merge-err-2x.txt | head -3)"
if [ "$RC" -ne 0 ]; then echo "FAIL merge 失败"; exit 1; fi

echo "[3] 校验生成的配置"
head -3 /tmp/merge-out-2x.json
for k in 'mode: rule' 'name: ClaudeVM' 'type: select' 'MATCH,ClaudeVM' \
         "name: $NODE" 'interface-name' 'fake-ip-range: 198.19.0.1/16' \
         'nameserver 127.0.0.1'; do
  grep -Fq -- "$k" "$OUT" && echo "  OK   $k" || echo "  MISS $k"
done
echo "  生成配置字节数: $(wc -c < "$OUT")"
echo "[4] 确认订阅原有分流已被剥离"
grep -c 'proxy-groups:' "$OUT" | xargs echo "  proxy-groups 段数(应为1):"
grep -c 'MATCH,DIRECT\|MATCH,pacProxy' "$OUT" | xargs echo "  订阅原 MATCH 规则残留(应为0):"
