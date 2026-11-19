# Run as root inside the dedicated Lima guest. Configuration arrives on stdin.
set -eu
root=/var/lib/claude-haven/rootfs
install -d -m 700 /var/lib/claude-haven
mountpoint -q /mnt/haven-runtime
mountpoint -q /mnt/haven-workspace

case "$archive:$(uname -m)" in
  rootfs-linux-arm64.tar.gz:aarch64|rootfs.tar.gz:x86_64) ;;
  *) echo 'Linux 镜像与虚拟机架构不匹配。' >&2; exit 1 ;;
esac

if [ ! -e "$root" ]; then
  staging=$(mktemp -d /var/lib/claude-haven/import.XXXXXXXX)
  trap 'rm -rf -- "$staging"' EXIT
  tar -xzf "/mnt/haven-runtime/$archive" -C "$staging"
  chroot "$staging" /bin/true
  mv -T -- "$staging" "$root"
  trap - EXIT
fi
chroot "$root" /bin/true

install -d "$root/opt/scripts" "$root/opt/assets" "$root/opt/config" \
  "$root/dev" "$root/proc" "$root/sys" "$root/run"
cp -a /mnt/haven-runtime/scripts/. "$root/opt/scripts/"
cp -a /mnt/haven-runtime/assets/. "$root/opt/assets/"
chmod +x "$root"/opt/scripts/*.sh
modprobe tun
for mount in dev sys; do
  if ! mountpoint -q "$root/$mount"; then
    mount --rbind "/$mount" "$root/$mount"
    mount --make-rslave "$root/$mount"
  fi
done
mountpoint -q "$root/proc" || mount -t proc proc "$root/proc"
mountpoint -q "$root/run" || mount -t tmpfs -o mode=755 tmpfs "$root/run"

if [ -L "$root/workspace" ]; then
  unlink "$root/workspace"
fi
mkdir -p "$root/workspace"
mountpoint -q "$root/workspace" || mount --bind /mnt/haven-workspace "$root/workspace"

rm -f "$root/run/claude-vm/ready" "$root/etc/resolv.conf"
cp -L /etc/resolv.conf "$root/etc/resolv.conf"
umask 077
printf '%s' "$proxy" | base64 -d > "$root/opt/config/clash.yaml"

systemd-run --unit=claude-haven-desktop --collect --property=KillMode=control-group \
  /usr/sbin/chroot "$root" /usr/bin/env \
  "TUN_NODE=$node" "HAVEN_TIMEZONE=$timezone" "LANG=$lang" "LC_ALL=$lang" \
  "CHROME_LANG=$chrome" NET_GUARD=strict NET_GUARD_STRICT_REGION=1 INPUT_METHOD=rime \
  NOVNC_BIND=127.0.0.1 NOVNC_PORT=6080 /opt/scripts/entrypoint.sh
