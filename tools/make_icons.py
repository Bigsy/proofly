#!/usr/bin/env python3
"""Generate Proofly's toolbar icons: a white "P" with a wavy proofreading
squiggle under it, on the indigo->violet brand gradient with rounded corners.

No external dependencies — shapes are drawn geometrically and supersampled
(SS x SS per pixel) so edges come out smooth after downsampling.

    python3 tools/make_icons.py
"""

import math
import os
import struct
import zlib

SS = 4  # supersampling factor

# brand palette
INDIGO = (99, 102, 241)
VIOLET = (139, 92, 246)
WHITE = (255, 255, 255)
SQUIGGLE = (255, 92, 92)  # coral-red, like the error underline

# geometry, all in normalized [0,1] icon space
MARGIN = 0.06
CORNER = 0.22

STEM_L, STEM_R = 0.34, 0.47
STEM_T, STEM_B = 0.20, 0.80
BOWL_CX, BOWL_CY = 0.47, 0.355
BOWL_OUTER, BOWL_INNER = 0.215, 0.105

SQ_BASE = 0.875
SQ_AMP = 0.05
SQ_X0, SQ_X1 = 0.22, 0.78
SQ_HALF = 0.038
SQ_WAVES = 2


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def inside_round_rect(u, v):
    half = 0.5 - MARGIN
    qx = abs(u - 0.5) - (half - CORNER)
    qy = abs(v - 0.5) - (half - CORNER)
    d = math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - CORNER
    return d <= 0.0


def in_p(u, v):
    in_stem = STEM_L <= u <= STEM_R and STEM_T <= v <= STEM_B
    d = math.hypot(u - BOWL_CX, v - BOWL_CY)
    in_bowl = BOWL_INNER <= d <= BOWL_OUTER and u >= STEM_L
    return in_stem or in_bowl


def in_squiggle(u, v):
    if not (SQ_X0 <= u <= SQ_X1):
        return False
    phase = (u - SQ_X0) / (SQ_X1 - SQ_X0) * SQ_WAVES * 2 * math.pi
    yc = SQ_BASE + SQ_AMP * math.sin(phase)
    return abs(v - yc) < SQ_HALF


def sample(u, v):
    """Return (r,g,b,a) for a single sub-pixel sample, or None if transparent."""
    if not inside_round_rect(u, v):
        return None
    if in_squiggle(u, v):
        return (*SQUIGGLE, 255)
    if in_p(u, v):
        return (*WHITE, 255)
    return (*lerp(INDIGO, VIOLET, (u + v) / 2), 255)


def render(size):
    pixels = bytearray(size * size * 4)
    for py in range(size):
        for px in range(size):
            # premultiplied accumulation for clean edge anti-aliasing
            sr = sg = sb = sa = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (px + (sx + 0.5) / SS) / size
                    v = (py + (sy + 0.5) / SS) / size
                    s = sample(u, v)
                    if s is None:
                        continue
                    r, g, b, a = s
                    sr += r * a
                    sg += g * a
                    sb += b * a
                    sa += a
            n = SS * SS
            out_a = sa // n
            if sa > 0:
                r, g, b = sr // sa, sg // sa, sb // sa
            else:
                r = g = b = 0
            i = (py * size + px) * 4
            pixels[i:i + 4] = bytes((r, g, b, out_a))
    return pixels


def write_png(path, size, pixels):
    def chunk(typ, data):
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        raw += pixels[y * size * 4:(y + 1) * size * 4]

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 48, 128):
        write_png(os.path.join(out, f"icon{size}.png"), size, render(size))
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
