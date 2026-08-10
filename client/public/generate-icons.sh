#!/bin/bash
# Generate PWA icons from a base SVG or create a simple colored square

# Create a simple green energy icon as base
convert -size 512x512 xc:"#10b981" -gravity center \
  -pointsize 200 -font "DejaVu-Sans-Bold" -fill white \
  -annotate +0+0 "⚡" \
  icon-base.png 2>/dev/null || {
  # Fallback: create simple colored square with text
  convert -size 512x512 xc:"#10b981" -gravity center \
    -pointsize 200 -fill white \
    -annotate +0+0 "VPP" \
    icon-base.png
}

# Generate all required sizes
for size in 72 96 128 144 152 192 384 512; do
  convert icon-base.png -resize ${size}x${size} icons/icon-${size}x${size}.png
done

echo "PWA icons generated successfully!"
