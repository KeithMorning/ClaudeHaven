#!/usr/bin/env bash
# Run as root in a Linux ARM64 build VM with the kernel intended for the guest.
set -euo pipefail
[[ $(uname -m) == aarch64 && $EUID == 0 ]]
rootfs=$(realpath "${1:?ARM64 rootfs tar.gz required}")
out=$(realpath -m "${2:?output directory required}")
here=$(dirname "$(realpath "$0")")
version=$(uname -r)
tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/haven-build.XXXXXXXX")
cleanup() {
    for mount in "$root/dev" "$root/proc"; do
        if mountpoint -q "$mount" && ! umount "$mount"; then
            printf 'Build mount still active: %s\n' "$mount" >&2
            return
        fi
    done
    rm -rf "$tmp"
}
trap cleanup EXIT
root=$tmp/root
mkdir -p "$root" "$out"
tar --numeric-owner -xzf "$rootfs" -C "$root"
find "$root" -maxdepth 1 -type f -name '*.core' -delete
rm -f "$root/.dockerenv"
# Install the same input method dependencies used by rime-setup before packaging.
# Seed /root on the read-only layer so each workspace inherits the configuration.
rm -f "$root/etc/resolv.conf"
printf 'nameserver 1.1.1.1\n' > "$root/etc/resolv.conf"
mkdir -p "$root/dev" "$root/proc" "$root/opt/assets/rime"
mount --bind /dev "$root/dev"
mount -t proc proc "$root/proc"
chroot "$root" /usr/bin/env DEBIAN_FRONTEND=noninteractive /bin/sh -c \
    'apt-get update && apt-get -o Dpkg::Use-Pty=0 install -y --no-install-recommends fcitx5 fcitx5-rime fcitx5-frontend-gtk3 fcitx5-module-xorg rime-data-stroke librime-bin lxterminal fonts-hanazono && fc-cache -f && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb'
install -m 644 "$here/../vm/assets/rime/wanxiang-pure.zip" "$root/opt/assets/rime/wanxiang-pure.zip"
install -m 755 "$here/../vm/scripts/rime-setup.sh" "$root/tmp/haven-rime-setup.sh"
chroot "$root" /bin/bash /tmp/haven-rime-setup.sh
test -f "$root/root/.local/share/fcitx5/rime/.wanxiang-v18.1.8"
rime_dir=/root/.local/share/fcitx5/rime
chroot "$root" /usr/bin/rime_deployer --build "$rime_dir" /usr/share/rime-data
test -s "$root$rime_dir/build/wanxiang_pure.prism.bin"
test -s "$root$rime_dir/build/wanxiang_pure.table.bin"
rm -f "$root/tmp/haven-rime-setup.sh" "$root/opt/assets/rime/wanxiang-pure.zip"
umount "$root/proc"
umount "$root/dev"
install -d "$root/usr/local/lib/haven" "$root/workspace" "$root/mnt/haven-runtime" "$root/var/lib/haven-data"
install -m 755 "$here/guest-init.sh" "$root/usr/local/lib/haven/init.sh"
install -m 644 "$here/guest.py" "$root/usr/local/lib/haven/guest.py"
install -m 755 "$here/dhcp.sh" "$root/usr/local/lib/haven/dhcp.sh"
ln -sf /usr/local/lib/haven/init.sh "$root/sbin/init"
tools="$root/usr/local/lib/haven/tools"
install -d "$tools"
for command in busybox kmod; do
    executable=$(command -v "$command")
    install -m 755 "$executable" "$tools/$command"
    while read -r library; do
        install -m 755 "$library" "$tools/$(basename "$library")"
    done < <(ldd "$executable" | awk '{for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i}')
done
rm -f "$root/sbin/modprobe"
cat > "$root/sbin/modprobe" <<'EOF'
#!/bin/sh
tools=/usr/local/lib/haven/tools
exec "$tools/ld-linux-aarch64.so.1" --library-path "$tools" --argv0 modprobe "$tools/kmod" "$@"
EOF
chmod 755 "$root/sbin/modprobe"
mkdir -p "$root/lib/modules/$version"
for mod in virtiofs virtio_blk virtio_net vmw_vsock_virtio_transport tun nf_tables nft_chain_nat iptable_filter iptable_nat ip6table_filter xt_addrtype xt_comment xt_conntrack xt_mark xt_tcpudp; do
    while read -r type file _; do
        if [[ $type == insmod ]]; then
            install -D -m 644 "$file" "$root/lib/modules/$version/${file#*/$version/}"
            # Ubuntu 22.04 kmod does not necessarily support zstd modules.
            if [[ $file == *.zst ]]; then
                copy="$root/lib/modules/$version/${file#*/$version/}"
                if [[ -f $copy ]]; then zstd -dfq --rm "$copy"; fi
            fi
        fi
    done < <(modprobe --show-depends "$mod" 2>/dev/null)
done
cp /lib/modules/"$version"/modules.builtin{,.modinfo} "$root/lib/modules/$version/"
touch "$root/lib/modules/$version/modules.order"
depmod -b "$root" "$version"
# Docker supplies /etc/hosts at runtime and it can be absent from an export.
printf '127.0.0.1 localhost claude-haven\n::1 localhost ip6-localhost ip6-loopback\n' > "$root/etc/hosts"
rm -f "$root/etc/resolv.conf"
printf 'nameserver 1.1.1.1\n' > "$root/etc/resolv.conf"
bash "$here/trim-system.sh" "$root"
chroot "$root" fc-cache -f
# Ubuntu may wrap the compressed ARM64 Image in an EFI unified kernel image.
kernel="/boot/vmlinuz-$version"
objcopy --dump-section ".linux=$tmp/linux-section" "$kernel" "$tmp/efi-copy" 2>/dev/null || true
if [[ -s $tmp/linux-section ]]; then kernel="$tmp/linux-section"; fi
python3 - "$kernel" "$tmp/kernel" <<'PYK'
import gzip, pathlib, struct, subprocess, sys
data = pathlib.Path(sys.argv[1]).read_bytes()
if data[4:8] == b"zimg":
    offset, length = struct.unpack_from("<II", data, 8)
    compression = data[24:32].rstrip(b"\0")
    payload = data[offset:offset + length]
    if compression == b"zstd":
        data = subprocess.check_output(["zstd", "-dc"], input=payload)
    elif compression == b"gzip":
        data = gzip.decompress(payload)
    else:
        raise SystemExit(f"Unsupported ARM64 kernel compression: {compression!r}")
elif data.startswith(b"\x1f\x8b"):
    data = gzip.decompress(data)
if data[56:60] != b"ARM\x64":
    raise SystemExit("Expected a raw ARM64 Linux Image")
pathlib.Path(sys.argv[2]).write_bytes(data)
PYK
bash "$here/pack-system.sh" "$root" "$out" "$tmp/kernel"
