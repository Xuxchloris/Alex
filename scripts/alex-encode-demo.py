"""Encode actual Playwright captures; this script does not invent UI/browser frames.

Usage: python3 scripts/alex-encode-demo.py recording.json output_directory
Requires Pillow. The recording manifest supplies already labeled screenshots.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import shutil
import sys

from PIL import Image, ImageDraw, ImageFont


def encode(manifest_path: Path, output_directory: Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest["frames"]
    if not entries:
        raise ValueError("Recording has no actual screenshots")
    width = min(1000, int(manifest.get("width", 1000)))
    output_directory.mkdir(parents=True, exist_ok=True)
    captures: list[Image.Image] = []
    for entry in entries:
        with Image.open(entry["path"]) as screenshot:
            height = round(screenshot.height * width / screenshot.width)
            captures.append(screenshot.convert("RGB").resize((width, height), Image.Resampling.LANCZOS))
    durations = [int(entry["duration"]) for entry in entries]
    if not 8000 <= sum(durations) <= 15000:
        raise ValueError("Demo must run between 8 and 15 seconds")
    if len({capture.size for capture in captures}) != 1:
        raise ValueError("All screenshots must use the same viewport")

    # Independent adaptive palettes preserve clear Chinese text in each real UI
    # frame. A compact color count avoids gratuitously large repository assets.
    frames = [capture.quantize(colors=160, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for capture in captures]
    gif_path = output_directory / "alex-workbench.gif"
    frames[0].save(gif_path, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True, disposal=2)
    if gif_path.stat().st_size > 5 * 1024 * 1024:
        frames = [capture.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for capture in captures]
        frames[0].save(gif_path, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True, disposal=2)

    cover_index = next((index for index, entry in enumerate(entries) if entry.get("cover")), 0)
    # Preserve the original full-resolution screenshot for inspection and zoom.
    shutil.copyfile(entries[cover_index]["path"], output_directory / "alex-workbench-cover.png")

    columns, cell_width, padding, label_height = 3, 420, 18, 40
    thumb_width = cell_width - padding * 2
    thumb_height = round(captures[0].height * thumb_width / captures[0].width)
    cell_height = thumb_height + label_height + padding * 2
    rows = math.ceil(len(captures) / columns)
    sheet = Image.new("RGB", (columns * cell_width, rows * cell_height), "#f4f6ef")
    draw = ImageDraw.Draw(sheet)
    font_candidates = [Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    font_path = next((path for path in font_candidates if path.is_file()), None)
    font = ImageFont.truetype(str(font_path), 12) if font_path else ImageFont.load_default()
    for index, (capture, entry) in enumerate(zip(captures, entries)):
        x, y = (index % columns) * cell_width + padding, (index // columns) * cell_height + padding
        sheet.paste(capture.resize((thumb_width, thumb_height), Image.Resampling.LANCZOS), (x, y))
        caption = f"{index + 1:02d} · {entry['caption']}"
        # Contact sheet labels help audit the captured sequence; the full demo
        # marker is already present in every source screenshot, before encoding.
        while draw.textbbox((0, 0), caption, font=font)[2] > thumb_width:
            caption = caption[:-2] + "…"
        draw.text((x, y + thumb_height + 9), caption, font=font, fill="#526444")
    sheet.save(output_directory / "alex-workbench-contactsheet.png", optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: alex-encode-demo.py recording.json output_directory")
    encode(Path(sys.argv[1]), Path(sys.argv[2]))
