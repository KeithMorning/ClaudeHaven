#!/usr/bin/env bash
# Build a minimal amd64 WSL probe from Ubuntu's installed system utilities.
# Usage: bash probe-wsl-bootstrap.sh OUTPUT.tar.gz
set -euo pipefail

if [[ $# != 1 || -e $1 || -L $1 ]]; then
    echo "Usage: $0 UNUSED_OUTPUT.tar.gz" >&2
    exit 2
fi
output=$1
root=$(mktemp -d /var/tmp/haven-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$root"' EXIT
mkdir -p -- "$root"/{bin,sbin,etc,dev,proc,sys,run,var/tmp,root,tmp,mnt}
chmod 1777 "$root"/{tmp,var/tmp}

for command in bash busybox findmnt mount umount losetup chroot; do
    executable=$(command -v "$command")
    install -m 755 "$executable" "$root/bin/$command"
    while read -r library; do
        mkdir -p -- "$root$(dirname -- "$library")"
        cp -L -- "$library" "$root$library"
    done < <(ldd "$executable" 2>/dev/null | awk '
        $2 == "=>" && $3 ~ /^\// {print $3}
        $1 ~ /^\// {print $1}
    ')
done
ln -s bash "$root/bin/sh"
for applet in cat chmod du id mkdir mktemp realpath rm stat uname; do
    ln -s busybox "$root/bin/$applet"
done
printf 'root:x:0:0:root:/root:/bin/bash\n' > "$root/etc/passwd"
printf 'root:x:0:\n' > "$root/etc/group"
printf '[automount]\nenabled=true\nroot=/mnt/\n[interop]\nappendWindowsPath=false\n' > "$root/etc/wsl.conf"
tar --numeric-owner --owner=0 --group=0 -czf "$output" -C "$root" .
stat -c '%s bytes %n' -- "$output"
