import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

// The planner is off unless MC_TODAY=1, whatever a .env on this machine says.
process.env.MC_TODAY = '';
const { server } = await import('../server.mjs');

let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => server.close());

test('with MC_TODAY unset, /api/today says the view is off and Replan starts nothing', async () => {
  const r = await fetch(`${base}/api/today`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { on: false, reason: 'the Today view is off (MC_TODAY=1 in .env turns it on)' });
  const post = await fetch(`${base}/api/today/replan`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
  assert.equal(post.status, 409);
  assert.match((await post.json()).reason, /the Today view is off/);
  assert.equal((await fetch(`${base}/api/today/replan`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })).status, 403);
});

test('with MC_TODAY unset, putting, clearing, adding, moving or removing a box is refused, and only same-origin JSON posts get that far', async () => {
  const post = (path, body, origin = base) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  for (const path of ['/api/today/put', '/api/today/clear', '/api/today/add', '/api/today/move', '/api/today/remove']) {
    const r = await post(path, { box: 'b1', item: 'linear:ACME-1', start: 600, end: 630 });
    assert.equal(r.status, 409, path);
    assert.match((await r.json()).reason, /the Today view is off/);
    assert.equal((await post(path, { box: 'b1' }, 'http://evil.example')).status, 403, path);
  }
});

test('with MC_TODAY unset, setting the focus is refused, and only same-origin JSON posts get that far', async () => {
  const post = (body, origin = base) => fetch(`${base}/api/today/focus`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  const r = await post({ projects: ['ACME'] });
  assert.equal(r.status, 409);
  assert.match((await r.json()).reason, /the Today view is off/);
  assert.equal((await post({ projects: ['ACME'] }, 'http://evil.example')).status, 403);
});

test('the focus route sits behind the same guards as the other Today routes, including the 409 while a planner run is going', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const guarded = src.slice(src.indexOf("if (['put', 'clear', 'add', 'move', 'remove', 'focus']"));
  const run = guarded.indexOf("if (startPlan.running()) return json(res, { ok: false, reason: 'a planner run is going;");
  const branch = guarded.indexOf("if (act === 'focus')");
  assert.ok(run > 0 && branch > run, 'the run check comes before the focus branch');
  const focus = guarded.slice(branch, guarded.indexOf("const r = act === 'put'"));
  assert.match(focus, /await todayCandidates\(\)[\s\S]*if \(startPlan\.running\(\)\) return json\(res, \{ ok: false, reason: 'a planner run is going[\s\S]*today = \{ \.\.\.today, focus/, 'asked again after the awaited read, then saved');
});

test('with MC_TODAY unset, setting an age limit or states is refused the same way, and a cross-origin post is 403', async () => {
  const post = (body, origin = base) => fetch(`${base}/api/today/focus`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  for (const body of [{ age: 7 }, { age: null }, { states: ['Todo'] }, { projects: [], age: 7, states: [] }]) {
    const r = await post(body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match((await r.json()).reason, /the Today view is off/);
    assert.equal((await post(body, 'http://evil.example')).status, 403, JSON.stringify(body));
  }
});

test('the focus route takes projects, age and states, each optional, one required; limits are checked and saved with the focus after the awaited read', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = (await readFile(new URL('../server.mjs', import.meta.url), 'utf8')).replace(/\r?\n/g, '\n');
  const guarded = src.slice(src.indexOf("if (['put', 'clear', 'add', 'move', 'remove', 'focus']"));
  const focus = guarded.slice(guarded.indexOf("if (act === 'focus')"), guarded.indexOf("const r = act === 'put'"));
  assert.match(focus, /\['projects', 'age', 'states'\]\.some\(k => body\[k\] !== undefined\)\) return json\(res, \{ ok: false, reason: [^}]*\}, 400\)/, 'none of the three is a 400');
  assert.match(focus, /await todayCandidates\(\)[\s\S]*if \(startPlan\.running\(\)\)[\s\S]*setFocus\([\s\S]*setLimits\([^)]*availableStates\)[\s\S]*today = \{ \.\.\.today, focus: f\.focus \}[\s\S]*await saveToday\(\);\n\s*todayCandidates\.invalidate\(\)/,
    'both applied to the state as it is after the read, saved, and the candidates cache cleared');
});
