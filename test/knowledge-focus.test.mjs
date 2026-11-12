import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The page is not run here (no DOM): these pin how the selection's coming forward is wired, so a later change that
// breaks a way in or a way out fails a test. The look itself is checked in a browser.
const js = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r/g, '');
const fn = name => {
  const at = js.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} exists`);
  const next = js.slice(at + 10).search(/\n(?:function |const |\/\/ )/);
  return js.slice(at, at + 10 + next);
};

test('kpFly never toggles the selection off: the command bar, Related and Recent call it for a project already forward', () => {
  const body = js.match(/^function kpFly\(hub\) \{.*\}$/m)?.[0] ?? '';
  assert.match(body, /kmFlyTo\(/);
  assert.match(body, /kpSelect\(hub\.id\)/);
  assert.doesNotMatch(body, /kpClear|kpBack|sel = null/);
});

test('choosing the selected project again returns the map to normal: on the map, and by its title in the side panel', () => {
  assert.match(fn('kmClick'), /h\.type === 'hub'\) \{ if \(kp\.sel === lay\.hubs\[h\.i\]\.id\) kpClear\(\); else kpSelect\(/);
  assert.match(js, /<button class="kp-again" data-again /); // the selected project's title in the side panel
  assert.match(js, /if \(d\.again !== undefined\) kpClear\(\);/);
  // Related and Recent rows go through kpFly, which does not toggle.
  assert.match(js, /else if \(d\.rel\) \{ const h = km\.lay\.hubs\[km\.byKey\.get\(d\.rel\)\]; if \(h\) kpFly\(h\); \}/);
});

test('Whole map clears the project and flies home; Escape keeps its step-back order', () => {
  assert.match(js, /\$\('#km-home'\)\.onclick = \(\) => \{ if \(kp\.sel\) kpClear\(\); kmGoHome\(\); \};/);
  // Esc: the open preview, then the selection (kpClear), then one fly at a time.
  assert.match(js, /if \(!kpBack\(\)\) kmBack\(\);/);
  const back = fn('kpBack');
  assert.ok(back.indexOf('kp.pv') < back.indexOf('kpClear()'), 'the preview closes before the selection clears');
});

test('the fan: laid out by fan-layout, drawn before the hubs, its names kept clear of by the label pass, the camera made room', () => {
  assert.match(js, /from '\/fan-layout\.mjs'/);
  assert.match(js, /const names = kmDrawFan\(sub\);/);
  assert.match(js, /kmDrawLabels\(\[\.\.\.tags, \.\.\.hubs, \.\.\.names\]\)/);
  assert.ok(js.indexOf('kmDrawFan(sub);') < js.indexOf('kmDrawHubs(f, d, sub);'), 'the fan is under the hubs');
  assert.match(fn('kpSelect'), /kmRoom\(\)/);
});

test('motion: the lift is immediate under Calm or reduced motion and eased otherwise, and keeps frames going only while it moves', () => {
  const frame = fn('kmFrame');
  assert.match(frame, /if \(motionStill\(\)\) km\.lift = wantLift;/);
  assert.match(frame, /km\.lift !== wantLift/);
});
