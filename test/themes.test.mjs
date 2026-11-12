import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { css, tokens, over, contrast, dE2000 } from './theme-lib.mjs';
import { parseColor, TOKENS } from '../public/palette.mjs';

const T = { horizon: tokens('horizon'), neon: tokens('neon') };
const rgb = (theme, name, back) => over(T[theme][name], back);

test('every token is defined by both themes, so a theme is one block and nothing leaks between them', () => {
  assert.deepEqual(Object.keys(T.horizon).sort(), Object.keys(T.neon).sort());
  for (const token of Object.values(TOKENS)) assert.ok(T.horizon[token] && T.neon[token], token);
});

for (const theme of ['horizon', 'neon']) {
  test(`${theme}: text and muted text are readable on the surfaces (WCAG 4.5 to 1)`, () => {
    const bg = rgb(theme, '--bg'), surface = rgb(theme, '--surface', bg), surface2 = rgb(theme, '--surface-2', bg);
    const text = rgb(theme, '--text'), muted = rgb(theme, '--muted');
    for (const [what, a, b] of [['--text on --surface', text, surface], ['--text on --surface-2', text, surface2],
      ['--muted on --surface', muted, surface], ['--muted on --surface-2', muted, surface2]]) {
      const c = contrast(a, b);
      assert.ok(c >= 4.5, `${theme}: ${what} is ${c.toFixed(2)}`);
    }
  });
}

test('the contrast maths matches known values', () => {
  assert.equal(Math.round(contrast([255, 255, 255], [0, 0, 0])), 21);
  assert.ok(Math.abs(contrast([119, 119, 119], [255, 255, 255]) - 4.48) < 0.02);
  assert.ok(Math.abs(dE2000([255, 0, 0], [0, 255, 0]) - 86.6) < 0.5);
});

test('a category colour is never close to a status colour or the accent (dE2000 at least 20)', () => {
  const near = (theme, cat) => ['--ok', '--working', '--danger', '--attention', '--accent']
    .map(s => [s, dE2000(rgb(theme, cat), rgb(theme, s))]).filter(([, d]) => d < 20);
  // Horizon: all five. Neon is today's look, so only the two that failed it were moved: cat2 (it was pink) and cat5 (it was amber).
  for (const c of ['--cat1', '--cat2', '--cat3', '--cat4', '--cat5']) assert.deepEqual(near('horizon', c), [], `horizon ${c}`);
  for (const c of ['--cat2', '--cat5']) assert.deepEqual(near('neon', c), [], `neon ${c}`);
  // Pink is waiting on you: no category is near --attention in either theme.
  for (const theme of ['horizon', 'neon']) for (const c of ['--cat1', '--cat2', '--cat3', '--cat4', '--cat5'])
    assert.ok(dE2000(rgb(theme, c), rgb(theme, '--attention')) > 15, `${theme} ${c} is not pink`);
});

test("Neon keeps today's values: every token, only --cat2 and --cat5 moved", () => {
  // The values the stylesheet had before themes, plus the tokens that now carry what was written in the rules
  // (--radius-lg, --blur, --blur-lg, --corner, --backdrop: the same values) and --text-min (no floor, so canvases keep their sizes).
  const TODAY = {
    '--bg': '#04060c', '--surface': 'rgba(10, 18, 32, 0.72)', '--surface-2': 'rgb(5, 12, 24)', '--surface-3': 'rgb(10, 20, 36)',
    '--surface-4': 'rgb(4, 8, 16)', '--line': 'color-mix(in srgb, var(--accent) 22%, transparent)', '--text': '#cfe7ff', '--muted': '#6c84a3',
    '--muted-2': 'rgb(150, 165, 210)', '--ink': '#fff', '--on-accent': '#05070d', '--accent': '#3ef0ff', '--attention': '#ff4fd8',
    '--working': '#ffb547', '--ok': '#4dff9a', '--danger': '#ff5a6e', '--danger-bg': '#1a0d14', '--flash': '#ff8c3a', '--shade': '#000',
    '--glow-b': '#ff4fd8', '--cat1': '#6f9dff', '--cat2': '#d4e157', '--cat3': '#35d0ae', '--cat4': '#b68cff', '--cat5': '#f0bfad',
    '--data': "'JetBrains Mono', ui-monospace, Consolas, monospace", '--ui': 'var(--data)', '--display': "'Orbitron', var(--data)",
    '--fs-9': '9px', '--fs-9-5': '9.5px', '--fs-10': '10px', '--fs-10-5': '10.5px', '--fs-11': '11px', '--fs-11-5': '11.5px', '--fs-12': '12px',
    '--fs-13': '13px', '--fs-14': '14px', '--fs-15': '15px', '--fs-16': '16px', '--fs-17': '17px', '--fs-18': '18px', '--fs-20': '20px',
    '--text-min': '0px', '--radius': '2px', '--radius-lg': '4px', '--blur': 'blur(6px)', '--blur-lg': 'blur(10px)', '--corner': 'block',
    '--backdrop': 'radial-gradient(ellipse at 20% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 55%), '
      + 'radial-gradient(ellipse at 90% 100%, color-mix(in srgb, var(--glow-b) 9%, transparent), transparent 55%), '
      + 'linear-gradient(color-mix(in srgb, var(--accent) 4.5%, transparent) 1px, transparent 1px) 0 0 / 40px 40px, '
      + 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 4.5%, transparent) 1px, transparent 1px) 0 0 / 40px 40px',
  };
  assert.deepEqual(Object.fromEntries(Object.entries(T.neon).map(([k, v]) => [k, v.replace(/\s+/g, ' ')])), TODAY);
});

