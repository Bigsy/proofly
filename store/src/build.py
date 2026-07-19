#!/usr/bin/env python3
"""Build Chrome Web Store assets: promo tiles + 1280x800 screenshots.

Composes SVGs that embed the real UI captures (store/work/ui-*.png) and the
icon, renders them with rsvg-convert at exact store dimensions, then flattens
to 24-bit PNG (no alpha) with ImageMagick.
"""
import base64
import pathlib
import subprocess

SRC = pathlib.Path(__file__).resolve().parent
STORE = SRC.parent
WORK = STORE / "work"

BG = "#0f1117"
PANEL = "#171a23"
BORDER = "#2a2f3d"
TEXT = "#e6e8ee"
MUTED = "#9aa0b4"
ACCENT = "#6366f1"
ACCENT2 = "#8b5cf6"
CORAL = "#fb7185"
FONT = "Helvetica Neue"


def b64(path):
    return base64.b64encode(pathlib.Path(path).read_bytes()).decode()


def render(name, w, h, body, flatten=True):
    svg = f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">{body}</svg>'
    svg_path = WORK / f"{name}.svg"
    svg_path.write_text(svg)
    raw = WORK / f"{name}-raw.png"
    subprocess.run(["rsvg-convert", "-w", str(w), "-h", str(h), str(svg_path), "-o", str(raw)], check=True)
    out = STORE / f"{name}.png"
    if flatten:
        subprocess.run(["magick", str(raw), "-background", BG, "-alpha", "remove",
                        "-alpha", "off", f"PNG24:{out}"], check=True)
    else:
        subprocess.run(["cp", str(raw), str(out)], check=True)
    print(f"built {out.name} ({w}x{h})")


def defs(extra=""):
    return f"""<defs>
      <radialGradient id="glowA" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="{ACCENT}" stop-opacity="0.32"/>
        <stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glowB" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="{ACCENT2}" stop-opacity="0.26"/>
        <stop offset="1" stop-color="{ACCENT2}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#818cf8"/>
        <stop offset="1" stop-color="#a78bfa"/>
      </linearGradient>
      <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="14" stdDeviation="22" flood-color="#000000" flood-opacity="0.55"/>
      </filter>
      {extra}
    </defs>"""


def background(w, h, glows):
    """Dark bg + soft brand glows. glows = [(cx, cy, r, 'glowA'|'glowB'), ...]"""
    parts = [f'<rect width="{w}" height="{h}" fill="{BG}"/>']
    for cx, cy, r, g in glows:
        parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#{g})"/>')
    return "".join(parts)


def squiggle(x, y, halfwave, n, stroke=CORAL, width=6):
    """Smooth proofreading wave starting at (x, y), n half-waves."""
    d = f"M{x} {y} Q{x + halfwave / 2} {y - halfwave * 1.15} {x + halfwave} {y}"
    px = x + halfwave
    for _ in range(n - 1):
        px += halfwave
        d += f" T{px} {y}"
    return (f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{width}" '
            f'stroke-linecap="round"/>')


def panel_card(img64, x, y, scale, clip_h, cid, img_w=840, img_h=1520, r=16):
    """A UI capture in a rounded card with border + shadow, clipped to clip_h."""
    dw, dh = img_w * scale, img_h * scale
    return f"""
    <clipPath id="{cid}"><rect x="{x}" y="{y}" width="{dw:.0f}" height="{clip_h}" rx="{r}"/></clipPath>
    <rect x="{x}" y="{y}" width="{dw:.0f}" height="{clip_h}" rx="{r}" fill="{PANEL}" filter="url(#cardShadow)"/>
    <image x="{x}" y="{y}" width="{dw:.0f}" height="{dh:.0f}" clip-path="url(#{cid})"
           xlink:href="data:image/png;base64,{img64}"
           xmlns:xlink="http://www.w3.org/1999/xlink"/>
    <rect x="{x}" y="{y}" width="{dw:.0f}" height="{clip_h}" rx="{r}" fill="none"
          stroke="{BORDER}" stroke-width="1.5"/>"""


def pills(x, y, items):
    out, px = [], x
    for label in items:
        wpx = 26 + len(label) * 8.6
        out.append(f'<rect x="{px}" y="{y}" width="{wpx:.0f}" height="34" rx="17" '
                   f'fill="{PANEL}" stroke="{BORDER}" stroke-width="1.5"/>')
        out.append(f'<circle cx="{px + 17}" cy="{y + 17}" r="3.5" fill="#22c55e"/>')
        out.append(f'<text x="{px + 28}" y="{y + 22}" font-family="{FONT}" font-size="15" '
                   f'fill="#c7cad6">{label}</text>')
        px += wpx + 12
    return "".join(out)


