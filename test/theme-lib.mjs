// Shared by the theme tests: the two token blocks of public/style.css as { name: value }, and colour maths (WCAG contrast,
// CIEDE2000 distance). Not a test itself.
import { readFile } from 'node:fs/promises';
import { parseColor } from '../public/palette.mjs';

export const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
export const BLOCK = {
  horizon: /^:root, :root\[data-theme="horizon"\] \{[\s\S]*?^\}/m,
  neon: /^:root\[data-theme="neon"\] \{[\s\S]*?^\}/m,
};
export const blockText = name => css.match(BLOCK[name])[0];
export const tokens = name => Object.fromEntries([...blockText(name).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));

// A token's colour as [r, g, b] over a backdrop colour (a translucent surface is laid over it first).
export function over(value, backdrop = [0, 0, 0]) {
  const [r, g, b, a] = parseColor(value);
  return [r, g, b].map((v, i) => v * a + backdrop[i] * (1 - a));
}
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a, b) => { const [A, B] = [lum(a), lum(b)]; return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05); };

export function lab(rgb) {
  const [r, g, b] = rgb.map(lin);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047, y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b, z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export function dE2000(c1, c2) {
  const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2), rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2, G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b, a) => { const h = Math.atan2(b, a) * deg; return h < 0 ? h + 360 : h; };
  const h1p = C1p ? hp(b1, a1p) : 0, h2p = C2p ? hp(b2, a2p) : 0;
  const dL = L2 - L1, dC = C2p - C1p;
  let dh = 0; if (C1p * C2p) { dh = h2p - h1p; if (dh > 180) dh -= 360; if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh * rad / 2), Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hb = h1p + h2p; if (C1p * C2p) hb = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dt = 30 * Math.exp(-(((hb - 275) / 25) ** 2)), Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + 0.015 * (Lb - 50) ** 2 / Math.sqrt(20 + (Lb - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T, Rt = -Math.sin(2 * dt * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}
