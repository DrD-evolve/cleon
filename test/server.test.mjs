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

test('every request with a non-loopback Host is refused (DNS rebinding)', async () => {
  const { request } = await import('node:http');
  const get = (path, host) => new Promise((ok, fail) => request(`${base}${path}`, { headers: { host } }, r => { r.resume(); ok(r.statusCode); }).on('error', fail).end());
  const port = new URL(base).port;
  for (const path of ['/api/sessions', '/api/file?id=x', '/']) assert.equal(await get(path, `evil.example:${port}`), 403, path);
  assert.equal(await get('/', `localhost:${port}`), 200);
  assert.equal(await get('/', `127.0.0.1:${port}`), 200);
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

test('restart applies the same refusals, and refuses when no launcher would start it again', async () => {
  const origin = `http://${new URL(base).host}`;
  const post = headers => fetch(`${base}/api/restart`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await fetch(`${base}/api/restart`)).status, 403);
  assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({})).status, 403);
  assert.equal(process.env.MC_SUPERVISED, undefined);
  const r = await post({ origin });
  assert.equal(r.status, 409);
  assert.match((await r.json()).reason, /Not started by the launcher/);
  // The page tells the restarted server by a different boot id; this one's stays put.
  const boot = (await (await fetch(`${base}/api/boot`)).json()).boot;
  assert.ok(Number.isFinite(boot));
  assert.equal((await (await fetch(`${base}/api/boot`)).json()).boot, boot);
});

// Only the refusals: a request that passes would stop the test run itself.
test('stop applies the same refusals', async () => {
  const post = headers => fetch(`${base}/api/stop`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await fetch(`${base}/api/stop`)).status, 403);
  assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({})).status, 403);
  assert.equal((await fetch(`${base}/api/stop`, { method: 'POST', headers: { origin: `http://${new URL(base).host}` }, body: '{}' })).status, 403);
});

test('orchestrator restart applies the same refusals, and refuses an epic that isn\'t a listed run', async () => {
  const post = (headers, body = '{"epic":"NOPE-1"}') => fetch(`${base}/api/runs/restart`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await fetch(`${base}/api/runs/restart`)).status, 403);
  assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({})).status, 403);
  const origin = `http://${new URL(base).host}`;
  assert.equal((await post({ origin }, '{}')).status, 400);
  const bad = await post({ origin }, '{"epic":"NOPE-1\\" && calc"}');
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).reason, 'not an epic id');
  const r = await post({ origin });
  assert.equal(r.status, 409);
  assert.match((await r.json()).reason, /isn't a listed run/);
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

test('merge approval: the fixed prompt reads as an approval, and the endpoint refuses a ticket not at review·merge', async () => {
  const { mergePrompt, ciGates } = await import('../server.mjs');
  const { mergeApprovals } = await import('../lib/orchestrators.mjs');
  // CI is mentioned only while it stands between the PR and the merge.
  assert.equal(mergePrompt(36, 'ACME-183', false), 'Merge PR #36 for ACME-183.');
  assert.equal(mergePrompt(143, 'ACME-164', true), 'Merge PR #143 for ACME-164 when its CI is green.');
  assert.equal(ciGates(undefined), false);
  assert.equal(ciGates({ checks: [{ bucket: 'pass' }, { bucket: 'skipping' }] }), false);
  assert.equal(ciGates({ checks: [{ bucket: 'pass' }, { bucket: 'pending' }] }), true);
  for (const gated of [false, true])
    assert.deepEqual(mergeApprovals([{ t: 1, text: mergePrompt(143, 'ACME-164', gated) }]), [{ t: 1, prs: [143], tickets: ['ACME-164'] }]);
  const origin = `http://${new URL(base).host}`;
  const post = body => fetch(`${base}/api/merge/approve`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body });
  assert.equal((await fetch(`${base}/api/merge/approve`)).status, 403);
  assert.equal((await post('{}')).status, 400);
  const r = await post('{"ticket":"NOPE-1"}');
  assert.equal(r.status, 409);
  assert.match((await r.json()).reason, /isn't at review·merge/);
});

test('project open applies the same refusals, and only opens a folder the project list has', async () => {
  const post = (headers, body) => fetch(`${base}/api/project/open`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const origin = `http://${new URL(base).host}`;
  assert.equal((await fetch(`${base}/api/project/open`)).status, 403);
  assert.equal((await post({ origin: 'http://evil.example' }, '{"path":"C:/x","app":"bash"}')).status, 403);
  assert.equal((await post({ origin }, '{"path":"C:/x","app":"calc"}')).status, 400);
  assert.equal((await post({ origin }, '{"path":"C:/Windows","app":"bash"}')).status, 404);
});

test('endpoints asked at once share one herdr read (the page asks four of them every poll)', async () => {
  const { recorder } = await import('../lib/activity.mjs');
  const from = recorder.rev;
  const rs = await Promise.all(['/api/herdr', '/api/herdr', '/api/attention', '/api/workers'].map(p => fetch(`${base}${p}`)));
  assert.ok(rs.every(r => r.ok));
  const lists = recorder.since(from).filter(e => e.kind === 'program' && e.what.startsWith('herdr session list'));
  assert.ok(lists.length <= 1, `${lists.length} herdr session lists`);
});
