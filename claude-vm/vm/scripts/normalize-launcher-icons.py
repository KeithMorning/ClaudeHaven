"""Fit each launcher's visible artwork into the same centered square."""

import sys
from pathlib import Path

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf


def normalize(icon):
    source = GdkPixbuf.Pixbuf.new_from_file(str(icon)).add_alpha(False, 0, 0, 0)
    width, height = source.get_width(), source.get_height()
    stride, channels = source.get_rowstride(), source.get_n_channels()
    alpha = source.get_pixels()
    visible = [(x, y) for y in range(height) for x in range(width)
               if alpha[y * stride + x * channels + channels - 1] >= 32]
    if not visible:
        return source

    xs, ys = zip(*visible)
    left, top = min(xs), min(ys)
    art_width, art_height = max(xs) - left + 1, max(ys) - top + 1
    crop = source.new_subpixbuf(left, top, art_width, art_height)
    scale = 30 / max(art_width, art_height)
    fitted_width, fitted_height = max(1, round(art_width * scale)), max(1, round(art_height * scale))
    fitted = crop.scale_simple(fitted_width, fitted_height, GdkPixbuf.InterpType.BILINEAR)
    canvas = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, 32, 32)
    canvas.fill(0)
    fitted.copy_area(0, 0, fitted_width, fitted_height, canvas,
                     (32 - fitted_width) // 2, (32 - fitted_height) // 2)
    return canvas


if __name__ == "__main__":
    icons = Path(sys.argv[1])
    output = icons / "launcher"
    output.mkdir(exist_ok=True)
    for name in ("chrome.png", "claude.png", "terminal.png", "folder.png"):
        normalize(icons / name).savev(str(output / name), "png", [], [])
