#!/usr/bin/env bash
set -euo pipefail

project=$(cd "$(dirname "$0")/.." && pwd)
app="$project/src-tauri/target/release/bundle/macos/Claude Haven.app"
output="$project/../dist/Claude-Haven-macOS-arm64-compact.dmg"
staging=$(mktemp -d "${TMPDIR:-/tmp}/claude-haven-dmg.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT

[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'Apple Silicon Mac required' >&2; exit 1; }
(cd "$project" && npm run build)
ditto "$app" "$staging/Claude Haven.app"
ln -s /Applications "$staging/Applications"
mkdir -p "$(dirname "$output")"
hdiutil create -volname 'Claude Haven' -srcfolder "$staging" -format UDZO -imagekey zlib-level=9 -ov "$output"
echo "DMG: $output"
