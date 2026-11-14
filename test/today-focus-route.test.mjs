import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// The focus route with the Today view on, driven by real requests. Every source is pointed at nothing before the server loads (a value
// already in the environment wins over .env), so no test reads Linear, a forge or a real project folder, and the answers do not
// depend on this machine. Nothing here starts a planner run: only Replan and the server's own timer do, and neither runs in a test
// (the timer starts only when server.mjs is the main module). The state file is named by a port of its own and removed afterwards.
const DIR = await mkdtemp(join(os.tmpdir(), 'cleon-focus-route-'));
Object.assign(process.env, {
  MC_TODAY: '1', MC_PORT: '59482', MC_ROOT: DIR, MC_RUNS_DIR: DIR, MC_PLANS_DIR: DIR, MC_PEERS: '',
  LINEAR_API_KEY: '', MC_SCM: 'bitbucket', BITBUCKET_URL: '', BITBUCKET_TOKEN: '',
});
const FILE = fileURLToPath(new URL('../data/today-59482.json', import.meta.url));
await mkdir(join(FILE, '..'), { recursive: true });
// A state chosen before: the candidates carry no state at all here, so it is kept only because it is already chosen.
await writeFile(FILE, JSON.stringify({ v: 1, focus: { projects: [], age: 30, states: ['On Hold'] }, plan: null, runs: [], last: null, attempts: { day: null, n: 0, at: 0 } }));
const { server } = await import('../server.mjs');

let base;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(async () => { server.close(); await rm(FILE, { force: true }); await rm(DIR, { recursive: true, force: true }); });

const post = body => fetch(`${base}/api/today/focus`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
const saved = async () => JSON.parse(await readFile(FILE, 'utf8')).focus;

test('the focus route refuses an age that is not a whole number of days from 1 to 3650, and a body with none of the three keys', async () => {
  for (const age of [0, -1, 1.5, '30', 3651, true, []]) {
    const r = await post({ age });
    assert.equal(r.status, 400, `age ${JSON.stringify(age)}`);
    assert.match((await r.json()).reason, /whole number of days/);
  }
  for (const body of [{}, { other: 1 }, { age: undefined }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post({ states: 'On Hold' })).status, 400, 'states must be a list');
  assert.deepEqual(await saved(), { projects: [], age: 30, states: ['On Hold'] }, 'nothing refused was saved');
});

test('the focus route saves an age, clears it with null, and keeps a state only while it is known or already chosen', async () => {
  let r = await post({ age: 7 });
  assert.equal(r.status, 200);
  assert.deepEqual(await saved(), { projects: [], age: 7, states: ['On Hold'] }, 'only age changed');
  assert.deepEqual((await (await fetch(`${base}/api/today`)).json()).focus, { projects: [], age: 7, states: ['On Hold'] }, 'the page reads it back');
  r = await post({ age: null });
  assert.equal(r.status, 200);
  assert.equal((await saved()).age, null, 'null clears');
  r = await post({ states: ['On Hold', 'Made Up'] });
  assert.deepEqual((await saved()).states, ['On Hold'], 'a chosen state stays listed even though no candidate carries it; an unknown one is dropped');
  r = await post({ states: [] });
  assert.deepEqual((await saved()).states, [], 'the last state can be cleared');
  r = await post({ states: ['On Hold'] });
  assert.deepEqual((await saved()).states, [], 'once cleared, a state no candidate carries cannot come back');
  r = await post({ projects: [], age: 3650, states: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(await saved(), { projects: [], age: 3650, states: [] }, 'all three at once');
});
