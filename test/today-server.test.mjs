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

test('with MC_TODAY unset, putting or clearing a box is refused, and only same-origin JSON posts get that far', async () => {
  const post = (path, body, origin = base) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  for (const path of ['/api/today/put', '/api/today/clear']) {
    const r = await post(path, { box: 'b1', item: 'linear:ACME-1' });
    assert.equal(r.status, 409, path);
    assert.match((await r.json()).reason, /the Today view is off/);
    assert.equal((await post(path, { box: 'b1' }, 'http://evil.example')).status, 403, path);
  }
});
