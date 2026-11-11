// The colours and fonts JavaScript draws with. Each one is a token in style.css; app.js reads them through a hidden
// element (so var() and color-mix() come back resolved) and hands the strings to `buildPalette`. The values below are
// only what a token falls back to when the page cannot be read; test/palette.test.mjs keeps them equal to the default theme (Horizon).
export const TOKENS = {
  bg: '--bg', surface2: '--surface-2', surface3: '--surface-3', surface4: '--surface-4',
  text: '--text', muted: '--muted', muted2: '--muted-2', ink: '--ink', onAccent: '--on-accent',
  accent: '--accent', attention: '--attention', working: '--working', ok: '--ok', danger: '--danger', flash: '--flash',
  cat1: '--cat1', cat2: '--cat2', cat3: '--cat3', cat4: '--cat4', cat5: '--cat5',
};
export const FALLBACK = {
  bg: '#05070d', surface2: '#111726', surface3: '#161d2e', surface4: '#070a12',
  text: '#e8eeff', muted: '#8995af', muted2: '#aab4cf', ink: '#ffffff', onAccent: '#050a18',
  accent: '#6f9bff', attention: '#ff5fc4', working: '#ffc457', ok: '#4fe3a1', danger: '#ff6464', flash: '#9fbaff',
  cat1: '#b4d9e9', cat2: '#caadf0', cat3: '#37bebe', cat4: '#fabaa3', cat5: '#cae170',
};
export const FONTS = { ui: '--ui', data: '--data', display: '--display' };
export const FONT_FALLBACK = {
  ui: 'Inter, system-ui, sans-serif', data: '"JetBrains Mono", ui-monospace, Consolas, monospace',
  display: 'Saira, Inter, system-ui, sans-serif',
};

const byte = n => Math.max(0, Math.min(255, Math.round(n)));
const alpha = n => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
const num = s => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s));

// A CSS colour as [r, g, b, a] (0-255, 0-1), or null when there is none to read. Reads hex (3, 4, 6, 8 digits), rgb() and
// rgba() with commas or spaces, and color(srgb r g b / a), which is how a browser gives back a color-mix() result.
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (m) {
    const h = m[1].length < 6 ? [...m[1]].map(c => c + c).join('') : m[1];
    const p = i => parseInt(h.slice(i, i + 2), 16);
    return [p(0), p(2), p(4), h.length === 8 ? alpha(p(6) / 255) : 1];
  }
  m = v.match(/^(rgba?|color)\(\s*(?:srgb\s+)?([^)]*)\)$/);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4 || parts.some(p => !Number.isFinite(num(p)))) return null;
  // A channel in color() is 0-1 and in rgb() 0-255; as a percentage it is a share of 255 in both.
  const scale = m[1] === 'color' ? 255 : 1, channel = p => byte(num(p) * (p.endsWith('%') ? 255 : scale));
  return [...parts.slice(0, 3).map(channel), parts[3] === undefined ? 1 : alpha(num(parts[3]))];
}
export const toHex = ([r, g, b]) => `#${[r, g, b].map(n => byte(n).toString(16).padStart(2, '0')).join('')}`;
// As a canvas or CSS colour: #rrggbb when opaque, rgba() when the token is translucent.
export const toCss = ([r, g, b, a = 1]) => (a >= 1 ? toHex([r, g, b]) : `rgba(${byte(r)},${byte(g)},${byte(b)},${alpha(a)})`);
// A colour at an opacity, times the colour's own alpha; and a colour part-way (t, 0-1) to another, as #rrggbb.
export const withAlpha = (c, a) => { const [r, g, b, al] = parseColor(c); return toCss([r, g, b, Math.max(0, Math.min(1, a * al))]); };
export const mix = (a, b, t) => { const A = parseColor(a), B = parseColor(b), k = Math.max(0, Math.min(1, t)); return toHex(A.map((v, i) => v + (B[i] - v) * k)); };

// The palette: every token as [r, g, b, a], its own alpha kept. `read(name)` gives the colour string for a palette name
// (see TOKENS); one that is missing or cannot be parsed takes today's value.
export function buildPalette(read) {
  const pal = {};
  for (const name of Object.keys(TOKENS)) pal[name] = parseColor(read(name)) ?? parseColor(FALLBACK[name]);
  return pal;
}
