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

test('the page sends only ids, minutes and a title: every post to the Today routes is one of these', () => {
  assert.ok(today.includes("todayPost('/api/today/put', { box: box.id, item: it.id }"));
  assert.ok(today.includes("todayPost('/api/today/clear', { box: box.id }"));
  assert.ok(today.includes("todayPost('/api/today/remove', { box: box.id }"));
  assert.ok(today.includes("const at = h * 60 + m, body = { start: at, end: at + mins };"));
  assert.ok(today.includes('if (f.title.trim()) body.title = f.title;'));
  assert.ok(today.includes("todayPost('/api/today/add', body,"));
  // no other post: the only fetch with a body is todayPost's, and the only routes it is given are these
  const routes = [...new Set([...today.matchAll(/todayPost\('(\/api\/today\/[a-z]+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(routes, ['/api/today/add', '/api/today/clear', '/api/today/move', '/api/today/put', '/api/today/remove', '/api/today/replan']);
  assert.equal((today.match(/fetch\(/g) ?? []).length, 1, 'todayPost is the one place the section posts');
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
  assert.match(fn, /alertSeen = seenAfter\(keys, heldKeys, alertSeen\)/);
  // the wake lock and favicon timers are the hidden-tab polling's: focus mode doesn't touch them
  assert.ok(js.includes('document.addEventListener(\'visibilitychange\', holdWake);') && js.includes('document.addEventListener(\'visibilitychange\', favArm);'));
  assert.ok(js.includes('paced(tick.poll, 5000, 60000)'));
});

test('plan-gate alerts carry gate: from the run step, and from the attention flag', () => {
  const fn = js.slice(js.indexOf('function alerts()'), js.indexOf('function notifyAlerts('));
  assert.match(fn, /gate: t\.step === 'plan-gate'/);
  assert.equal((fn.match(/gate: .*\.gate === true/g) ?? []).length, 3);
});

test('Replan: a press within half a second of arming is the same gesture, and a server needsConfirm arms with the same 5 s timer', () => {
  const fn = today.slice(today.indexOf('function todayReplan()'), today.indexOf('const todayButton'));
  assert.match(fn, /Date\.now\(\) - td\.armed < 500/);
  assert.match(today, /if \(r\.needsConfirm\) todayArm\(\);/);
  const arm = today.slice(today.indexOf('function todayArm()'), today.indexOf('function todayReplan()'));
  assert.match(arm, /setTimeout\(\(\) => \{ td\.armed = false; renderToday\(true\); \}, 5000\)/);
});

test('the ribbon keeps its scroll across a redraw: it is read from the old track, not the new one', () => {
  assert.match(today, /x = ribbon\.querySelector\('\.tdy-scroll'\)\?\.scrollLeft \?\? 0/);
});

test('shown again during a run, the page looks at once, which restarts the 3 s run poll', () => {
  assert.match(today, /else if \(state\.today\?\.on\) \{ renderToday\(\); if \(state\.today\.running\) pollToday\(\); \}/);
});

test('the gestures: pointer events, the redraw held while one runs, Esc cancels, and every post still goes through todayPost', () => {
  assert.match(today, /addEventListener\('pointerdown', todayDragStart\)/);
  assert.ok(today.includes('setPointerCapture') && today.includes("'pointercancel'"));
  // the redraw waits while a drag is in progress (the poll, the minute clock and the resize observer all go through renderToday)
  assert.match(today, /function renderToday\(force = false\) \{\r?\n  if \(td\.drag\) \{ td\.dirty = true; return; \}/);
  assert.match(today, /e\.key === 'Escape' && td\.drag/);
  // times come from the pointer against the track, snapped by the layout helpers
  assert.ok(today.includes('minuteAt(') && today.includes('deltaMinutes(') && today.includes('getBoundingClientRect()'));
  // every gesture ends in a todayPost: put, add or move, and the section still has the one fetch
  for (const route of ['/api/today/put', '/api/today/add', '/api/today/move']) assert.ok(today.includes(`todayPost('${route}'`), route);
  assert.equal((today.match(/fetch\(/g) ?? []).length, 1);
  assert.ok(today.includes("'tdy-grip'") && today.includes("'aria-hidden': 'true'"), 'a grip on each box end, hidden from assistive tech');
});
