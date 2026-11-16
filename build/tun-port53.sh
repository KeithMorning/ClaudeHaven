#!/usr/bin/env bash
echo "=== 53 端口占用（TCP/UDP）==="
ss -lntup 2>/dev/null | head -25 || echo "(ss 不可用)"
echo "=== /proc/net/udp 里的 :53 (0035) ==="
grep -iE ":0035 " /proc/net/udp /proc/net/udp6 2>/dev/null | head -10 || echo "(无 UDP 53 监听)"
echo "=== 相关进程 ==="
pgrep -af "systemd-resolved|dnsmasq|named|coredns|mihomo|clash" || echo "(无)"
echo "=== resolv.conf ==="
cat /etc/resolv.conf
echo "=== 路由基线 ==="
cat /proc/net/route
echo "=== 监听 53 的 inode 归属（若 ss 有）==="
ss -lntp 2>/dev/null | grep ':53 ' || echo "(无 TCP 53)"
