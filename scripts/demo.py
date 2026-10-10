"""Draws docs/demo.gif and docs/cache.png: a Claude Code session with the smart-compact band.

The band follows hooks/register.tsx (lead, reason, context, two buttons) and its texts are the
mod's own, so the demo cannot drift far from what the mod draws.
Needs Pillow and ffmpeg. Run from the repo root: python scripts/demo.py
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
W, H = 1280, 560
SIZE = 15
FONTS = Path("C:/Windows/Fonts")

BG = "#0e0e10"
FG = "#d4d4d8"
DIM = "#71717a"
FAINT = "#3f3f46"
GREEN = "#4ade80"
YELLOW = "#facc15"
CLAUDE = "#d97757"
PRESSED = "#27272a"

mono = ImageFont.truetype(str(FONTS / "CascadiaMono.ttf"), SIZE)
bold = ImageFont.truetype(str(FONTS / "CascadiaMono.ttf"), SIZE)
bold.set_variation_by_name("Bold")
CW = mono.getlength("M")
LH = round(SIZE * 1.55)
COLS = int((W - 56) / CW)


def elbow(d, x, y, color, width):
    d.line((x + 2, y + 2, x + 2, y + 13, x + CW, y + 13), fill=color, width=width, joint="curve")


DRAWN = {"⎿": elbow}


def draw_text(d, x, y, text, color=FG, strong=False):
    """One cell per character, so columns line up whatever draws the glyph."""
    for i, ch in enumerate(text):
        if ch in DRAWN:
            DRAWN[ch](d, x + i * CW, y, color, 2 if strong else 1)
        else:
            d.text((x + i * CW, y), ch, font=bold if strong else mono, fill=color)
    return x + len(text) * CW


def spans(d, x, y, parts):
    for text, color, strong in parts:
        x = draw_text(d, x, y, text, color, strong)
    return x


def button(d, x, y, label, pressed=False):
    text = f"[ {label} ]"
    if pressed:
        d.rectangle((x - 2, y - 1, x + len(text) * CW + 2, y + LH - 4), fill=PRESSED)
    return draw_text(d, x, y, text, FG if pressed else DIM, pressed)


# The band, as the ui.render hook on AbovePrompt lays it out: one row, gap 1.
def band(d, x, y, lead, reason, percent, pressed):
    x = spans(d, x, y, [(lead, FG, True), (f" · {reason} · context {percent}%", DIM, False)])
    x = button(d, x + CW, y, "Compact now", pressed)
    button(d, x + CW, y, "Not now")


def frame(state):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        d.ellipse((20 + i * 20, 18, 32 + i * 20, 30), fill=c)
    draw_text(d, W / 2 - 8 * CW, 14, "claude  ~/api", DIM)
    d.line((0, 46, W, 46), fill="#1c1c1f")

    y = 70
    for parts in state["transcript"]:
        spans(d, 28, y, parts)
        y += LH

    if state.get("band"):
        band(d, 28, H - 130, *state["band"], state.get("pressed", False))

    d.rounded_rectangle((24, H - 92, W - 24, H - 50), radius=7, outline=FAINT)
    draw_text(d, 40, H - 82, "> " + state.get("typing", ""), FG)
    percent = state["percent"]
    color = YELLOW if percent >= 60 else DIM
    x = draw_text(d, 40, H - 38, f"context {percent}%", color)
    draw_text(d, x + 3 * CW, H - 38, "Opus 5.5 · ~/api", FAINT)
    return img


def main():
    if shutil.which("ffmpeg") is None:
        sys.exit("demo.py needs ffmpeg on PATH")

    ask = "finish the session-token refactor and commit it"
    user = [("> " + ask, FG, False)]
    blank = [("", FG, False)]
    ran = [
        [("  … 212 earlier messages", FAINT, False)],
        blank,
        user,
        blank,
        [("● ", CLAUDE, False), ("Bash", FG, True), ("(pnpm exec vitest run)", DIM, False)],
        [("  ⎿  ", DIM, False), ("Tests  84 passed (84)", GREEN, False)],
        [("● ", CLAUDE, False), ("Bash", FG, True), ('(git commit -m "refactor: rotate session tokens")', DIM, False)],
        [("  ⎿  ", DIM, False), ("[main 3f9c2a1] refactor: rotate session tokens", DIM, False)],
    ]
    asked = ran + [
        [("● ", CLAUDE, False), ("smart-compact - request_compact", FG, True), ("(reason: \"token refactor shipped\",", DIM, False)],
        [("    instructions: \"keep the open TODO on refresh-token reuse\")", DIM, False)],
        [("  ⎿  ", DIM, False), ("Queued at 74% context. The person will be offered a one-click compact", DIM, False)],
        [("     when this turn ends.", DIM, False)],
        blank,
        [("● ", FG, False), ("Committed as 3f9c2a1. All 84 tests pass. One TODO left: refresh-token reuse.", FG, False)],
    ]
    compacted = [
        [("✻ ", CLAUDE, False), ("Conversation compacted", FG, True), (" · kept: the open TODO on refresh-token reuse", DIM, False)],
        blank,
        [("● ", FG, False), ("Committed as 3f9c2a1. One TODO left: refresh-token reuse.", FG, False)],
    ]
    claude_band = ("Claude wants to compact", "token refactor shipped", 74)

    states = []
    for n in range(0, len(ask) + 1, 8):
        states.append(({"transcript": ran[:2], "typing": ask[:n], "percent": 71}, 0.08))
    states.append(({"transcript": ran[:6], "percent": 72}, 0.8))
    states.append(({"transcript": ran, "percent": 73}, 0.8))
    states.append(({"transcript": asked[:12], "percent": 74}, 1.2))
    states.append(({"transcript": asked, "percent": 74}, 0.6))
    poster = len(states)
    states.append(({"transcript": asked, "percent": 74, "band": claude_band}, 2.6))
    states.append(({"transcript": asked, "percent": 74, "band": claude_band, "pressed": True}, 0.5))
    states.append(({"transcript": compacted, "percent": 9}, 3.4))

    docs = ROOT / "docs"
    out = docs / "demo.gif"
    frame(states[poster][0]).save(docs / "demo.png")
    cache = {
        "transcript": [
            [("  … 188 earlier messages", FAINT, False)],
            blank,
            [("● ", FG, False), ("The migration is written; review it whenever you're back.", FG, False)],
        ],
        "percent": 72,
        "band": ("Good moment to compact", "Prompt cache expires in ~1 min, then 144k tokens re-send at full price", 72),
    }
    frame(cache).save(docs / "cache.png")

    with tempfile.TemporaryDirectory() as tmp:
        listing = []
        for i, (state, seconds) in enumerate(states):
            path = Path(tmp) / f"f{i:03}.png"
            frame(state).save(path)
            listing += [f"file '{path.as_posix()}'", f"duration {seconds}"]
        listing.append(f"file '{(Path(tmp) / f'f{len(states) - 1:03}.png').as_posix()}'")
        (Path(tmp) / "list.txt").write_text("\n".join(listing))
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(Path(tmp) / "list.txt"),
             "-vf", "split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none", "-loop", "0", str(out)],
            check=True,
        )
    print(f"{out.relative_to(ROOT)}  {out.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    main()
