import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// a Windows checkout may have CRLF
const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8').then(s => s.replace(/\r\n/g, '\n'));

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

test('markup: the Resources body holds only the machine row; no Ollama line, process list or sample time outside it', () => {
  for (const id of ['res-ollama', 'res-procs', 'res-tiles', 'res-peers', 'res-at'])
    assert.equal(html.includes(`id="${id}"`), false, `index.html has no #${id}`);
  const body = /<div class="res-body">([\s\S]*?)\n      <\/div>\n    <\/section>/.exec(html);
  assert.ok(body, 'the Resources body');
  assert.match(body[1].trim(), /^<div class="res-machines" id="res-machines" data-n="1">[\s\S]*<\/div>$/);
  assert.equal((body[1].match(/<div class="res-machines"/g) ?? []).length, 1);
  assert.equal(/<div class="res-(ollama|procs|peers)/.test(body[1]), false, 'nothing else in the body');
});

test('one function builds every machine\'s block', async () => {
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // Comments dropped, so a call that only survives in a comment doesn't count.
  const fn = js.slice(js.indexOf('function renderResources'), js.indexOf('async function pollResources'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  assert.match(fn, /\$\('#res-machines'\)\.innerHTML = machineBlock\(\{ name: 'This machine', sample: r, hist: state\.resHist, key: '' \}\)/,
    'this machine\'s block is the first one in the row, built by machineBlock with its history and key \'\'');
  assert.match(fn, /peers\.map\([^)]*\) => machineBlock\(/, 'each peer goes through machineBlock');
  assert.match(fn, /dataset\.n = peers\.length > 3 \? 'many' : String\(1 \+ peers\.length\)/, 'data-n counts machines, and many past four');
  assert.equal(/res-ollama|res-procs|res-tiles|res-peers|res-at|resTiles|ollamaLine|procBox/.test(fn), false, 'renderResources writes no part of a block itself');
  assert.match(fn, /#res-machines details\.res-fold/);
});

test('every machine block has the same parts in the same order, and the Ollama line only when Ollama answers', async () => {
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const o = js.indexOf('function ollamaLine'), m = js.indexOf('function machineBlock');
  assert.ok(o >= 0, 'ollamaLine exists');
  assert.ok(m >= 0, 'machineBlock exists');
  const top = /const RES_TOP = \d+;/.exec(js);
  assert.ok(top, 'one top-N constant');
  const src = js.slice(o, js.indexOf('function procTable')) + top[0] + '\n' + js.slice(m, js.indexOf('function renderResources'));
  const calls = [];
  const make = new Function('esc', 'ago', 'gb', 'mins', 'resTiles', 'procBox', 'machineChip',
    `${src}; return { ollamaLine, machineBlock };`);
  const { machineBlock } = make(
    s => String(s), () => '5s ago', n => `${n}G`, () => '3m', () => '<TILES/>',
    (key, r, limit, label) => { calls.push({ key, limit, label }); return `<details class="res-fold" data-fold="${key}">${label}·${limit}</details>`; },
    n => `<chip>${n}</chip>`);
  const sample = ollama => ({ at: 1, ollama, procs: [] });
  const models = [{ name: 'acme-model', vram: 2e9, size: 2e9, until: '2000-01-01T00:00:00Z' }];
  const build = (ollama) => ({
    me: machineBlock({ name: 'This machine', sample: sample(ollama), hist: [], key: '' }),
    peer: machineBlock({ name: '<chip>acme-box</chip>', sample: sample(ollama), key: 'acme-box' }),
  });
  const line = html => /<div class="res-ollama">[\s\S]*?<\/div>/.exec(html)?.[0];

  for (const html of Object.values(build(null))) {
    assert.equal(html.includes('res-ollama'), false, 'null: no Ollama line');
    assert.equal(/not running/i.test(html), false, 'null: never "not running"');
  }
  for (const html of Object.values(build([]))) assert.match(line(html), /no models loaded/);
  const loaded = build(models);
  assert.ok(line(loaded.me) && line(loaded.me) === line(loaded.peer), 'the same Ollama line in both blocks');
  assert.match(line(loaded.me), /<b>acme-model<\/b>/);

  for (const html of Object.values(loaded)) {
    const at = s => html.indexOf(s);
    assert.ok(at('sampled 5s ago') > 0 && at('sampled 5s ago') < at('<TILES/>') && at('<TILES/>') < at('res-ollama') && at('res-ollama') < at('res-fold'),
      'heading with sample time, then tiles, then Ollama, then the fold');
  }
  assert.match(loaded.me, /data-fold=""/);
  assert.match(loaded.peer, /data-fold="acme-box"/);
  assert.equal(/res-peer/.test(loaded.me), false, 'this machine is not a peer block');
  assert.match(loaded.peer, /class="res-mach res-peer"/);
  calls.length = 0;
  build(models);
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map(c => c.label)).size, 1, 'the same fold title');
  assert.equal(calls[0].label, 'Processes');
  assert.equal(new Set(calls.map(c => c.limit)).size, 1, 'the same top N');

  const off = machineBlock({ name: '<chip>acme-box</chip>', sample: null, reason: 'timed out', key: 'acme-box' });
  assert.match(off, /class="res-mach res-peer off"/);
  assert.match(off, /timed out/);
  assert.equal(off.includes('res-fold'), false);
});

test('a long machine name or reason breaks inside its block rather than overflowing it', () => {
  assert.match(css, /\.res-mach \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.res-mach h3 \.chip \{[^}]*white-space: normal/);
});
