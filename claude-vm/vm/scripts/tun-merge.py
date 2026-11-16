#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把用户导入的 Clash/Mihomo YAML 合并成「容器内内核 + TUN」配置。

设计前提（2026-11-16 spike 实测结论）：
  · 容器内 mihomo 自己是出口的唯一决策者，宿主 Clash 只是配置来源 / 辅助编辑工具。
  · net-guard 仍然删掉 main 表默认路由，作为 fail-closed 底座：
    mihomo 活着时 table 2022 策略路由把流量送进 TUN；内核一挂，table 2022
    随 TUN 消失、main 表又没有默认路由 -> 立刻全断，不需要任何检测动作。
  · 因此在删默认路由**之前**，必须先给「上游节点 IP / DNS 服务器 IP」补 /32
    主机路由，否则 mihomo 自己也连不出去。

用法：tun-merge.py <clash.yaml> <output.yaml>
输出：合并后的 mihomo 配置；同时在 stdout 打印一行 JSON 供 tun-core.sh 读取。
"""

import importlib.util
import json
import os
import re
import socket
import subprocess
import sys

NG = '/opt/scripts/net-guard.py'
MANAGED = {
    'tun', 'dns', 'ipv6', 'mode', 'log-level',
    'external-controller', 'external-ui', 'secret',
}
DNS_SERVERS = ['223.5.5.5', '1.1.1.1']
FAKE_IP_RANGE = '198.19.0.1/16'


def load_net_guard():
    """复用项目里已经写好的 AF_NETLINK 加路由实现，不引入 iproute2 依赖。"""
    spec = importlib.util.spec_from_file_location('net_guard', NG)
    if not spec or not spec.loader:
        return None
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:
        return None
    return mod


def strip_managed(lines):
    """按顶层键做行级剥离：保留用户自己的 proxies / proxy-groups / rules 原样。

    零依赖，不解析 YAML。Clash 配置的顶层键都是顶格 `key:`，子项带缩进，
    所以一个状态机就够；遇到新的顶格键自动结束上一段的跳过状态。
    """
    out, skipping = [], False
    for line in lines:
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_-]*)\s*:', line)
        if m:
            skipping = m.group(1) in MANAGED
        if not skipping:
            out.append(line)
    return out


def original_mode(lines):
    for line in lines:
        m = re.match(r'^mode\s*:\s*(\S+)', line)
        if m:
            return m.group(1).strip().strip('"\'')
    return 'rule'


def node_hosts(lines):
    """提取 proxies 段里所有 server 值（IP 或域名），保序去重。"""
    hosts, in_proxies = [], False
    for line in lines:
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_-]*)\s*:', line)
        if m:
            in_proxies = (m.group(1) == 'proxies')
            continue
        if not in_proxies:
            continue
        s = re.match(r'^\s+(?:-\s+)?server\s*:\s*([^\s#]+)', line)
        if s:
            h = s.group(1).strip().strip('"\'')
            if h and h not in hosts:
                hosts.append(h)
    return hosts


def is_ipv4(s):
    try:
        socket.inet_aton(s)
        return True
    except OSError:
        return False


def resolve(host):
    if is_ipv4(host):
        return host
    try:
        return socket.gethostbyname(host)
    except Exception:
        return None


def onlink_cidrs(ng):
    """从当前路由表算出本地直连网段，供 route-exclude-address 使用。"""
    try:
        rows = ng.dump_routes(socket.AF_INET)
    except Exception:
        rows = []
    out = []
    for r in rows:
        # 只要 main 表的直连网段：table 255 是 local 表，里面那些
        # 127.255.255.255/32、广播地址之类只会把配置弄脏。
        if r.get('table') != 254 or r.get('dst_len', 0) >= 32:
            continue
        dst, bits, gw = r.get('dst', ''), r.get('dst_len', 0), r.get('gw', '')
        if gw or not dst or dst in ('0.0.0.0', '127.0.0.1'):
            continue
        cidr = '%s/%d' % (dst, bits)
        if cidr not in out:
            out.append(cidr)
    return out


def main():
    if len(sys.argv) < 3:
        print('用法: tun-merge.py <clash.yaml> <output.yaml>', file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, 'r', encoding='utf-8') as f:
        lines = f.read().replace('\r\n', '\n').replace('\r', '\n').split('\n')

    mode = original_mode(lines)
    if mode.lower() == 'direct':
        mode = 'global'          # DIRECT 会让 TUN 里的流量全部直连，必须纠正

    hosts = node_hosts(lines)
    ng = load_net_guard()
    gw, oif, iface = None, None, None
    if ng:
        try:
            v4 = ng.defaults(socket.AF_INET)
            if v4:
                gw, oif = v4[0]['gw'], v4[0]['oif']
                try:
                    iface = socket.if_indextoname(oif) if oif else None
                except (OSError, ValueError):
                    iface = None
        except Exception:
            pass
    if not iface:
        # 退路：从 /proc/net/route 里取带网关的默认路由接口名
        try:
            for row in open('/proc/net/route', encoding='utf-8').read().splitlines()[1:]:
                p = row.split()
                if p[1] == '00000000' and p[2] != '00000000':
                    iface = p[0]
                    break
        except OSError:
            pass
    iface = iface or 'eth0'

    # 域名节点必须在「还有默认路由 + 可用 DNS」时解析成 IP，再补 /32 主机路由。
    # net-guard 随后删掉默认路由，靠这些 /32 路由维持内核自己的上游连通性。
    node_ips, unresolved = [], []
    for h in hosts:
        ip = resolve(h)
        if not ip:
            unresolved.append(h)
            continue
        if ip not in node_ips:
            node_ips.append(ip)

    added, add_errors = [], []
    if ng and gw and oif:
        for ip in node_ips + DNS_SERVERS:
            err = ng.add_host_route(ip, gw, oif)   # None = 成功；EEXIST 已被内部忽略
            if err:
                add_errors.append('%s: %s' % (ip, err))
            else:
                added.append(ip)

    excludes = onlink_cidrs(ng) + ['%s/32' % ip for ip in node_ips] + \
               ['%s/32' % ip for ip in DNS_SERVERS]
    # 去重保序
    excludes = list(dict.fromkeys(excludes))

    out = strip_managed(lines)
    while out and not out[-1].strip():
        out.pop()
    out += [
        '',
        '# ---- ClaudeVM TUN 增强段（tun-merge.py 生成，勿手改）----',
        '# 容器内内核接管：应用无需显式代理，宿主 Clash 只是配置来源/辅助编辑工具。',
        'mode: %s' % mode,
        'ipv6: false',
        'log-level: info',
        'tun:',
        '  enable: true',
        '  stack: mips',
        '  auto-route: true',
        '  auto-detect-interface: false',
        '  interface-name: %s' % iface,
        '  strict-route: true',
        '  dns-hijack:',
        '    - any:53',
        '  route-exclude-address:',
    ]
    out += ['    - %s' % c for c in excludes]
    out += [
        'dns:',
        '  enable: true',
        '  listen: 127.0.0.1:53',
        '  enhanced-mode: fake-ip',
        '  fake-ip-range: %s' % FAKE_IP_RANGE,
        '  nameserver:',
    ]
    out += ['    - %s' % d for d in DNS_SERVERS]

    tmp = dst + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out) + '\n')
    os.rename(tmp, dst)
    os.chmod(dst, 0o600)

    print(json.dumps({
        'ok': True,
        'iface': iface,
        'gw': gw,
        'mode': mode,
        'node_hosts': hosts,
        'node_ips': node_ips,
        'unresolved': unresolved,
        'routes_added': added,
        'route_errors': add_errors,
        'excludes': excludes,
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
