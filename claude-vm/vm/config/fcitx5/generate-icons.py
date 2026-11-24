"""Generate the small Fcitx tray labels; run with Pillow when the labels change."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent / "icons"
HERE.mkdir(exist_ok=True)
FONT_EN = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
for name, label in (
    ("haven-ime-en", "EN"),
    ("fcitx-rime-latin", "EN"),
    ("fcitx-rime", "中"),
):
    image = Image.new("RGBA", (128, 128))
    draw = ImageDraw.Draw(image)
    if label == "中":
        # A geometric glyph remains legible after tint2 scales it to 20 px.
        draw.rectangle((27, 38, 101, 90), outline="#f4e9df", width=11)
        draw.line((64, 21, 64, 107), fill="#f4e9df", width=12)
    else:
        font = ImageFont.truetype(FONT_EN, 69)
        box = draw.textbbox((0, 0), label, font=font)
        draw.text(((128 - (box[2] - box[0])) / 2 - box[0],
                   (128 - (box[3] - box[1])) / 2 - box[1]),
                  label, font=font, fill="#f4e9df")
    image.resize((48, 48), Image.LANCZOS).save(HERE / f"{name}.png")
