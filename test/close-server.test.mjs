// The Close sessions routes, against a temporary sessions folder holding one stub: a node process this test starts,
// so the server never sees a real session. Being node, not claude, the stub fails the same-process check and must
// still be running afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = await mkdtemp(join(tmpdir(), 'acme-sessions-'));
process.env.MC_SESSIONS_DIR = DIR;
process.env.MC_PORT = '59638'; // names the reopen list file, so a run never touches a real Cleon's
const REOPEN = fileURLToPath(new URL('../data/closed-sessions-59638.json', import.meta.url));
const stub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
await new Promise(r => stub.once('spawn', r));
await mkdir(DIR, { recursive: true });
await writeFile(join(DIR, `${stub.pid}.json`), JSON.stringify({ pid: stub.pid, sessionId: 'acme-stub', name: 'acme stub',
  cwd: 'C:\\work\\acme', status: 'idle', kind: 'interactive', entrypoint: 'cli', procStart: '1', startedAt: 1, updatedAt: 1 }));
const { server } = await import('../server.mjs');

let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(async () => {
  server.close();
  stub.kill();
  await rm(DIR, { recursive: true, force: true });
  await rm(REOPEN, { force: true });
});
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });

test('the list shows only the sessions in MC_SESSIONS_DIR (Windows) and nothing elsewhere', async () => {
  const r = await (await fetch(`${base}/api/close-sessions`)).json();
  if (process.platform !== 'win32') return assert.deepEqual(r, { supported: false });
  assert.deepEqual(r.sessions.map(s => [s.id, s.pid]), [['acme-stub', stub.pid]]);
});

test('the close routes refuse a GET, a foreign origin and a body without ids', async () => {
  for (const path of ['/api/close-sessions/start', '/api/close-sessions/now']) {
    assert.equal((await fetch(`${base}${path}`)).status, 403);
    assert.equal((await post(path, { ids: ['acme-stub'], id: 'acme-stub' }, { origin: 'http://evil.example' })).status, 403);
  }
  if (process.platform !== 'win32') return;
  assert.equal((await post('/api/close-sessions/start', {})).status, 400);
  assert.equal((await post('/api/close-sessions/start', { ids: [7] })).status, 400);
  assert.equal((await post('/api/close-sessions/now', {})).status, 400);
});

test('a body naming a machine is never handed to a peer: the close acts here, by session id', { skip: process.platform !== 'win32' }, async () => {
  const r = await post('/api/close-sessions/start', { ids: ['acme-stub', 'acme-unknown'], machine: 'worker', pid: process.pid });
  assert.equal(r.status, 200);
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await (await fetch(`${base}/api/close-sessions`)).json()).job;
    if (job.every(j => j.state === 'failed' || j.state === 'closed')) break;
    await new Promise(res => setTimeout(res, 100));
  }
  assert.deepEqual(job.map(j => [j.id, j.state]), [['acme-stub', 'failed'], ['acme-unknown', 'failed']]);
  assert.match(job[0].reason, /another process/); // node, not claude: nothing ended
  assert.equal(stub.exitCode, null);
  const reopen = (await (await fetch(`${base}/api/close-sessions`)).json()).reopen;
  assert.deepEqual(reopen.sessions.map(s => s.line), ['cd "C:\\work\\acme" && claude --resume acme-stub']);
});
