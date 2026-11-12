import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = f => readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
const [html, js, css] = await Promise.all([read('index.html'), read('app.js'), read('style.css')]);
// The command bar's own code in app.js: from its heading to the next section.
const bar = js.slice(js.indexOf('/* ---------- Command bar'), js.indexOf('// Restart the server'));

test('the bar sits in the header between the view tabs and the stats', () => {
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  const at = id => header.indexOf(`id="${id}"`);
  assert.ok(at('board-views') > 0 && at('board-views') < at('cmdbar') && at('cmdbar') < at('stats'));
});

test('it is a labelled combobox that owns a labelled listbox', () => {
  const input = html.match(/<input id="cmd-input"[^>]*>/s)?.[0] ?? '';
  for (const part of ['role="combobox"', 'aria-label="', 'aria-autocomplete="list"', 'aria-expanded="false"', 'aria-controls="cmd-list"', 'autocomplete="off"'])
    assert.ok(input.includes(part), part);
  assert.match(html, /<div class="cmd-list" id="cmd-list" role="listbox" aria-label="[^"]+" hidden>/);
  assert.match(html, /<kbd id="cmd-hint" aria-hidden="true">/);
  assert.match(html, /id="cmd-status" role="status"/);
  // options and groups are built with the roles, and the active one is named for assistive technology
  for (const part of ["'role', 'option'", "'role', 'group'", 'aria-activedescendant', 'aria-selected', 'aria-labelledby'])
    assert.ok(bar.includes(part), part);
});

test('Ctrl K and Cmd K are taken in the capture phase with preventDefault, whatever has focus', () => {
  const listener = bar.match(/addEventListener\('keydown', e => \{\s*if \(!\(e\.ctrlKey \|\| e\.metaKey\)[\s\S]*?\}, true\);/)?.[0] ?? '';
  assert.ok(listener, 'a capture-phase keydown listener');
  assert.match(listener, /e\.key\.toLowerCase\(\) !== 'k'/);
  assert.match(listener, /e\.preventDefault\(\)/);
  assert.match(listener, /cmd\.input\.focus\(\)/);
});

test('Escape in the bar is handled and stopped on the bar; the global handler is untouched', () => {
  assert.match(bar, /e\.key === 'Escape'\) \{[^}]*e\.stopPropagation\(\)/s);
  assert.ok(js.includes("addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });"), 'the global Escape handler is as it was');
});

test('typing asks for nothing: the bar section has no fetch, api() or timer', () => {
  const code = bar.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bfetch\(|\bapi\(|\bsetInterval\(|XMLHttpRequest|sendBeacon/);
  // the one hand-off is the Knowledge search the page already has
  assert.match(code, /kmFind\(text\)/);
});

test('each kind opens through the page\'s own action', () => {
  for (const call of ['setBoardView(v.id)', 'mountPanel(p, { w: p.w, h: p.h, autoPosition: true })', "'/api/session/focus'", 'ticketTile(r.epic, key, null)',
    'openLinearTile(i)', 'openGithubTile(p, kind)', 'kpFly(hub)']) assert.ok(bar.includes(call), call);
});

test('on a phone the bar takes a row of its own under the brand, in both themes', () => {
  const phone = css.slice(css.indexOf('/* On a phone (both themes)'));
  assert.match(phone, /\.cmdbar \{ order: 8; flex: 1 1 100%; \}/);
  assert.match(phone, /\.stats \{ order: 9;/);
  assert.doesNotMatch(phone, /data-theme="neon"/);
});
