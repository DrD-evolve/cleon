import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { tokens, over, contrast, dE2000 } from './theme-lib.mjs';
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

test("Neon keeps today's values", () => {
  const n = T.neon;
  assert.equal(n['--bg'], '#04060c'); assert.equal(n['--text'], '#cfe7ff'); assert.equal(n['--accent'], '#3ef0ff');
  assert.equal(n['--attention'], '#ff4fd8'); assert.equal(n['--radius'], '2px'); assert.equal(n['--display'], "'Orbitron', var(--data)");
  assert.equal(n['--cat1'], '#6f9dff'); assert.equal(n['--cat3'], '#35d0ae'); assert.equal(n['--cat4'], '#b68cff');
  const sizes = Object.entries(n).filter(([k]) => k.startsWith('--fs-')).map(([, v]) => v).join(' ');
  assert.equal(sizes, '9px 9.5px 10px 10.5px 11px 11.5px 12px 13px 14px 15px 16px 17px 18px 20px');
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
