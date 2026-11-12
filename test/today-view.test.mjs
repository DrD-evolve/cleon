import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = f => readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
const [html, js] = await Promise.all([read('index.html'), read('app.js')]);
// The Today section of app.js, from its heading to the next.
const today = js.slice(js.indexOf('/* ---------- Today ('), js.indexOf('/* ---------- Exec summary'));

test('the Today section exists and builds the page from plan text without markup or links', () => {
  assert.ok(today.length > 2000, 'found the section');
  // Meeting subjects, item titles and reasons come from outside Cleon: text only, never HTML, never a link.
  for (const bad of ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'document.write', 'href', 'onclick=', 'createContextualFragment', 'srcdoc', "'a'"])
    assert.ok(!today.includes(bad), `the Today section uses ${bad}`);
  assert.ok(today.includes('textContent'), 'it sets text');
});

test('Replan starts only from its button: the one fetch of /api/today/replan is in todayReplan, and nothing repeats it', () => {
  assert.equal((js.match(/\/api\/today\/replan/g) ?? []).length, 1);
  const fn = today.slice(today.indexOf('function todayReplan()'), today.indexOf('const todayButton'));
  assert.ok(fn.includes("'/api/today/replan'"));
  assert.ok(!/setInterval|paced\(todayReplan|todayReplan\(\)\s*;?\s*\n.*setTimeout/.test(today), 'no timer calls it');
  assert.ok(fn.includes('discard'), 'edits are only thrown away on the second press');
});

test('the page sends only a box id and an item id', () => {
  assert.ok(today.includes("todayPost('/api/today/put', { box: box.id, item: it.id }"));
  assert.ok(today.includes("todayPost('/api/today/clear', { box: box.id }"));
});

test('the ribbon sits between the header and the board, hidden until the view is on', () => {
  const at = s => html.indexOf(s);
  assert.ok(at('</header>') < at('id="today-ribbon"') && at('id="today-ribbon"') < at('<main>'));
  assert.match(html, /<div id="today-ribbon" hidden><\/div>/);
});

test('the Today panel is registered, opt-in, with hooks, and its section is in the dock', () => {
  assert.match(js, /\{ id: 'today', title: 'Today',[^}]*hidden: true, open: \(\) => \{[^}]*\}, close: \(\) => renderToday\(true\) \}/);
  assert.match(html, /<section class="panel" data-panel="today">[\s\S]*?id="today-panel"/);
  // minimizing a window does not call close: the panel is told, so its clock and drawing stop
  assert.match(js, /if \(id === 'today'\) renderToday\(true\)/);
});

test('the axis is mc.todayAxis, switchable from ＋ Panels and from each form', () => {
  assert.ok(js.includes("'mc.todayAxis'"));
  assert.ok(js.includes('data-axis'));
  assert.ok(today.includes('setTodayAxis('));
});

test('notices pass through focus mode before they ring or notify, and a held one is not recorded as seen', () => {
  const fn = js.slice(js.indexOf('function notifyAlerts('), js.indexOf('/* ---------- Window icon'));
  assert.match(fn, /splitNotices\(list, todayFocus\(\)\)/);
  assert.match(fn, /setFaviconWaiting\(through\.length\)/);
  assert.match(fn, /for \(const a of through\) if \(!alertSeen\.has\(a\.key\)\)/);
  assert.match(fn, /alertSeen = new Set\(\[\.\.\.keys\]\.filter\(k => !heldKeys\.has\(k\)\)\)/);
  // the wake lock and favicon timers are the hidden-tab polling's: focus mode doesn't touch them
  assert.ok(js.includes('document.addEventListener(\'visibilitychange\', holdWake);') && js.includes('document.addEventListener(\'visibilitychange\', favArm);'));
  assert.ok(js.includes('paced(tick.poll, 5000, 60000)'));
});

test('plan-gate alerts carry gate: from the run step, and from the attention flag', () => {
  const fn = js.slice(js.indexOf('function alerts()'), js.indexOf('function notifyAlerts('));
  assert.match(fn, /gate: t\.step === 'plan-gate'/);
  assert.equal((fn.match(/gate: .*\.gate === true/g) ?? []).length, 3);
});
