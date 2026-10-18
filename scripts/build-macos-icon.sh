#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
stage=$(mktemp -d /tmp/harness-gateway-icon.XXXXXX)
mkdir -p assets/brand/macos "$stage/AppIcon.iconset"
magick -size 1024x1024 xc:none -fill '#F6F3EB' \
  -draw 'roundrectangle 88,88 936,936 190,190' \
  \( assets/brand/fox-master.png -resize 776x776 \) \
  -gravity center -geometry +0-5 -composite assets/brand/macos/app-icon.png
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" assets/brand/macos/app-icon.png \
    --out "$stage/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  twice=$((size * 2))
  sips -z "$twice" "$twice" assets/brand/macos/app-icon.png \
    --out "$stage/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$stage/AppIcon.iconset" -o assets/brand/macos/AppIcon.icns
printf 'Built the macOS icon from the existing fox. Working files: %s\n' "$stage"
