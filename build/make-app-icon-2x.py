#!/usr/bin/env python3
"""把 app-icon.svg 的同一套几何导出成位图（系统窗口 / 安装包图标不能用 SVG）。

不读用户原图、不做裁切：圆角方块 + 橙色 `>` + 小方块 + 短横，参数与
claude-desktop/app/renderer/assets/app-icon.svg 一一对应。改图标时两边一起改。
输出：
  claude-desktop/build/icon.png                    electron-builder / exe / NSIS
  claude-desktop/app/renderer/assets/app-icon.png   BrowserWindow icon（随 asar 打包）
"""
import os
from PIL import Image, ImageDraw

OUT_BUILD = '/mnt/e/Web/FuckCladue/claude-desktop/build/icon.png'
OUT_APP = '/mnt/e/Web/FuckCladue/claude-desktop/app/renderer/assets/app-icon.png'
S = 512
DARK = (20, 20, 31, 255)      # #14141f
ORANGE = (240, 130, 90, 255)  # #f0825a


def draw(size):
    k = size / 512.0
    P = lambda v: int(round(v * k))
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=P(112), fill=DARK)

    # 橙色 `>`：折线 + 两端圆头（对应 SVG 的 stroke-linecap / linejoin）
    w = max(2, P(34))
    pts = [(P(150), P(190)), (P(242), P(256)), (P(150), P(322))]
    d.line(pts, fill=ORANGE, width=w, joint='curve')
    r = w / 2.0
    for x, y in (pts[0], pts[-1]):
        d.ellipse((x - r, y - r, x + r, y + r), fill=ORANGE)

    d.rounded_rectangle((P(322), P(158), P(380), P(216)), radius=P(16), fill=ORANGE)
    d.rounded_rectangle((P(252), P(286), P(370), P(312)), radius=P(13), fill=ORANGE)
    return im


for path, size in ((OUT_BUILD, 512), (OUT_APP, 256)):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    draw(size).save(path, 'PNG', optimize=True)
    print('%s  %dx%d  %d bytes' % (path, size, size, os.path.getsize(path)))
