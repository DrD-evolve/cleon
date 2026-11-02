"""Draw the Cleon eye icon. Standard library only.

Writes assets/mission-control-radar.ico (16-256 px, for the desktop shortcut; the file keeps its old name
so the shortcut still finds it) and public/icon-192.png (the page's static icon). The dashboard animates
its own window icon at runtime (see app.js); this is the still version: an all-seeing eye on the dark
plate - a cyan almond outline, a cyan iris ring and a dark pupil with a glint. Small sizes use heavier
strokes and a bigger iris so it still reads at 16 px.

Usage: python -I scripts/make-icon.py
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CYAN = (62, 240, 255)
# The eye is the overlap of two circles: lids meet at x = +-0.72 and open to y = +-0.40.
LID_C, LID_R = 0.448, 0.848


def over(dst, src, a):
    """Composite colour `src` at alpha `a` (0-1) over premultiplied-free RGBA `dst`."""
    if a <= 0:
        return dst
    r, g, b, da = dst
    out_a = a + da * (1 - a)
    mix = lambda s, d: (s * a + d * da * (1 - a)) / out_a if out_a else 0
    return (mix(src[0], r), mix(src[1], g), mix(src[2], b), out_a)


def band(d, width):
    """1 inside a stroke of `width` centred on distance 0, soft-edged."""
    return max(0.0, min(1.0, (width / 2 - abs(d)) * 40 + 0.5))


def sample(x, y, small):
    """Colour of the icon at normalised coordinates x, y in [-1, 1]."""
    px = (0, 0, 0, 0)
    # Rounded-square plate (Windows 11 style), dark navy, a touch lighter at the top.
    q = max(abs(x), abs(y)) - 0.62
    inside = (math.hypot(abs(x) - 0.62, abs(y) - 0.62) <= 0.32) if (abs(x) > 0.62 and abs(y) > 0.62) else q <= 0.32
    if not inside:
        return px
    t = (y + 1) / 2
    px = (10 - 5 * t, 22 - 10 * t, 40 - 18 * t, 1.0)
    sx, sy = (x * 0.92, y * 0.92) if small else (x, y)          # small sizes: the eye fills more of the plate
    lid = max(math.hypot(sx, sy - LID_C), math.hypot(sx, sy + LID_C)) - LID_R  # < 0 inside the eye
    w = 0.10 if small else 0.065                                # lid stroke width
    if lid < 0:
        px = over(px, (4, 14, 26), 0.95)                        # white of the eye, dark
    px = over(px, CYAN, 0.35 * max(0.0, 1 - abs(lid) / 0.16))   # lid glow
    px = over(px, CYAN, band(lid, w))                           # lid outline
    r = math.hypot(sx, sy)
    ir, iw = (0.30, 0.11) if small else (0.27, 0.075)           # iris radius and ring width
    if lid < 0:
        px = over(px, CYAN, 0.18 * max(0.0, min(1.0, (ir - r) * 40)))   # faint iris fill
        px = over(px, CYAN, band(r - ir, iw))                           # iris ring
        px = over(px, CYAN, 0.3 * max(0.0, 1 - abs(r - ir) / 0.12))     # its glow
        px = over(px, (2, 6, 12), max(0.0, min(1.0, ((0.13 if small else 0.12) - r) * 60)))  # pupil
        if not small:
            g = math.hypot(sx + 0.05, sy + 0.05)
            px = over(px, (230, 255, 255), max(0.0, min(1.0, (0.035 - g) * 80)))  # glint
    return px


def render(n):
    small = n <= 24
    ss = 4 if n <= 64 else 2
    rows = []
    for j in range(n):
        row = bytearray()
        for i in range(n):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sj in range(ss):
                for si in range(ss):
                    x = ((i + (si + 0.5) / ss) / n) * 2 - 1
                    y = ((j + (sj + 0.5) / ss) / n) * 2 - 1
                    r, g, b, a = sample(x, y, small)
                    acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a
            k = ss * ss
            a = acc[3] / k
            row += bytes((int(acc[0] / acc[3]) if acc[3] else 0, int(acc[1] / acc[3]) if acc[3] else 0,
                          int(acc[2] / acc[3]) if acc[3] else 0, int(a * 255)))
        rows.append(bytes(row))
    return rows


def png(rows):
    n = len(rows)
    raw = b''.join(b'\x00' + r for r in rows)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def ico(images):
    head = struct.pack('<HHH', 0, 1, len(images))
    offset, entries = 6 + 16 * len(images), b''
    for n, data in images:
        entries += struct.pack('<BBBBHHII', n % 256, n % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return head + entries + b''.join(d for _, d in images)


if __name__ == '__main__':
    sizes = [16, 24, 32, 48, 64, 256]
    images = [(n, png(render(n))) for n in sizes]
    with open(os.path.join(ROOT, 'assets', 'mission-control-radar.ico'), 'wb') as f:
        f.write(ico(images))
    with open(os.path.join(ROOT, 'public', 'icon-192.png'), 'wb') as f:
        f.write(png(render(192)))
    print('wrote assets/mission-control-radar.ico and public/icon-192.png')
