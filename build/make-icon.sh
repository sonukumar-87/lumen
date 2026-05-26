#!/usr/bin/env bash
# Generate a minimal Lumen.icns from an inline PNG of the triangle mark.
# Run once: ./build/make-icon.sh from the lumen/ directory.
set -euo pipefail
cd "$(dirname "$0")"

# Make a simple 1024x1024 PNG using ImageMagick if available, else fall back to
# a tiny embedded base64 PNG (a blue gradient triangle).

ICONSET="icon.iconset"
rm -rf "$ICONSET" icon.icns
mkdir -p "$ICONSET"

if command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then
  # ImageMagick path — render a clean SVG triangle.
  CMD="magick"; command -v magick >/dev/null 2>&1 || CMD="convert"
  $CMD -size 1024x1024 xc:'#0e1018' \
    -fill '#7aa2ff' -draw 'polygon 512,180 880,820 144,820' \
    -blur 0x6 \
    -fill '#7aa2ff' -draw 'polygon 512,200 860,800 164,800' \
    icon-1024.png
else
  # Fallback: tiny base64 PNG (just a flat blue square, 1024x1024).
  python3 - <<'PY'
import struct, zlib, base64
W = H = 1024
def chunk(t, d):
  return struct.pack('>I',len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)
sig = b'\x89PNG\r\n\x1a\n'
ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)  # 8-bit RGB
raw = b''
for _ in range(H):
  raw += b'\x00' + bytes([0x7a,0xa2,0xff]) * W
idat = zlib.compress(raw, 9)
png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
open('icon-1024.png','wb').write(png)
PY
fi

for SIZE in 16 32 64 128 256 512 1024; do
  sips -z $SIZE $SIZE icon-1024.png --out "$ICONSET/icon_${SIZE}x${SIZE}.png" >/dev/null
done
# Retina variants
sips -z 32 32     icon-1024.png --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 64 64     icon-1024.png --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 256 256   icon-1024.png --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 512 512   icon-1024.png --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 1024 1024 icon-1024.png --out "$ICONSET/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET"
rm -rf "$ICONSET" icon-1024.png
echo "wrote $(pwd)/icon.icns"
