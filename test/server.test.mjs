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

test('session focus applies the same refusals', async () => {
  const post = headers => fetch(`${base}/api/session/focus`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"id":"x"}' });
  assert.equal((await fetch(`${base}/api/session/focus`)).status, 403);
  assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({})).status, 403);
});

test('docker cleanup endpoints apply the same refusals', async () => {
  for (const path of ['/api/docker/prune', '/api/docker/image-rm']) {
    const post = headers => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"what":"build"}' });
    assert.equal((await fetch(`${base}${path}`)).status, 403);
    assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({})).status, 403);
  }
});

test('task output is served only for a task the dashboard lists', async () => {
  assert.equal((await fetch(`${base}/api/task-output?id=notalistedtask`)).status, 404);
  assert.equal((await fetch(`${base}/api/task-output?id=..%2F..%2Fx`)).status, 404);
});

test('gate answers apply the same refusals, and refuse a ticket not at its plan gate', async () => {
  const post = (headers, body = '{"ticket":"NOPE-1","choice":0,"question":"q","options":["a"]}') => fetch(`${base}/api/gate/answer`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await fetch(`${base}/api/gate/answer`)).status, 403);
  assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
  const origin = `http://${new URL(base).host}`;
  assert.equal((await post({ origin }, '{"ticket":"NOPE-1"}')).status, 400);
  const r = await post({ origin });
  assert.equal(r.status, 409);
  assert.match((await r.json()).reason, /isn't at its plan gate/);
});
