#!/usr/bin/env python3
"""Dump 所有路由表（含策略路由表），不依赖 iproute2。

/proc/net/route 只显示 main 表；mihomo 的 auto-route 在 Linux 上用
ip rule + 独立 routing table，必须用 netlink RTM_GETROUTE dump 才看得见。
用法：python3 tun-routes.py [before|after]，输出可直接 diff。
"""
import socket
import struct
import sys

NETLINK_ROUTE = 0
RTM_GETROUTE = 26
RTM_NEWROUTE = 24
NLM_F_REQUEST = 1
NLM_F_DUMP = 0x300
NLMSG_DONE = 3
NLMSG_ERROR = 2
RTA_DST, RTA_OIF, RTA_GATEWAY, RTA_TABLE = 1, 4, 5, 15


def dump_all_tables():
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_ROUTE)
    s.bind((0, 0))
    rt = struct.pack('BBBBBBBBI', socket.AF_INET, 0, 0, 0, 0, 0, 0, 0, 0)
    msg = struct.pack('IHHII', 16 + len(rt), RTM_GETROUTE,
                      NLM_F_REQUEST | NLM_F_DUMP, 1, 0) + rt
    s.send(msg)
    rows = set()
    while True:
        data = s.recv(256 * 1024)
        pos, done = 0, False
        while pos + 16 <= len(data):
            ln, typ, flags, seq, pid = struct.unpack_from('IHHII', data, pos)
            if ln < 16:
                break
            body = data[pos + 16:pos + ln]
            if typ == NLMSG_DONE:
                done = True
                break
            if typ == NLMSG_ERROR:
                break
            if typ == RTM_NEWROUTE and len(body) >= 12:
                fam, dl, sl, tos, table, proto, scope, rtype, fl = \
                    struct.unpack_from('BBBBBBBBI', body, 0)
                attrs, p, a = body[12:], 0, {}
                while p + 4 <= len(attrs):
                    al, at = struct.unpack_from('HH', attrs, p)
                    if al < 4:
                        break
                    a[at] = attrs[p + 4:p + al]
                    p += (al + 3) & ~3
                dst = socket.inet_ntoa(a[RTA_DST][:4]) if RTA_DST in a else '0.0.0.0'
                gw = socket.inet_ntoa(a[RTA_GATEWAY][:4]) if RTA_GATEWAY in a else ''
                oif = struct.unpack('I', a[RTA_OIF][:4])[0] if RTA_OIF in a else 0
                tab = struct.unpack('I', a[RTA_TABLE][:4])[0] if RTA_TABLE in a else table
                rows.add((tab, dst, dl, gw, oif, proto, rtype))
            pos += (ln + 3) & ~3
        if done:
            break
    return sorted(rows)


if __name__ == '__main__':
    label = sys.argv[1] if len(sys.argv) > 1 else 'snapshot'
    print('### %s' % label)
    print('table  dst            plen  gw              oif  proto  type')
    for tab, dst, dl, gw, oif, proto, rtype in dump_all_tables():
        print('%-6s %-15s %-5s %-15s %-4s %-6s %s' %
              (tab, dst, dl, gw or '-', oif, proto, rtype))
