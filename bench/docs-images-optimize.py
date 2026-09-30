#!/usr/bin/env python3
"""docs-images-optimize.py -- low-loss PNG compression per screenshot.

Usage: docs-images-optimize.py <target-dir> <raw1.png> <raw2.png> ...

Each <name>.raw.png is optimized to <name>.png (no .raw):
1. First try: PNG, optimize=True (lossless, usually already smaller).
2. If that is not under 400 KB: reduce the palette to 256/192/128/96/64
   colors (adaptive palette, no dithering, for crisp UI edges).
3. If even 64 colors is not enough (heavy noise/gradient from the 3D
   network): fall back to lossy WebP at a descending quality until it
   fits. The .raw.png is always removed at the end.
"""
import sys
import os
from PIL import Image

TARGET_BYTES = 400 * 1024


def optimize(raw_path, png_out_path):
    im = Image.open(raw_path).convert("RGBA")
    # X9 (2026-09-30): if the image already exists as .webp in the folder
    # (the README points at it), it stays WebP -- otherwise it flips
    # between PNG and WebP from run to run and the link dangles.
    webp_out = png_out_path[: -len(".png")] + ".webp"
    if os.path.exists(webp_out):
        for quality in (82, 72, 62, 52, 42):
            im.convert("RGB").save(webp_out, format="WEBP", quality=quality, method=6)
            size = os.path.getsize(webp_out)
            if size <= TARGET_BYTES:
                break
        return webp_out, size, f"WebP quality {quality} (stayed WebP as in the existing set)"
    has_alpha = im.getchannel("A").getextrema() != (255, 255)
    base = im if has_alpha else im.convert("RGB")
    base.save(png_out_path, format="PNG", optimize=True)
    size = os.path.getsize(png_out_path)
    if size <= TARGET_BYTES:
        return png_out_path, size, "PNG, lossless"
    for colors in (256, 192, 128, 96, 64):
        pal = im.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=colors)
        pal.save(png_out_path, format="PNG", optimize=True)
        size = os.path.getsize(png_out_path)
        if size <= TARGET_BYTES:
            return png_out_path, size, f"PNG, {colors}-color palette"
    webp_out_path = png_out_path[: -len(".png")] + ".webp"
    for quality in (82, 72, 62, 52, 42):
        im.convert("RGB").save(webp_out_path, format="WEBP", quality=quality, method=6)
        size = os.path.getsize(webp_out_path)
        if size <= TARGET_BYTES:
            os.remove(png_out_path)
            return webp_out_path, size, f"WebP quality {quality} (palette alone was not enough)"
    os.remove(png_out_path)
    return webp_out_path, size, f"WebP quality 42 (still {size} bytes)"


def main():
    target_dir = sys.argv[1]
    files = sys.argv[2:]
    for raw_path in files:
        if not os.path.isabs(raw_path):
            raw_path = os.path.join(target_dir, raw_path)
        assert raw_path.endswith(".raw.png"), raw_path
        png_out_path = raw_path[: -len(".raw.png")] + ".png"
        final_path, size, method = optimize(raw_path, png_out_path)
        os.remove(raw_path)
        print(f"FINAL {os.path.basename(final_path)}: {size/1024:.1f} KB ({method})")


if __name__ == "__main__":
    main()
