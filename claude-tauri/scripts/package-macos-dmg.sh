#!/usr/bin/env bash
set -euo pipefail

project=$(cd "$(dirname "$0")/.." && pwd)
app="$project/src-tauri/target/release/bundle/macos/Claude Haven.app"
host_arch=$(uname -m)
case "$host_arch" in
  arm64) package_arch=arm64 ;;
  x86_64) package_arch=x64 ;;
  *) echo "Unsupported Mac architecture: $host_arch" >&2; exit 1 ;;
esac
output="$project/../dist/Claude-Haven-macOS-${package_arch}-compact.dmg"
staging=$(mktemp -d "${TMPDIR:-/tmp}/claude-haven-dmg.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT

[[ $(uname -s) == Darwin ]] || { echo 'macOS host required' >&2; exit 1; }
(cd "$project" && npm run build)
ditto "$app" "$staging/Claude Haven.app"
ln -s /Applications "$staging/Applications"
mkdir -p "$(dirname "$output")"
hdiutil create -volname 'Claude Haven' -srcfolder "$staging" -format UDZO -imagekey zlib-level=9 -ov "$output"
echo "DMG: $output"
