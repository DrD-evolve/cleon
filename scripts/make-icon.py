"""Draw the Mission Control radar icon. Standard library only.

Writes assets/mission-control-radar.ico (16-256 px, for the desktop shortcut) and public/icon-192.png
(the page's static icon). The dashboard animates its own tab icon at runtime (see app.js); this is the
still version: a scope with range rings, a fading sweep wedge, and three blips in the dashboard's
state colors - cyan (running), amber (background work), magenta (needs you). Small sizes drop to
ring + sweep + the magenta blip so it still reads at 16 px.

Usage: python -I scripts/make-icon.py
"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CYAN, AMBER, MAGENTA = (62, 240, 255), (255, 181, 71), (255, 79, 216)
SWEEP_AT = math.radians(-50)   # leading edge, pointing up-right (screen y grows downward)
SWEEP_SPAN = math.radians(95)  # the wedge fades out over this angle behind the edge


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
    corner = math.hypot(max(abs(x) - 0.62, 0), max(abs(y) - 0.62, 0))
    inside = corner <= 0.32 if (abs(x) > 0.62 and abs(y) > 0.62) else q <= 0.32
    if not inside:
        return px
    t = (y + 1) / 2
    px = (10 - 5 * t, 22 - 10 * t, 40 - 18 * t, 1.0)
    r, a = math.hypot(x, y), math.atan2(y, x)
    R = 0.78
    if r <= R:
        px = over(px, (4, 14, 26), 0.9)                                    # scope face
        behind = (SWEEP_AT - a) % (2 * math.pi)                             # angle behind the edge
        if behind < SWEEP_SPAN:
            px = over(px, CYAN, (0.9 if small else 0.78) * (1 - behind / SWEEP_SPAN))  # fading wedge
        if not small:
            for rr in (0.27, 0.52):
                px = over(px, CYAN, 0.35 * band(r - rr, 0.022))             # inner range rings
            px = over(px, CYAN, 0.22 * band(x, 0.016) + 0.22 * band(y, 0.016))  # crosshair
        # leading edge of the sweep
        edge = abs(math.sin(a - SWEEP_AT)) * r
        if math.cos(a - SWEEP_AT) > 0:
            px = over(px, CYAN, 0.95 * band(edge, 0.03 if not small else 0.06))
    px = over(px, CYAN, band(r - R, 0.05 if not small else 0.09))           # outer ring
    px = over(px, CYAN, 0.25 * max(0.0, 1 - abs(r - R) / 0.14))             # its glow

    def blip(cx, cy, rad, col, halo):
        nonlocal px
        d = math.hypot(x - cx, y - cy)
        px = over(px, col, halo * max(0.0, 1 - d / (rad * 2.4)))            # glow
        px = over(px, col, max(0.0, min(1.0, (rad - d) * 60)))              # dot

    if not small:
        blip(-0.40, 0.24, 0.055, AMBER, 0.45)
        blip(0.16, 0.44, 0.05, CYAN, 0.45)
        blip(0.0, 0.0, 0.035, CYAN, 0.0)                                    # centre
    blip(0.30, -0.36, 0.085 if not small else 0.15, MAGENTA, 0.6)           # needs you
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
