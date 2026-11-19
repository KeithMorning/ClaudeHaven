#!/bin/sh
set -eu
[ "$1" = bound ] || exit 0
# udhcpc delivers the subnet as a dotted netmask.
prefix=$(/usr/bin/python3 -c 'import ipaddress,os; print(ipaddress.IPv4Network("0.0.0.0/"+os.environ["subnet"]).prefixlen)')
ip -4 route flush dev "$interface" proto dhcp
ip address replace "$ip/$prefix" dev "$interface"
for gateway in ${router:-}; do
    ip route replace default via "$gateway" dev "$interface"
    break
done
if [ -n "${dns:-}" ]; then
    : > /etc/resolv.conf
    for server in $dns; do printf 'nameserver %s\n' "$server" >> /etc/resolv.conf; done
fi
