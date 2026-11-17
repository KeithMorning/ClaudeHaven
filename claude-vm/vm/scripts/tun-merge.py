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

用法：tun-merge.py <clash.yaml> <output.yaml> [TUN_NODE]
  TUN_NODE 非空时按「全量单节点」生成：剥离订阅的 proxy-groups / rules，
  以 global 模式把所有流量指向该节点；节点名必须存在于 proxies 段，
  校验失败直接报错（由 tun-core.sh 保持全断网），绝不静默回落。
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
    # 订阅里的 external-controller* 一律剥掉：Clash Verge 会写 Windows 命名管道，
    # 残留到 Linux 里既是脏配置，也可能把控制 API 暴露到我们预期之外的地址。
    'external-controller', 'external-controller-cors',
    'external-controller-pipe', 'external-ui', 'secret',
}
CONTROLLER = '127.0.0.1:9090'
# 全量单节点时额外剥离：订阅自带的分流段会和下面生成的同名段冲突。
# MANAGED 仍保留（tun/dns/ipv6/mode 等由我们生成，订阅里必须先删）。
STRIP_KEYS = {'proxy-groups', 'rules'}
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


def strip_keys(lines, extra=()):
    """按顶层键做行级剥离：MANAGED 恒剥离，extra 是本次追加要剥离的键。

    零依赖，不解析 YAML。Clash 配置的顶层键都是顶格 `key:`，子项带缩进，
    所以一个状态机就够；遇到新的顶格键自动结束上一段的跳过状态。
    保留用户自己的 proxies 段原样（节点定义要留给 mihomo 加载）。
    """
    drop = set(MANAGED) | set(extra)
    out, skipping = [], False
    for line in lines:
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_-]*)\s*:', line)
        if m:
            skipping = m.group(1) in drop
        if not skipping:
            out.append(line)
    return out


def strip_managed(lines):
    """兼容旧口径：只剥离 MANAGED（保留用户 proxy-groups / rules）。"""
    return strip_keys(lines)


def original_mode(lines):
    for line in lines:
        m = re.match(r'^mode\s*:\s*(\S+)', line)
        if m:
            return m.group(1).strip().strip('"\'')
    return 'rule'


def _clean_name(v):
    """节点名去引号 / 去行内注释，与宿主 tun-config.js 的 unquote 对齐。"""
    v = v.strip()
    if len(v) >= 2 and v[0] in ('"', "'") and v[-1] == v[0]:
        return v[1:-1]
    return v.split('#', 1)[0].strip().strip('"\'')


def node_names(lines):
    """提取 proxies 段的节点名，保序去重。

    必须与宿主 `app/lib/tun-config.js` 的 extractNodes 用**同一套规则**：
    Clash 订阅里一个节点既可能写成

        - name: Foo           # name 是列表项第一键
          type: vless

    也可能写成（Clash Verge / 多数机场订阅的实际格式）

        - type: vless         # name 在列表项的第二行
          name: Foo

    旧实现只认第一种 `- name:` 开头，遇到第二种返回空列表，于是宿主界面
    能选中节点、客机却报「节点不在 proxies 列表中」，merge 失败 → 内核不启动
    → net-guard 判 leak-detected 全断网（坑 24）。

    状态机按 `^\\s*-\\s+` 切分列表项，项内再找 name 键；顶层键切换时收尾。
    """
    names, in_proxies, cur = [], False, None

    def flush():
        nonlocal cur
        if cur and cur not in names:
            names.append(cur)
        cur = None

    for line in lines:
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_-]*)\s*:', line)
        if m:
            if in_proxies:
                flush()
            in_proxies = (m.group(1) == 'proxies')
            continue
        if not in_proxies:
            continue
        item = re.match(r'^\s*-\s+(.*)$', line)
        if item:
            flush()
            nm = re.match(r'^name\s*:\s*(.+)$', item[1])
            cur = _clean_name(nm.group(1)) if nm else None
            continue
        kv = re.match(r'^\s+name\s*:\s*(.+)$', line)
        if kv:
            cur = _clean_name(kv.group(1))
    flush()
    return names


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
        print('用法: tun-merge.py <clash.yaml> <output.yaml> [TUN_NODE]', file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    node = sys.argv[3] if len(sys.argv) >= 4 else ''
    with open(src, 'r', encoding='utf-8') as f:
        lines = f.read().replace('\r\n', '\n').replace('\r', '\n').split('\n')

    names = node_names(lines)
    selected = None
    if node:
        # 节点名必须是订阅里真实存在的 proxies 名。不存在绝不静默忽略，
        # 否则出口会落回订阅原有分流，用户以为选了 A 实际走了别的节点。
        if node not in names:
            print('tun-merge.py: 选中的节点 %r 不在 proxies 节点列表中' % node,
                  file=sys.stderr)
            return 3
        selected = node
        # 必须是 rule 模式：global 会走内置 GLOBAL 组并**忽略**下面生成的
        # `rules: MATCH,ClaudeVM`，选中节点反而不生效（官方文档明确说明）。
        # rule + 单条 MATCH 兜底 = 所有流量都进只含选中节点的 ClaudeVM 组。
        mode = 'rule'
    else:
        mode = original_mode(lines)
        if mode.lower() == 'direct':
            mode = 'global'      # DIRECT 会让 TUN 里的流量全部直连，必须纠正

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

    # 全量单节点时连订阅的 proxy-groups / rules 一起剥掉，下面重新生成。
    out = strip_keys(lines, STRIP_KEYS if node else ())
    while out and not out[-1].strip():
        out.pop()
    out += [
        '',
        '# ---- ClaudeVM TUN 增强段（tun-merge.py 生成，勿手改）----',
        '# 容器内内核接管：应用无需显式代理，宿主 Clash 只是配置来源/辅助编辑工具。',
        'mode: %s' % mode,
        'ipv6: false',
        'log-level: info',
        # 只听客机本地回环：node-delay.py 用它实测节点延迟，宿主不直接连这个端口。
        'external-controller: %s' % CONTROLLER,
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
    if node:
        # 节点名可能含空格/中文/特殊字符，用 json.dumps 生成带引号的 YAML 标量。
        out += [
            '',
            '# 全量单节点：忽略订阅原有分流，所有流量都指向选中节点',
            'proxy-groups:',
            '  - name: ClaudeVM',
            '    type: select',
            '    proxies:',
            '      - %s' % json.dumps(node, ensure_ascii=False),
            'rules:',
            '  - MATCH,ClaudeVM',
        ]

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
        'nodes': names,
        'selected_node': selected,
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
