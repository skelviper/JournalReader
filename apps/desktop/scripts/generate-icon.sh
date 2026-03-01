#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_SVG="$ROOT_DIR/build/icon.svg"
TMP_PNG="$ROOT_DIR/build/icon-1024.png"
ICONSET_DIR="$ROOT_DIR/build/icon.iconset"
OUT_ICNS="$ROOT_DIR/build/icon.icns"
OUT_PNG="$ROOT_DIR/build/icon.png"

if ! command -v sips >/dev/null 2>&1; then
  echo "sips is required on macOS." >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required on macOS." >&2
  exit 1
fi

if [ ! -f "$SRC_SVG" ]; then
  echo "missing icon source: $SRC_SVG" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/build"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

if ! sips -s format png "$SRC_SVG" --out "$TMP_PNG" >/dev/null 2>&1; then
  if ! command -v qlmanage >/dev/null 2>&1; then
    echo "failed to rasterize SVG with sips and qlmanage is unavailable" >&2
    exit 1
  fi
  TMP_DIR="$(mktemp -d)"
  qlmanage -t -s 1024 -o "$TMP_DIR" "$SRC_SVG" >/dev/null 2>&1
  QL_OUT="$TMP_DIR/$(basename "$SRC_SVG").png"
  if [ ! -f "$QL_OUT" ]; then
    rm -rf "$TMP_DIR"
    echo "failed to rasterize SVG with qlmanage" >&2
    exit 1
  fi
  cp "$QL_OUT" "$TMP_PNG"
  rm -rf "$TMP_DIR"
fi

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$TMP_PNG" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -z "$retina" "$retina" "$TMP_PNG" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$ICONSET_DIR" -o "$OUT_ICNS"
cp "$TMP_PNG" "$OUT_PNG"

rm -rf "$ICONSET_DIR"
rm -f "$TMP_PNG"

echo "generated: $OUT_ICNS"
echo "generated: $OUT_PNG"