test('Neon keeps its fonts: Orbitron 500 and 700 only, so its 600 text draws with the 700 face as it always did', async () => {
  const fonts = await readFile(new URL('../public/fonts.css', import.meta.url), 'utf8');
  const weights = [...fonts.matchAll(/font-family: 'Orbitron'; font-weight: (\d+)/g)].map(m => +m[1]);
  assert.deepEqual(weights, [500, 700]);
});

test('Horizon draws the flow and Process charts one user unit per pixel, so their 11 px text stays 11 px', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /<svg class="flowchart" viewBox="0 0 1000 148"/);
  assert.match(app, /<svg class="pm-flow" viewBox="0 0 1000 206"/);
  assert.ok(css.includes(':root[data-theme="horizon"] svg.flowchart { height: 148px; min-width: 1000px; }'));
  assert.ok(css.includes(':root[data-theme="horizon"] .pm-flow { min-width: 1000px; }'));
});

test('canvas text with a size written in app.js goes through the theme floor (PAL.min)', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const sized = [...app.matchAll(/`[^`]*px \$\{PAL\.font\.\w+\}`/g)].map(m => m[0]);
  assert.ok(sized.length >= 5, `found ${sized.length}`);
  for (const s of sized) assert.ok(/PAL\.min/.test(s) || /^`\$\{weight\} \$\{size\}px/.test(s), s);
});

test('Horizon has five type sizes and none is below 11 px', () => {
  const sizes = Object.entries(T.horizon).filter(([k]) => k.startsWith('--fs-')).map(([, v]) => parseFloat(v));
  assert.equal(sizes.length, 14);
  assert.deepEqual([...new Set(sizes)].sort((a, b) => a - b), [11, 12, 13, 16, 20]);
});

test('Horizon panels are solid and Neon keeps its blur', () => {
  assert.equal(T.horizon['--blur'], 'none'); assert.equal(T.horizon['--blur-lg'], 'none');
  assert.ok(parseColor(T.horizon['--surface'])[3] === 1 && parseColor(T.horizon['--surface-2'])[3] === 1);
  assert.equal(T.neon['--blur'], 'blur(6px)'); assert.equal(T.neon['--blur-lg'], 'blur(10px)');
});

test("the saved theme is applied by a script in each page's head, before the stylesheets", async () => {
  const boots = [];
  for (const page of ['index.html', 'view.html']) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, page);
    assert.ok(html.indexOf('<script>') < html.indexOf('/style.css'), `${page}: the script comes before style.css`);
    assert.ok(html.indexOf('</head>') > html.indexOf('</script>'), `${page}: the script is in the head`);
    boots.push(m[1].replace(/\r/g, ''));
  }
  assert.equal(boots[0], boots[1], 'both pages carry the same script');
  const run = store => {
    const root = { dataset: {} };
    const localStorage = { getItem: k => { if (store === 'throws') throw new Error('blocked'); return store[k] ?? null; } };
    vm.runInNewContext(boots[0], { document: { documentElement: root }, localStorage });
    return { ...root.dataset };
  };
  assert.deepEqual(run({}), { theme: 'horizon' });
  assert.deepEqual(run({ 'mc.theme': 'neon' }), { theme: 'neon' });
  assert.deepEqual(run({ 'mc.theme': 'neon', 'mc.motion': 'calm' }), { theme: 'neon', motion: 'calm' });
  assert.deepEqual(run({ 'mc.motion': 'full' }), { theme: 'horizon', motion: 'full' });
  assert.deepEqual(run({ 'mc.theme': 'aurora', 'mc.motion': 'bogus' }), { theme: 'horizon' });
  assert.deepEqual(run('throws'), { theme: 'horizon' });
});