def brand_row(icon64, x, y, icon_px=44, font_px=30):
    ty = y + icon_px / 2 + font_px * 0.35
    return f"""
    <image x="{x}" y="{y}" width="{icon_px}" height="{icon_px}"
           xlink:href="data:image/png;base64,{icon64}"
           xmlns:xlink="http://www.w3.org/1999/xlink"/>
    <text x="{x + icon_px + 14}" y="{ty:.0f}" font-family="{FONT}" font-weight="bold"
          font-size="{font_px}" fill="{TEXT}">Proofly</text>"""


icon64 = b64(WORK / "icon256.png")
ed64 = b64(WORK / "ui-editor.png")
co64 = b64(WORK / "ui-corrections.png")
li64 = b64(WORK / "ui-library.png")


# ---------------- small promo tile 440x280 ----------------
body = defs() + background(440, 280, [(120, 40, 320, "glowA"), (380, 280, 300, "glowB")])
body += f"""
  <image x="172" y="38" width="96" height="96"
         xlink:href="data:image/png;base64,{icon64}" xmlns:xlink="http://www.w3.org/1999/xlink"/>
  <text x="220" y="192" text-anchor="middle" font-family="{FONT}" font-weight="bold"
        font-size="46" fill="{TEXT}">Proofly</text>
  {squiggle(150, 208, 20, 7, width=5)}
  <text x="220" y="246" text-anchor="middle" font-family="{FONT}" font-size="17.5"
        fill="{MUTED}">Private, on-device proofreading</text>
"""
render("small-promo-440x280", 440, 280, body)


# ---------------- marquee 1400x560 ----------------
body = defs() + background(1400, 560, [(260, 80, 560, "glowA"), (1150, 520, 520, "glowB")])
body += f"""
  <image x="100" y="96" width="92" height="92"
         xlink:href="data:image/png;base64,{icon64}" xmlns:xlink="http://www.w3.org/1999/xlink"/>
  <text x="222" y="168" font-family="{FONT}" font-weight="bold" font-size="76"
        fill="{TEXT}">Proofly</text>
  {squiggle(226, 196, 23, 12, width=6)}
  <text x="102" y="282" font-family="{FONT}" font-weight="500" font-size="34"
        fill="{TEXT}">Private, on-device proofreading.</text>
  <text x="102" y="330" font-family="{FONT}" font-size="21" fill="{MUTED}">Grammar, spelling and punctuation fixes as you type —</text>
  <text x="102" y="360" font-family="{FONT}" font-size="21" fill="{MUTED}">powered by packaged Harper. Your text never leaves</text>
  <text x="102" y="390" font-family="{FONT}" font-size="21" fill="{MUTED}">your device.</text>
  {pills(102, 432, ["100% on-device", "No account needed", "Works offline"])}
"""
body += panel_card(ed64, 920, 64, 0.52, 600, "mq-ed")
render("marquee-1400x560", 1400, 560, body)


# ---------------- screenshots 1280x800 ----------------
def comp(name, img, headline, sub_lines, accent_under=None):
    body = defs() + background(1280, 800, [(220, 90, 520, "glowA"), (1130, 740, 480, "glowB")])
    body += brand_row(icon64, 84, 76)
    y = 300
    for i, line in enumerate(headline):
        body += (f'<text x="84" y="{y}" font-family="{FONT}" font-weight="bold" '
                 f'font-size="50" fill="{TEXT}">{line}</text>')
        y += 64
    if accent_under:
        ax, ay, n = accent_under
        body += squiggle(ax, ay, 16, n, width=5)
    y += 18
    for line in sub_lines:
        body += (f'<text x="84" y="{y}" font-family="{FONT}" font-size="21.5" '
                 f'fill="{MUTED}">{line}</text>')
        y += 33
    body += panel_card(img, 690, 70, 0.62, 800 - 70, f"sc-{name}")
    render(name, 1280, 800, body)


comp("screenshot-1-editor-1280x800", ed64,
     ["Proofread as you type.", "100% on-device."],
     ["Packaged Harper checks grammar, spelling and",
      "punctuation offline while you write. Your text never",
      "leaves your device."],
     accent_under=(84, 326, 14))

comp("screenshot-2-corrections-1280x800", co64,
     ["Review every fix.", "Apply in one click."],
     ["Choose between Harper’s alternative suggestions,",
      "then apply one fix or every selected correction",
      "at once."])

comp("screenshot-3-library-1280x800", li64,
     ["Your drafts, saved", "as you type."],
     ["A built-in notes library with search and export.",
      "Notes auto-save to local storage — on your",
      "machine, nowhere else."])

print("done")
