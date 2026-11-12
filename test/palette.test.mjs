import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseColor, toHex, toCss, withAlpha, mix, buildPalette, FALLBACK, TOKENS } from '../public/palette.mjs';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const read = f => readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
const [appJs, palJs, panelJs] = await Promise.all([read('app.js'), read('page-palette.mjs'), read('project-panel.mjs')]);
// The page's colour code lives in app.js, page-palette.mjs and project-panel.mjs; the checks below read them as one.
const js = `${appJs}
${palJs}
${panelJs}`;

test('parseColor reads hex in 3, 4, 6 and 8 digits', () => {
  assert.deepEqual(parseColor('#3ef0ff'), [62, 240, 255, 1]);
  assert.deepEqual(parseColor(' #FFF '), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('#0f08'), [0, 255, 0, 0.533]);
  assert.deepEqual(parseColor('#00000080'), [0, 0, 0, 0.502]);
});

test('parseColor reads rgb() and rgba(), with commas or spaces and a slash alpha', () => {
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30, 1]);
  assert.deepEqual(parseColor('rgba(10, 18, 32, 0.72)'), [10, 18, 32, 0.72]);
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor('rgb(300, -4, 30.4)'), [255, 0, 30, 1]);
  assert.deepEqual(parseColor('rgb(100% 0% 50%)'), [255, 0, 128, 1]);
});

test('parseColor reads the color(srgb ...) form a browser gives a color-mix result', () => {
  assert.deepEqual(parseColor('color(srgb 0.243 0.941 1 / 0.22)'), [62, 240, 255, 0.22]);
  assert.deepEqual(parseColor('color(srgb 1 0 0)'), [255, 0, 0, 1]);
});

test('parseColor gives null for a missing or unreadable value', () => {
  for (const v of [undefined, null, '', '   ', 'var(--nope)', 'notacolor', '#12', '#ggg', 'rgb(1, 2)']) assert.equal(parseColor(v), null, String(v));
});

test('toHex writes #rrggbb, and toCss keeps a translucent colour translucent', () => {
  assert.equal(toHex([62, 240, 255, 1]), '#3ef0ff');
  assert.equal(toCss([62, 240, 255, 1]), '#3ef0ff');
  assert.equal(toCss([10, 18, 32, 0.72]), 'rgba(10,18,32,0.72)');
});

test('withAlpha keeps a colour\'s own alpha, and mix goes part-way to another colour', () => {
  assert.equal(withAlpha('#3ef0ff', 0.5), 'rgba(62,240,255,0.5)');
  assert.equal(withAlpha('rgba(10, 18, 32, 0.5)', 0.5), 'rgba(10,18,32,0.25)');
  assert.equal(withAlpha('#3ef0ff', 2), '#3ef0ff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#000000', '#ffffff', 3), '#ffffff');
});

test('buildPalette uses what the page reads, and the fallback for one it cannot read', () => {
  const pal = buildPalette(name => ({ accent: 'rgb(1, 2, 3)', ok: '', cat1: 'color(srgb 1 1 1)' })[name]);
  assert.deepEqual(pal.accent, [1, 2, 3, 1]);
  assert.deepEqual(pal.cat1, [255, 255, 255, 1]);
  assert.deepEqual(pal.ok, parseColor(FALLBACK.ok));
  assert.deepEqual(pal.danger, parseColor(FALLBACK.danger));
  assert.deepEqual(Object.keys(pal).sort(), Object.keys(TOKENS).sort());
});

test('a translucent token keeps its alpha through parseColor and buildPalette', () => {
  assert.equal(parseColor('rgba(10, 18, 32, 0.97)')[3], 0.97);
  assert.equal(parseColor('color(srgb 0.04 0.07 0.125 / 0.94)')[3], 0.94);
  assert.equal(parseColor('#0a122080')[3], 0.502);
  const pal = buildPalette(name => ({ surface2: 'rgba(5, 12, 24, 0.97)', surface3: 'color(srgb 0.04 0.08 0.14 / 0.985)' })[name]);
  assert.equal(pal.surface2[3], 0.97);
  assert.equal(pal.surface3[3], 0.985);
  assert.equal(pal.ink[3], 1);
});

