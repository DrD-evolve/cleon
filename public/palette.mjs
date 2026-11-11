// The colours and fonts JavaScript draws with. Each one is a token in style.css; app.js reads them through a hidden
// element (so var() and color-mix() come back resolved) and hands the strings to `buildPalette`. The values below are
// only what a token falls back to when the page cannot be read; test/palette.test.mjs keeps them equal to :root.
export const TOKENS = {
  bg: '--bg', surface2: '--surface-2', surface3: '--surface-3', surface4: '--surface-4',
  text: '--text', muted: '--muted', muted2: '--muted-2', ink: '--ink', onAccent: '--on-accent',
  accent: '--accent', attention: '--attention', working: '--working', ok: '--ok', danger: '--danger', flash: '--flash',
  cat1: '--cat1', cat2: '--cat2', cat3: '--cat3', cat4: '--cat4', cat5: '--cat5',
};
export const FALLBACK = {
  bg: '#04060c', surface2: '#050c18', surface3: '#0a1424', surface4: '#040810',
  text: '#cfe7ff', muted: '#6c84a3', muted2: '#96a5d2', ink: '#ffffff', onAccent: '#05070d',
  accent: '#3ef0ff', attention: '#ff4fd8', working: '#ffb547', ok: '#4dff9a', danger: '#ff5a6e', flash: '#ff8c3a',
  cat1: '#6f9dff', cat2: '#ff6fa8', cat3: '#35d0ae', cat4: '#b68cff', cat5: '#ffb85c',
};
export const FONTS = { ui: '--ui', data: '--data', display: '--display' };
export const FONT_FALLBACK = {
  ui: '"JetBrains Mono", ui-monospace, Consolas, monospace', data: '"JetBrains Mono", ui-monospace, Consolas, monospace',
  display: 'Orbitron, "JetBrains Mono", ui-monospace, Consolas, monospace',
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
  const scale = m[1] === 'color' ? 255 : 1;
  return [...parts.slice(0, 3).map(p => byte(num(p) * scale)), parts[3] === undefined ? 1 : alpha(num(parts[3]))];
}
export const toHex = ([r, g, b]) => `#${[r, g, b].map(n => byte(n).toString(16).padStart(2, '0')).join('')}`;
// As a canvas or CSS colour: #rrggbb when opaque, rgba() when the token is translucent.
export const toCss = ([r, g, b, a = 1]) => (a >= 1 ? toHex([r, g, b]) : `rgba(${byte(r)},${byte(g)},${byte(b)},${alpha(a)})`);

// The palette: every token as [r, g, b, a], its own alpha kept. `read(name)` gives the colour string for a palette name
// (see TOKENS); one that is missing or cannot be parsed takes today's value.
export function buildPalette(read) {
  const pal = {};
  for (const name of Object.keys(TOKENS)) pal[name] = parseColor(read(name)) ?? parseColor(FALLBACK[name]);
  return pal;
}
