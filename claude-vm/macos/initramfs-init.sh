#!/bin/busybox sh
set -eu
export PATH=/bin
/bin/busybox --install -s /bin
mount -t devtmpfs devtmpfs /dev
mount -t proc proc /proc

for disk in /dev/vda /dev/vdb; do
    wait_seconds=0
    while [ ! -b "$disk" ]; do
        [ "$wait_seconds" -lt 20 ] || { echo "Missing VM disk: $disk"; exit 1; }
        sleep 1
        wait_seconds=$((wait_seconds + 1))
    done
done
mount -t squashfs -o ro /dev/vda /lower
for module in /modules/*.ko; do
    [ -e "$module" ] || break
    insmod "$module"
done

# Use the guest's ext4 tools without duplicating them in the boot archive.
mount --bind /dev /lower/dev
label=$(chroot /lower /sbin/blkid -o value -s LABEL /dev/vdb || true)
if [ -z "$label" ]; then
    signatures=$(chroot /lower /sbin/wipefs --noheadings /dev/vdb)
    [ -z "$signatures" ] || { echo "Unrecognized persistent data disk"; exit 1; }
    chroot /lower /sbin/mkfs.ext4 -q -m 0 -J size=4 -L haven-state /dev/vdb
else
    [ "$label" = haven-state ] || { echo "Unrecognized persistent data disk"; exit 1; }
fi
umount /lower/dev
mount -t ext4 -o noatime /dev/vdb /state
mkdir -p /state/upper /state/work
mount -t overlay overlay -o lowerdir=/lower,upperdir=/state/upper,workdir=/state/work,index=off /newroot
mount --move /state /newroot/var/lib/haven-data
mount --move /dev /newroot/dev
mount --move /proc /newroot/proc
exec switch_root /newroot /sbin/init