test('the fallback table holds exactly the values in the default theme\'s block (Horizon)', () => {
  const root = css.match(/^:root, :root\[data-theme="horizon"\] \{[\s\S]*?^\}/m)[0];
  for (const [name, css_] of Object.entries(TOKENS)) {
    const m = root.match(new RegExp(String.raw`${css_}:\s*([^;]+);`));
    assert.ok(m, `${css_} is defined in :root`);
    assert.deepEqual(parseColor(m[1].trim()), parseColor(FALLBACK[name]), css_);
  }
});

test('public/app.js, page-palette.mjs and project-panel.mjs write no colour or font family of their own', () => {
  const src = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const lines = src.split('\n').map((l, i) => [i + 1, l]);
  const bad = lines.filter(([, l]) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(|\bJetBrains\b|\bOrbitron\b|\bmonospace\b|\bsans-serif\b/.test(l));
  assert.deepEqual(bad, []);
  // A quoted word where a colour goes (a named colour such as 'black'), in canvas code or an inline style.
  const named = lines.filter(([, l]) => /(?:fillStyle|strokeStyle|shadowColor)\s*=\s*['"`](?!\$\{)|addColorStop\([^,]+,\s*['"`](?!\$\{)|style="[^"]*(?:color|background)\s*:\s*(?!var\(|\$\{)[a-z#]/.test(l));
  assert.deepEqual(named, []);
  // `${...}` in a '...' or "..." HTML snippet is written out as text: a template literal was meant.
  const unfilled = lines.filter(([, l]) => /'<[^'`\n]*\$\{[^'`\n]*'|"<[^"`\n]*\$\{[^"`\n]*"/.test(l));
  assert.deepEqual(unfilled, []);
});

test('a theme change recolours every consumer of the palette', () => {
  const handler = appJs.match(/^onPalette\(\(\) => \{\r?\n[\s\S]*?^\}\);\r?$/m)?.[0] ?? '';
  for (const call of ['kmColors()', 'actColors()', 'km.glows.clear()', 'km.widths.clear()', 'kmHexPattern()', 'kmLegend()', 'kpRender()', 'actLegend()', 'renderUsage()'])
    assert.ok(handler.includes(call), `the theme-changed handler calls ${call}`);
  assert.match(appJs, /^onPalette\(\(\) => \{ favLast = ''; drawFavicon\(/m);
  assert.match(palJs, /^document\.addEventListener\('cleon:theme-changed', \(\) => \{ palRebuild\(\); for \(const fn of palRedraws\) fn\(\); \}\);$/m);
});

test('the old --red alias is gone', () => {
  assert.doesNotMatch(css, /--red\b/);
  assert.doesNotMatch(js, /--red\b/);
});

test('status maps read status tokens and category maps read category tokens, never the other way', () => {
  const tokens = re => [...js.matchAll(re)].map(m => m[1]);
  const status = new Set(['ok', 'working', 'danger', 'attention', 'muted', 'muted2']);
  // Git state, ADR tint and Activity results are statuses (or the quiet neutrals).
  const kmStatus = [...(js.match(/^const KM_STATUS = .*$/m)?.[0] ?? '').matchAll(/'(\w+)'\]/g)].map(m => m[1]);
  const actColors = (js.match(/ACT_COLOR, \{(.*)\}\);/)?.[1] ?? '').split(',').map(p => p.split(':')).filter(([k]) => /\b(ok|no|fail)\b/.test(k)).map(([, v]) => v.trim().slice(4));
  const statuses = [...tokens(/PMAP_STATE\.\w+\[0\] = PAL\.(\w+)/g), ...kmStatus, ...actColors];
  assert.ok(statuses.length >= 9, `found ${statuses.length} status colours`);
  for (const n of statuses) assert.ok(status.has(n), `${n} is a status token`);
  // A draft is work in progress, on the map and in the side panel.
  assert.match(appJs, /\(t\.draft \? \[\{ t: ' · draft', c: PAL\.working \}\]/);
  assert.match(panelJs, /chips\.push\(`<span class="kp-chip" style="color:\$\{pal\.working\}">draft<\/span>`\)/);
  // Source and match kinds are categories.
  const cats = tokens(/KM_(?:SRC|HOW)\.\w+(?:\[0\])? = PAL\.(\w+)/g);
  assert.ok(cats.length >= 5, `found ${cats.length} category colours`);
  for (const n of cats) assert.match(n, /^cat[1-5]$/);
  // Chart series come from catColor alone.
  assert.match(js, /const roleHue = .*catColor\(i\)/);
  assert.match(js, /catColor\(top\.indexOf\(p\)\)/);
});
