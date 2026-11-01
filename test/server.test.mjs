import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.mjs';

let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => server.close());

test('file endpoint serves only indexed graph ids', async () => {
  assert.equal((await fetch(`${base}/api/file?id=nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/file?id=../../Windows/win.ini`)).status, 404);
});

test('static serving does not escape public/', async () => {
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('herdr focus refuses GET, foreign origins and non-loopback hosts', async () => {
  const post = headers => fetch(`${base}/api/herdr/focus`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"pane":"w1:p1"}' });
  assert.equal((await fetch(`${base}/api/herdr/focus`)).status, 403);
  assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({})).status, 403);
});
