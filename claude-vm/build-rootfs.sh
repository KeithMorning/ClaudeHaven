#!/usr/bin/env bash
# 用法: bash build-rootfs.sh [构建上下文] [输出路径] [linux/amd64|linux/arm64]
set -euo pipefail

# 默认路径按脚本自身位置推导，换机器/换盘符不用改脚本
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTX="${1:-$HERE/vm}"
PLATFORM="${3:-linux/amd64}"
IMAGE_VERSION=$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$HERE/../claude-tauri/package.json")
if [[ ! "$IMAGE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]]; then
  echo "无法读取 Claude Haven 镜像版本。" >&2
  exit 1
fi
case "$PLATFORM" in
  linux/amd64)
    OUT="${2:-$HERE/../claude-tauri/runtime/rootfs.tar.gz}"
    IMG="claude-vm:runtime"
    ;;
  linux/arm64)
    OUT="${2:-$HERE/../dist/rootfs-linux-arm64.tar.gz}"
    IMG="claude-vm:runtime-arm64"
    ;;
  *) echo "不支持的目标架构：$PLATFORM" >&2; exit 1 ;;
esac
if [ "$PLATFORM" = linux/arm64 ] && [ "${OUT##*/}" = rootfs.tar.gz ]; then
  echo "请为 ARM64 镜像使用不同的文件名，例如 rootfs-linux-arm64.tar.gz。" >&2
  exit 1
fi

echo "[1/4] 构建 $PLATFORM 镜像 $IMG (上下文: $CTX)"
if [ "$PLATFORM" = linux/amd64 ] && ! docker buildx version >/dev/null 2>&1; then
  DOCKER_BUILDKIT=0 docker build --platform "$PLATFORM" --build-arg TARGETARCH=amd64 --build-arg HAVEN_IMAGE_VERSION="$IMAGE_VERSION" -t "$IMG" "$CTX"
else
  docker buildx build --platform "$PLATFORM" --build-arg HAVEN_IMAGE_VERSION="$IMAGE_VERSION" --load -t "$IMG" "$CTX"
fi
ACTUAL=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMG")
if [ "$ACTUAL" != "$PLATFORM" ]; then
  echo "镜像架构不符：要求 $PLATFORM，实际 $ACTUAL" >&2
  exit 1
fi

echo "[2/4] 创建临时容器"
mkdir -p "$(dirname "$OUT")"
TMP=$(mktemp "${OUT}.part.XXXXXXXX")
CID=
cleanup() {
  if [ -n "$CID" ]; then docker rm "$CID" >/dev/null 2>&1 || true; fi
  if [ -n "$TMP" ]; then rm -f -- "$TMP"; fi
}
trap cleanup EXIT
CID=$(docker create --platform "$PLATFORM" "$IMG")

echo "[3/4] 导出文件系统 → $OUT (gzip)"
docker export "$CID" | gzip -1 > "$TMP"
mv -f -- "$TMP" "$OUT"
TMP=

echo "[4/4] 导出完成"
ls -lh "$OUT"
