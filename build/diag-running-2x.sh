#!/usr/bin/env bash
# 只读诊断：确认 claude-vm 发行版内实际跑的脚本版本与网络状态
echo "=== /opt/scripts 版本特征（old=1.0措辞 / new=2.0措辞）==="
for f in entrypoint.sh net-guard.sh check-env.sh tun-core.sh tun-merge.py; do
  p=/opt/scripts/$f
  if [ -f "$p" ]; then
    printf '%-16s md5=%s old=%s new=%s\n' "$f" "$(md5sum "$p" | cut -c1-8)" \
      "$(grep -cE '未配置代理|no-proxy|填好代理' "$p" 2>/dev/null)" \
      "$(grep -cE 'mihomo|TUN_NODE|Meta:' "$p" 2>/dev/null)"
  else
    printf '%-16s MISSING\n' "$f"
  fi
done
echo "=== /run/claude-vm/net-guard.state ==="
cat /run/claude-vm/net-guard.state 2>/dev/null | head -14 || echo "(不存在)"
echo "=== mihomo 进程 ==="
pgrep -a -x mihomo || echo "mihomo 未运行"
echo "=== Meta 网卡 ==="
grep -E '^ *Meta:' /proc/net/dev || echo "Meta 不存在"
echo "=== 配置文件 ==="
ls -l /opt/config/clash.yaml /opt/config/mihomo.yaml 2>&1
echo "=== tun-core.log 末尾 ==="
tail -20 /run/claude-vm/tun-core.log 2>/dev/null || echo "(无日志)"
echo "=== 当前 TUN_NODE 环境 ==="
tr '\0' '\n' < /proc/1/environ 2>/dev/null | grep -E 'TUN_NODE|PROXY_MODE|UPSTREAM' || echo "(读不到)"
