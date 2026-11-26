#!/usr/bin/env bash
# Pack a prepared guest filesystem and the kernel for this architecture.
set -euo pipefail
root=$(realpath "${1:?prepared guest filesystem required}")
out=$(realpath -m "${2:?output directory required}")
kernel=$(realpath "${3:?raw Linux kernel required}")
case $(uname -m) in
    aarch64) xz_filter=--arm64; squashfs_filter=arm64 ;;
    x86_64) xz_filter=--x86; squashfs_filter=x86 ;;
    *) echo "Unsupported Linux build architecture: $(uname -m)" >&2; exit 2 ;;
esac
here=$(dirname "$(realpath "$0")")
boot=$(mktemp -d)
trap 'rm -rf "$boot"' EXIT
mkdir -p "$out" "$boot"/{bin,dev,proc,lower,state,newroot,modules}
install -m 755 "$here/initramfs-init.sh" "$boot/init"
busybox=$(command -v busybox)
install -m 755 "$busybox" "$boot/bin/busybox"
while read -r library; do
    install -D -m 755 "$library" "$boot$library"
done < <(ldd "$busybox" | awk '{for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i}')

index=0
while read -r type file _; do
    [[ $type == insmod ]] || continue
    module=$(printf '%s/modules/%03d.ko' "$boot" "$index")
    case "$file" in
        *.zst) zstd -dc "$file" > "$module" ;;
        *.xz) xz -dc "$file" > "$module" ;;
        *) cp "$file" "$module" ;;
    esac
    index=$((index + 1))
done < <(modprobe --show-depends overlay)

(cd "$boot" && find . -print0 | "$busybox" cpio -0 -o -H newc) | gzip -9 > "$out/initrd.tmp"
tar -C "$(dirname "$kernel")" -cf - "$(basename "$kernel")" | xz "$xz_filter" --lzma2=preset=9e > "$out/kernel.tar.xz.tmp"
rm -f "$out/system.squashfs.tmp"
mksquashfs "$root" "$out/system.squashfs.tmp" -noappend -comp xz -Xbcj "$squashfs_filter" -b 1M -processors 4 -no-progress
for file in initrd kernel.tar.xz system.squashfs; do
    mv "$out/$file.tmp" "$out/$file"
done
(cd "$out" && sha256sum kernel.tar.xz initrd system.squashfs > image-version.tmp && mv image-version.tmp image-version)
