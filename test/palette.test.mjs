import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseColor, toHex, toCss, buildPalette, FALLBACK, TOKENS } from '../public/palette.mjs';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

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

test('the fallback table holds exactly the values in the stylesheet\'s :root block', () => {
  const root = css.match(/^:root \{[\s\S]*?^\}/m)[0];
  for (const [name, css_] of Object.entries(TOKENS)) {
    const m = root.match(new RegExp(`${css_}:\s*([^;]+);`));
    assert.ok(m, `${css_} is defined in :root`);
    assert.deepEqual(parseColor(m[1].trim()), parseColor(FALLBACK[name]), css_);
  }
});

test('public/app.js writes no colour or font family of its own', () => {
  const src = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bad = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|\bJetBrains\b|\bOrbitron\b|\bmonospace\b|\bsans-serif\b/.test(l));
  assert.deepEqual(bad, []);
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
  // Source and match kinds are categories.
  const cats = tokens(/KM_(?:SRC|HOW)\.\w+(?:\[0\])? = PAL\.(\w+)/g);
  assert.ok(cats.length >= 5, `found ${cats.length} category colours`);
  for (const n of cats) assert.match(n, /^cat[1-5]$/);
  // Chart series come from catColor alone.
  assert.match(js, /const roleHue = .*catColor\(i\)/);
  assert.match(js, /catColor\(top\.indexOf\(p\)\)/);
});
