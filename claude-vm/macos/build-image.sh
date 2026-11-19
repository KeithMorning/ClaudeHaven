#!/usr/bin/env bash
# Run as root in a Linux ARM64 build VM with the kernel intended for the guest.
set -euo pipefail
[[ $(uname -m) == aarch64 && $EUID == 0 ]]
rootfs=$(realpath "${1:?ARM64 rootfs tar.gz required}")
out=$(realpath -m "${2:?output directory required}")
here=$(dirname "$(realpath "$0")")
version=$(uname -r)
tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/haven-build.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
root=$tmp/root
mkdir -p "$root" "$out"
tar --numeric-owner -xzf "$rootfs" -C "$root"
find "$root" -maxdepth 1 -type f -name '*.core' -delete
rm -f "$root/.dockerenv"
install -d "$root/usr/local/lib/haven" "$root/workspace" "$root/mnt/haven-runtime"
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
truncate -s 6G "$tmp/system.img"
mkfs.ext4 -q -F -N 180000 -d "$root" "$tmp/system.img"
# Ubuntu may wrap the compressed ARM64 Image in an EFI unified kernel image.
kernel="/boot/vmlinuz-$version"
objcopy --dump-section ".linux=$tmp/linux-section" "$kernel" "$tmp/efi-copy" 2>/dev/null || true
if [[ -s $tmp/linux-section ]]; then kernel="$tmp/linux-section"; fi
python3 - "$kernel" "$out/kernel.tmp" <<'PYK'
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
cp "/boot/initrd.img-$version" "$out/initrd.tmp"
gzip -1c "$tmp/system.img" > "$out/system.img.gz.tmp"
mv "$out/kernel.tmp" "$out/kernel"
mv "$out/initrd.tmp" "$out/initrd"
mv "$out/system.img.gz.tmp" "$out/system.img.gz"
(cd "$out" && sha256sum kernel initrd system.img.gz > image-version.tmp && mv image-version.tmp image-version)
