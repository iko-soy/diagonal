#!/usr/bin/env python3
"""Renders icons/icon.png to the PNG sizes the manifest lists. Needs Pillow (python3 -m pip install pillow).

The source is the full-size app icon. Its transparent margin is trimmed first so the rounded square fills the
16 and 32 px toolbar icons; the larger sizes keep a little padding, as Chrome's extension page expects.
"""
from pathlib import Path

from PIL import Image, ImageFilter

ICONS = Path(__file__).resolve().parent.parent / "icons"
# size -> padding in px on each side at that size
SIZES = {16: 0, 32: 0, 48: 2, 128: 8}


def trimmed(src: Image.Image) -> Image.Image:
    # Near-invisible specks around the shape would otherwise widen the bounding box.
    solid = src.getchannel("A").point(lambda a: 255 if a > 32 else 0)
    left, top, right, bottom = solid.getbbox()
    side = max(right - left, bottom - top)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    box = (round(cx - side / 2), round(cy - side / 2), round(cx + side / 2), round(cy + side / 2))
    return src.crop(box)


def render(art: Image.Image, size: int, pad: int) -> Image.Image:
    inner = size - 2 * pad
    small = art.resize((inner, inner), Image.LANCZOS)
    if inner <= 32:
        small = small.filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=0))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(small, (pad, pad))
    return out


def main() -> None:
    art = trimmed(Image.open(ICONS / "icon.png").convert("RGBA"))
    for size, pad in SIZES.items():
        render(art, size, pad).save(ICONS / f"{size}.png", optimize=True)
    print("icons written")


if __name__ == "__main__":
    main()
