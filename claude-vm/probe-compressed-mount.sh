#!/usr/bin/env bash
# Exercise a host-backed SquashFS and an ext4 writable layer without launching the desktop.
# Usage: sudo bash probe-compressed-mount.sh /mnt/<drive>/path/to/rootfs.squashfs [--offline-input]
set -euo pipefail

if [[ $# == 0 || $# -gt 2 || $EUID != 0 || ${1:-} != /* || ${2:---offline-input} != --offline-input ]]; then
    echo "Usage: sudo bash $0 /mnt/<drive>/path/to/rootfs.squashfs [--offline-input]" >&2
    exit 2
fi
image=$(realpath "$1")
[[ -f $image ]]
work=$(mktemp -d /var/tmp/haven-overlay.XXXXXXXX)
profile_path=$work/merged/run/haven-probe-profile
unmount_overlay() {
    local target
    for target in "$profile_path" "$work/merged/proc" "$work/merged/dev" "$work/merged"; do
        if findmnt -n -M "$target" >/dev/null; then umount -- "$target" || return; fi
    done
}
cleanup() {
    unmount_overlay || return
    if findmnt -n -M "$work/lower" >/dev/null; then umount -- "$work/lower" || return; fi
    rm -rf -- "$work"
}
trap cleanup EXIT
mkdir -- "$work"/{lower,upper,work,merged,profile}
mount -t squashfs -o loop,ro "$image" "$work/lower"
mount_overlay() {
    mount -t overlay overlay \
        -o "lowerdir=$work/lower,upperdir=$work/upper,workdir=$work/work" "$work/merged"
    mkdir -p -- "$profile_path"
    mount --bind "$work/profile" "$profile_path"
    mount -t proc proc "$work/merged/proc"
    mount --bind /dev "$work/merged/dev"
}
mount_overlay
chroot "$work/merged" /bin/bash -ec '
    for node_bin in /usr/local/lib/nodejs/*/bin; do
        if [[ -x $node_bin/claude ]]; then
            export PATH="$node_bin:$PATH"
            break
        fi
    done
    test -x /usr/bin/Xtigervnc
    test -x /usr/local/bin/mihomo
    /opt/google/chrome/chrome --version
    node --version
    claude --version
'
if [[ $# == 2 ]]; then
    chroot "$work/merged" /bin/bash -ec '
        command -v fcitx5
        command -v lxterminal
        test -f /usr/share/fcitx5/addon/xcb.conf
        test -f /usr/share/rime-data/stroke.schema.yaml
        fc-list ":charset=20000" family | grep -qi .
        fc-list ":family=Noto Sans SC" family | grep -qi "Noto Sans SC"
        fc-list ":family=Noto Sans TC" family | grep -qi "Noto Sans TC"
        for type in table prism reverse; do
            test -s "/root/.local/share/fcitx5/rime/build/wanxiang_pure.$type.bin"
        done
        # Exercise graphics without publishing a VNC port or opening network access.
        Xtigervnc :48 -geometry 800x600 -depth 24 -rfbport -1 -nolisten tcp >/tmp/haven-probe-xvnc.log 2>&1 &
        vnc_pid=$!
        trap "kill $vnc_pid 2>/dev/null || true; wait $vnc_pid 2>/dev/null || true" EXIT
        for attempt in {1..40}; do
            if DISPLAY=:48 xset q >/dev/null 2>&1; then
                echo "TigerVNC display ready"
                exit 0
            fi
            kill -0 "$vnc_pid" 2>/dev/null || break
            sleep 0.25
        done
        cat /tmp/haven-probe-xvnc.log >&2
        exit 1
    '
fi
chroot "$work/merged" /bin/bash -c 'printf "%s\n" "retained profile" > /run/haven-probe-profile/example'
chroot "$work/merged" /bin/bash -c 'printf "%s\n" overlay-write > /etc/haven-probe'
test -f "$work/upper/etc/haven-probe"
test ! -e "$work/lower/etc/haven-probe"
unmount_overlay
mount_overlay
test "$(cat "$work/merged/etc/haven-probe")" = overlay-write
test "$(cat "$profile_path/example")" = 'retained profile'
findmnt -n -o SOURCE,FSTYPE,OPTIONS --target "$work/lower"
loop=$(findmnt -n -o SOURCE --target "$work/lower")
losetup -ln -O BACK-FILE "$loop"
du -sk "$work/upper" "$work/profile"
