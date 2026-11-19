#!/usr/bin/env bash
# Build the offline Windows x64 image candidate in an amd64 Linux build distro.
# Usage: sudo bash build-windows-squashfs.sh ROOTFS.tar.gz OUTPUT.squashfs
set -euo pipefail

[[ $# == 2 && $EUID == 0 && $(uname -m) == x86_64 ]] || {
    echo "Usage on Linux x64 as root: $0 ROOTFS.tar.gz OUTPUT.squashfs" >&2
    exit 2
}
archive=$(realpath -- "$1")
output=$(realpath -m -- "$2")
here=$(dirname "$(realpath "$0")")
[[ -f $archive && ! -e $output && ! -L $output ]]
work=$(mktemp -d /var/tmp/haven-windows-build.XXXXXXXX)
root=$work/root
partial=
cleanup() {
    for target in "$root/proc" "$root/dev"; do
        if mountpoint -q "$target" && ! umount -- "$target"; then
            echo "Build mount still active: $target" >&2
            return
        fi
    done
    [[ -z $partial ]] || rm -f -- "$partial"
    rm -rf -- "$work"
}
trap cleanup EXIT
mkdir -- "$root"
tar --numeric-owner --xattrs --xattrs-include='*' -xzf "$archive" -C "$root"

# Use the build environment's resolver only while installing build dependencies.
resolver="$root/etc/resolv.conf"
if [[ -e $resolver || -L $resolver ]]; then mv -- "$resolver" "$work/resolv.conf"; fi
cp -L /etc/resolv.conf "$resolver"
mkdir -p -- "$root"/{dev,proc,opt/assets/rime}
mount --bind /dev "$root/dev"
mount -t proc proc "$root/proc"
chroot "$root" /usr/bin/env DEBIAN_FRONTEND=noninteractive bash -ec '
    apt-get update
    apt-get -o Dpkg::Use-Pty=0 install -y --no-install-recommends fcitx5 fcitx5-rime fcitx5-frontend-gtk3 \
        fcitx5-module-xorg rime-data-stroke librime-bin lxterminal fonts-hanazono
    apt-get clean
'
install -m 644 "$here/vm/assets/rime/wanxiang-pure.zip" "$root/opt/assets/rime/wanxiang-pure.zip"
for language in SC TC; do
    install -D -m 644 "$here/vm/assets/fonts/NotoSans$language.ttf" \
        "$root/usr/share/fonts/truetype/haven/NotoSans$language.ttf"
done
install -m 755 "$here/vm/scripts/rime-setup.sh" "$root/tmp/haven-rime-setup.sh"
chroot "$root" fc-cache -f
chroot "$root" /bin/bash /tmp/haven-rime-setup.sh
rime=/root/.local/share/fcitx5/rime
test -f "$root$rime/.wanxiang-v18.1.8"
chroot "$root" rime_deployer --build "$rime" /usr/share/rime-data
for type in table prism reverse; do
    test -s "$root$rime/build/wanxiang_pure.$type.bin"
done
# Match the macOS layout. The compiled table replaces the large static sources.
find "$root$rime" -type f -name '*.dict.yaml' -delete
rm -f -- "$root/opt/assets/rime/wanxiang-pure.zip" "$root/tmp/haven-rime-setup.sh"
umount -- "$root/proc"
umount -- "$root/dev"
rm -f -- "$resolver"
if [[ -e $work/resolv.conf || -L $work/resolv.conf ]]; then mv -- "$work/resolv.conf" "$resolver"; fi

# Keep software rendering and the same browser languages exposed by the app.
if [[ -d $root/opt/google/chrome/locales ]]; then
    find "$root/opt/google/chrome/locales" -maxdepth 1 -type f \
        ! -name 'en-US*' ! -name 'en-GB*' ! -name 'zh-CN*' ! -name 'zh-TW*' \
        ! -name 'ja*' ! -name 'de*' -delete
fi
rm -rf -- "$root/root/.npm/_cacache" "$root/root/.npm/_logs" "$root/var/lib/apt/lists"
rm -f -- "$root/opt/google/chrome/libLiteRtWebGpuAccelerator.so" \
    "$root/opt/google/chrome/liboptimization_guide_internal.so"
# TigerVNC has no Intel or AMD Vulkan device. Keep Mesa's software Vulkan,
# OpenGL loaders, and DRI drivers used by software rendering.
rm -f -- "$root"/usr/lib/x86_64-linux-gnu/libvulkan_{intel,intel_hasvk,radeon}.so \
    "$root"/usr/share/vulkan/icd.d/{intel,intel_hasvk,radeon}_icd.x86_64.json
for node_root in "$root"/usr/local/lib/nodejs/*; do
    launcher=$node_root/bin/claude
    native=$node_root/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude
    if [[ -L $launcher && ! -e $launcher && -x $native ]]; then
        ln -sfn -- "${native#"$root"}" "$launcher"
        [[ -e $root/usr/local/bin/claude || -L $root/usr/local/bin/claude ]] ||
            ln -s -- "${launcher#"$root"}" "$root/usr/local/bin/claude"
    fi
done
partial=$(mktemp -- "${output}.partial.XXXXXXXX")
mksquashfs "$root" "$partial" -noappend -no-progress -comp xz -Xbcj x86 -b 1M \
    -processors "${SQUASHFS_PROCESSORS:-4}"
mv -nT -- "$partial" "$output"
[[ ! -e $partial ]]
stat -c '%s bytes %n' -- "$output"
