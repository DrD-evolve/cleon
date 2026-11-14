import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// The Replan confirm with the Today view on, driven by real requests. Only the refusal is tested: a Replan that goes would start a
// planner run, so none is ever sent. As a second guard, PATH is an empty folder before the server loads, so even a regression that
// let a run start could not reach a claude: the spawn the server makes (same env, same cwd) is proven to fail first, and the
// tests are skipped if it does not. Every source is pointed at nothing, and the state file is named by a port of its own, seeded
// before the server loads (the server keeps the state in memory once read), and removed afterwards.
const DIR = await mkdtemp(join(os.tmpdir(), 'cleon-replan-route-'));
const NOBIN = join(DIR, 'no-bin'), RUNCWD = join(os.tmpdir(), 'cleon-today');
await mkdir(NOBIN, { recursive: true });
await mkdir(RUNCWD, { recursive: true });
Object.assign(process.env, {
  MC_TODAY: '1', MC_PORT: '59755', MC_ROOT: DIR, MC_RUNS_DIR: DIR, MC_PLANS_DIR: DIR, MC_PEERS: '',
  LINEAR_API_KEY: '', MC_SCM: 'bitbucket', BITBUCKET_URL: '', BITBUCKET_TOKEN: '', PATH: NOBIN,
});
const probe = spawnSync('claude', ['--version'], { cwd: RUNCWD, env: process.env, windowsHide: true });
const unreachable = probe.error?.code === 'ENOENT';

const FILE = fileURLToPath(new URL('../data/today-59755.json', import.meta.url));
await mkdir(join(FILE, '..'), { recursive: true });
const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const box = (id, o) => ({ id, kind: 'work', itemId: null, start: 1, end: 2, source: 'open', why: 'gap', ...o });
const seed = boxes => ({ v: 1, focus: null, runs: [], last: null, attempts: { day, n: 0, at: 0 },
  plan: { v: 1, day, meetings: [], boxes, items: [], opportunities: [], edited: true } });
// One box the owner placed (locked), and one they cleared: the cleared one makes Replan ask.
const STATE = seed([box('b1', { by: 'you', locked: true, title: 'Mine' }), box('b2', { by: 'you', source: 'cleared', why: 'Cleared by you.' })]);
await writeFile(FILE, JSON.stringify(STATE));
const { server } = await import('../server.mjs');

let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(async () => { server.close(); await rm(FILE, { force: true }); await rm(DIR, { recursive: true, force: true }); });

test('Replan on a plan with a box the owner cleared asks first (409 needsConfirm) and starts no run', { skip: !unreachable && 'claude is reachable from this test env' }, async () => {
  const before = await readFile(FILE, 'utf8');
  const r = await fetch(`${base}/api/today/replan`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.needsConfirm, true);
  assert.match(j.reason, /boxes you cleared/);
  const t = await (await fetch(`${base}/api/today`)).json();
  assert.equal(t.running, false, 'no run is going');
  assert.equal(t.last, null, 'no run ended either');
  assert.equal(await readFile(FILE, 'utf8'), before, 'the state file is untouched');
});
