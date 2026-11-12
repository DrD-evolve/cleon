import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

// What a machine's block needs: the widest thing in it is a peer's open process table (215px measured, with the name
// squeezed), and the block adds 8px padding and a 1px border each side. A tile's own floor (150px) is narrower.
const TILE = 150, TABLE = 215, BLOCK = TABLE + 2 * 8 + 2 + 3, GAP = 8; // 3px of slack for sub-pixel widths
assert.ok(BLOCK > TILE);

test('the Resources body is a size container, so the layout follows the panel and not the window', () => {
  assert.match(css, /\[data-panel="resources"\] \.res-body \{[^}]*container-type: inline-size/);
  assert.equal(/@media[^{]*\{[^@]*\.res-machines/.test(css), false, 'the machines row is switched by @container, not @media');
});

test('tiles keep their 150px floor', () => {
  assert.match(css, /\.res-tiles \{[^}]*minmax\(150px, 1fr\)/);
});

test('each machine count goes side by side only once its blocks fit, never narrower than a block that holds a peer table', () => {
  for (const [n, cols] of [[2, 2], [3, 3], [4, 4]]) {
    const rule = new RegExp(`@container \\(min-width: (\\d+)px\\) \\{[^}]*\\.res-machines\\[data-n="${n}"\\] \\{ grid-template-columns: repeat\\(${cols}, minmax\\(0, 1fr\\)\\)`).exec(css);
    assert.ok(rule, `a container rule for ${n} machines`);
    assert.ok(Number(rule[1]) >= n * BLOCK + (n - 1) * GAP, `${n} machines need at least ${n * BLOCK + (n - 1) * GAP}px, got ${rule[1]}`);
  }
  const many = /@container \(min-width: (\d+)px\) \{[^@]*\.res-machines\[data-n="many"\] \{ grid-template-columns: repeat\(auto-fit, minmax\((\d+)px, 1fr\)\)/.exec(css);
  assert.ok(many && Number(many[2]) >= BLOCK, 'five or more machines wrap in blocks of at least the minimum');
  assert.ok(Number(many[1]) >= 2 * BLOCK + GAP);
});

test('stacked is the default: one column until a container rule says otherwise', () => {
  assert.match(css, /\.res-machines \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('markup: machines come first, then the full-width Ollama line and this machine\'s process list', () => {
  const at = id => html.indexOf(`id="${id}"`);
  assert.ok(at('res-machines') > 0 && at('res-tiles') > at('res-machines') && at('res-peers') > at('res-tiles'));
  assert.ok(at('res-ollama') > at('res-peers') && at('res-procs') > at('res-ollama'));
  assert.match(html, /<div class="res-machines" id="res-machines"[^>]*>[\s\S]*id="res-peers"[^>]*><\/div>\s*<\/div>\s*<div class="res-ollama"/);
});

test('peers render as blocks of the same row, with their own extras inside', async () => {
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = js.slice(js.indexOf('function renderResources'), js.indexOf('async function pollResources'));
  assert.match(fn, /class="res-mach res-peer off"/);
  assert.match(fn, /class="res-mach res-peer"/);
  assert.match(fn, /dataset\.n = /);
  const peer = fn.slice(fn.indexOf('class="res-mach res-peer"'));
  assert.ok(peer.indexOf('ollamaLine') > 0 && peer.indexOf('procBox') > peer.indexOf('ollamaLine'), 'its Ollama line and fold are inside its block');
});
