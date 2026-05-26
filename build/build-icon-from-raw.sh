#!/usr/bin/env bash
# Build build/icon.icns from build/raw-icon.jpg (or .png).
# Square-crops the source from the center, scales to 1024, and emits the iconset.
set -euo pipefail
cd "$(dirname "$0")"

SRC=""
for ext in png jpg jpeg; do
  if [ -f "raw-icon.$ext" ]; then SRC="raw-icon.$ext"; break; fi
done
if [ -z "$SRC" ]; then
  echo "no raw-icon.png|jpg|jpeg found in build/"; exit 1
fi
echo "source: $SRC"

# If source is JPEG, convert to PNG first so sips behaves consistently.
if [[ "$SRC" == *.jpg || "$SRC" == *.jpeg ]]; then
  sips -s format png "$SRC" --out raw-icon-converted.png >/dev/null
  SRC="raw-icon-converted.png"
fi

# Read source dimensions
W=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/{print $2}')
SIDE=$((W < H ? W : H))
OFFX=$(( (W - SIDE) / 2 ))
OFFY=$(( (H - SIDE) / 2 ))

# Center-crop to a square
sips -s format png -c "$SIDE" "$SIDE" --cropOffset "$OFFY" "$OFFX" "$SRC" --out icon-square.png >/dev/null
# Scale to 1024
sips -s format png -z 1024 1024 icon-square.png --out icon-1024.png >/dev/null

ICONSET="icon.iconset"
rm -rf "$ICONSET" icon.icns
mkdir -p "$ICONSET"

for SIZE in 16 32 64 128 256 512 1024; do
  sips -z $SIZE $SIZE icon-1024.png --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
done
sips -z 32 32     icon-1024.png --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 64 64     icon-1024.png --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 256 256   icon-1024.png --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 512 512   icon-1024.png --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 1024 1024 icon-1024.png --out "$ICONSET/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET"
rm -rf "$ICONSET" icon-1024.png icon-square.png raw-icon-converted.png
echo "wrote $(pwd)/icon.icns"
