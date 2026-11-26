#!/usr/bin/env bash
# Keep the guest's supported browser languages and Chrome's software renderer.
set -euo pipefail
root=${1:?guest filesystem required}
here=$(dirname "$(realpath "$0")")
fonts="$here/../vm/assets/fonts"
install -D -m 644 "$fonts/NotoSansSC.ttf" "$root/usr/share/fonts/truetype/claude-sc/NotoSansSC.ttf"
install -D -m 644 "$fonts/NotoSansTC.ttf" "$root/usr/share/fonts/truetype/claude-tc/NotoSansTC.ttf"
# Librime can reuse a deployed table without the dictionary source. Keep the
# schema, customization, conversion files, and license alongside the table.
rime="$root/root/.local/share/fcitx5/rime"
for bin in table prism reverse; do
    test -s "$rime/build/wanxiang_pure.$bin.bin"
done
find "$rime" -type f -name '*.dict.yaml' -delete
chrome_locales="$root/opt/google/chrome/locales"
if [[ -d $chrome_locales ]]; then
    find "$chrome_locales" -maxdepth 1 -type f \
        ! -name 'en-US*' ! -name 'en-GB*' ! -name 'zh-CN*' ! -name 'zh-TW*' \
        ! -name 'ja*' ! -name 'de*' -delete
fi
# Omit Chrome's local AI acceleration libraries from this virtual desktop.
rm -f "$root"/opt/google/chrome/lib{LiteRtWebGpuAccelerator,optimization_guide_internal}.so
# The desktop uses Adwaita and the app's own icons.
rm -rf "$root"/usr/share/icons/{Humanity,Humanity-Dark,ubuntu-mono-light,ubuntu-mono-dark}
# The guest uses TigerVNC instead of a virtual GPU. Chrome ships SwiftShader.
# Keep the GL loader libraries Xvnc links against, and drop the unused drivers.
case $(uname -m) in
    aarch64) lib="$root/usr/lib/aarch64-linux-gnu" ;;
    x86_64) lib="$root/usr/lib/x86_64-linux-gnu" ;;
    *) echo "Unsupported Linux build architecture: $(uname -m)" >&2; exit 2 ;;
esac
rm -f "$lib"/dri/*_dri.so "$lib"/libvulkan_{broadcom,freedreno,lvp,panfrost,radeon}.so \
    "$lib/libLLVM-15.so.1"

# Node's dynamic symbols are still needed by native npm modules.
for node in "$root"/usr/local/lib/nodejs/*/bin/node; do
    [[ -f $node ]] || continue
    strip --strip-unneeded "$node"
done
