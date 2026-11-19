#!/usr/bin/env bash
# Build an experimental compressed system image. Run inside an ext4-backed WSL distro.
# Usage: bash probe-compressed-rootfs.sh ROOTFS.tar.gz OUTPUT.squashfs
set -euo pipefail

if [[ $# != 2 ]]; then
    echo "Usage: $0 ROOTFS.tar.gz OUTPUT.squashfs" >&2
    exit 2
fi
if [[ $EUID != 0 ]]; then
    echo 'Run as root to preserve Linux ownership and file attributes.' >&2
    exit 2
fi
archive=$(realpath -- "$1")
output=$(realpath -m -- "$2")
if [[ ! -f $archive || -e $output || -L $output ]]; then
    echo 'Provide an existing RootFS archive and an unused output path.' >&2
    exit 2
fi

work=$(mktemp -d /var/tmp/haven-squashfs.XXXXXXXX)
partial=
cleanup() {
    [[ -z $partial ]] || rm -f -- "$partial"
    rm -rf -- "$work"
}
trap cleanup EXIT
mkdir "$work/root"
tar --numeric-owner --xattrs --xattrs-include='*' -xzf "$archive" -C "$work/root"
# npm's package tarballs duplicate the installed binaries. They are only needed at build time.
rm -rf -- "$work/root/root/.npm/_cacache" "$work/root/root/.npm/_logs"
# The older Windows build has an npm launcher pointing to a missing claude.exe.
# Use the bundled Linux native binary when rebuilding that specific archive.
for node_root in "$work/root"/usr/local/lib/nodejs/*; do
    launcher=$node_root/bin/claude
    native=$node_root/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude
    if [[ -L $launcher && ! -e $launcher && -x $native ]]; then
        native_path=${native#"$work/root"}
        ln -sfn -- "$native_path" "$launcher"
        if [[ ! -e $work/root/usr/local/bin/claude && ! -L $work/root/usr/local/bin/claude ]]; then
            ln -s -- "${launcher#"$work/root"}" "$work/root/usr/local/bin/claude"
        fi
    fi
done
partial=$(mktemp -- "${output}.partial.XXXXXXXX")
# Optional x86 branch conversion improves compression of native AMD64 executables.
codec_options=()
if [[ ${SQUASHFS_X86_BCJ:-0} == 1 ]]; then
    codec_options=(-Xbcj x86)
fi
mksquashfs "$work/root" "$partial" -noappend -no-progress -comp xz -b 1M \
    -processors "${SQUASHFS_PROCESSORS:-4}" "${codec_options[@]}"
mv -nT -- "$partial" "$output"
if [[ -e $partial ]]; then
    echo 'Output appeared during the build.' >&2
    exit 1
fi
stat -c '%s bytes %n' -- "$output"
