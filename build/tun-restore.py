#!/usr/bin/env python3
"""把默认路由加回物理网关（TUN spike 退出兜底）。

mihomo 的 auto-route 会加 0.0.0.0/1 + 128.0.0.0/1 两条覆盖路由，
并可能删掉原默认路由。进程退出时 sing-tun 通常会自己撤，但不保证；
net-guard.py unlock 只恢复「它自己删掉的」默认路由，spike 场景里没有记录可用。
所以这里直接用 AF_NETLINK / RTM_NEWROUTE 幂等加回，失败就明确报错，由外层决定重启发行版。
"""
import socket
import struct
import sys

NETLINK_ROUTE = 0
RTM_NEWROUTE = 24
NLM_F_REQUEST = 1
NLM_F_ACK = 4
NLM_F_CREATE = 0x400
NLM_F_REPLACE = 0x100
RTA_OIF = 4
RTA_GATEWAY = 5


def nlmsg(payload, seq=1):
    flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_REPLACE
    return struct.pack('IHHII', 16 + len(payload), RTM_NEWROUTE, flags, seq, 0) + payload


def attr(kind, value):
    pad = (-len(value)) % 4
    return struct.pack('HH', 4 + len(value), kind) + value + b'\x00' * pad


def main():
    iface, gw = sys.argv[1], sys.argv[2]
    with open('/sys/class/net/%s/ifindex' % iface) as f:
        oif = int(f.read().strip())
    # rtmsg: family, dst_len, src_len, tos, table, protocol, scope, type, flags
    rt = struct.pack('BBBBBBBBI', socket.AF_INET, 0, 0, 0, 254, 3, 0, 1, 0)
    payload = rt + attr(RTA_GATEWAY, socket.inet_aton(gw)) + \
        attr(RTA_OIF, struct.pack('I', oif))
    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_ROUTE)
    s.bind((0, 0))
    s.send(nlmsg(payload))
    data = s.recv(4096)
    # NLMSG_ERROR 的开头 4 字节是 errno，0 表示成功（含 EEXIST 已被 REPLACE 覆盖）
    errno = struct.unpack('i', data[16:20])[0]
    if errno != 0:
        print('restore failed errno=%d' % errno)
        return 1
    print('default route restored via %s dev %s' % (gw, iface))
    return 0


if __name__ == '__main__':
    sys.exit(main())
