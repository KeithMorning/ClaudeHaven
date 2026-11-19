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
mkdir -p /dev/pts /dev/shm /run
if ! mountpoint -q /dev/pts; then mount -t devpts -o mode=620,gid=5 devpts /dev/pts; fi
if ! mountpoint -q /dev/shm; then mount -t tmpfs -o mode=1777 tmpfs /dev/shm; fi
if ! mountpoint -q /run; then mount -t tmpfs -o mode=755 tmpfs /run; fi
hostname claude-haven
ip link set lo up
modprobe virtio_net
modprobe vmw_vsock_virtio_transport
modprobe tun
mount -t virtiofs workspace /workspace
mount -t virtiofs -o ro haven-runtime /mnt/haven-runtime
mkdir -p /var/lib/haven-data
# Accept only an untouched disk or our own ext4 volume. Preserve an existing volume.
if ! label=$(blkid -o value -s LABEL /dev/vdb); then
    if wipefs --noheadings /dev/vdb | grep -q .; then
        echo "Unrecognized persistent data disk" >&2
        exit 1
    fi
    mkfs.ext4 -q -L haven-data /dev/vdb
else
    test "$label" = haven-data
fi
mount /dev/vdb /var/lib/haven-data
if ! test -d /var/lib/haven-data/root; then
    mkdir -p /var/lib/haven-data/root.new
    cp -a /root/. /var/lib/haven-data/root.new
    mv /var/lib/haven-data/root.new /var/lib/haven-data/root
fi
mount --bind /var/lib/haven-data/root /root
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
    # Stop all guest processes, then flush both disks before powering down.
    trap '' TERM INT PWR
    kill -TERM -1 2>/dev/null || true
    sleep 1
    kill -KILL -1 2>/dev/null || true
    sync
    umount /root /var/lib/haven-data || true
    /sbin/poweroff -f 2>/dev/null || /usr/bin/python3 -c 'import ctypes; ctypes.CDLL(None).reboot(0x4321fedc)'
}
trap poweroff_guest TERM INT PWR
wait "$bridge" || true
poweroff_guest
