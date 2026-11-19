#!/bin/bash
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
for fs in proc sys; do
    if ! mountpoint -q "/$fs"; then
        type=$fs
        [ "$fs" != sys ] || type=sysfs
        mount -t "$type" "$type" "/$fs"
    fi
done
if ! mountpoint -q /dev; then mount -t devtmpfs devtmpfs /dev; fi
ln -sfn /proc/self/fd /dev/fd
ln -sfn /proc/self/fd/0 /dev/stdin
ln -sfn /proc/self/fd/1 /dev/stdout
ln -sfn /proc/self/fd/2 /dev/stderr
mkdir -p /dev/pts /dev/shm /run
if ! mountpoint -q /dev/pts; then mount -t devpts -o mode=620,gid=5 devpts /dev/pts; fi
if ! mountpoint -q /dev/shm; then mount -t tmpfs -o mode=1777 tmpfs /dev/shm; fi
if ! mountpoint -q /run; then mount -t tmpfs -o mode=755 tmpfs /run; fi
mount -t tmpfs -o mode=1777,size=512m tmpfs /tmp
hostname claude-haven
ip link set lo up
modprobe virtio_net
modprobe vmw_vsock_virtio_transport
modprobe tun
mount -t virtiofs workspace /workspace
mount -t virtiofs -o ro haven-runtime /mnt/haven-runtime
# Configure the initial route once. The network guard manages it from here on.
printf 'nameserver 1.1.1.1\n' > /etc/resolv.conf
for device in /sys/class/net/*; do
    interface=${device##*/}
    [ "$interface" != lo ] || continue
    ip link set "$interface" up
    dhcp=/usr/local/lib/haven/tools
    "$dhcp/ld-linux-aarch64.so.1" --library-path "$dhcp" "$dhcp/busybox" udhcpc \
        -q -n -t 4 -T 1 -i "$interface" -s /usr/local/lib/haven/dhcp.sh || true
    break
done
/usr/bin/python3 /usr/local/lib/haven/guest.py &
bridge=$!
poweroff_guest() {
    # Stop all guest processes, then flush the writable disk before powering down.
    trap '' TERM INT PWR
    kill -TERM -1 2>/dev/null || true
    sleep 1
    kill -KILL -1 2>/dev/null || true
    sync
    fstrim /var/lib/haven-data 2>/dev/null || true
    /sbin/poweroff -f 2>/dev/null || /usr/bin/python3 -c 'import ctypes; ctypes.CDLL(None).reboot(0x4321fedc)'
}
trap poweroff_guest TERM INT PWR
wait "$bridge" || true
poweroff_guest
