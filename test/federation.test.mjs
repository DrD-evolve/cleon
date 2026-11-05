// A Cleon with peers (MC_PEERS), against fake peers: one answering with canned rows and recording every
// request it gets, one that accepts connections and never answers. MC_PEERS (and stand-in secrets) are set
// before server.mjs is imported, so lib/config.mjs reads them; this file runs in its own process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const SECRETS = { BITBUCKET_TOKEN: 'tok-bb-SECRET-1', LINEAR_API_KEY: 'lin-SECRET-2' };
const now = Date.now();
const CANNED = {
  '/api/sessions': [{ id: 'peer-s1', name: 'ACME-21 worker', cwd: 'C:/wt/acme-api-wt-ACME-21', alive: true, status: 'waiting' },
    { id: 'third-s', name: 'from a third machine', alive: true, machine: 'other' }],
  '/api/runs': { flow: [], stepFiles: {}, runs: [{ epic: 'ACME-20', workspace: 'w1', label: 'ACME-20', updatedAt: now, active: true,
    tickets: [{ ticket: 'ACME-21', step: 'plan-gate', active: true, stale: false, panes: [{ ticket: 'ACME-21', pane: 'w1:p1', lane: 'active' }], files: [] }] }] },
  '/api/attention': [{ sessionId: 'peer-s1', name: 'ACME-21 worker', title: 'Plan gate', question: 'Approve?', options: ['Approve', 'Revise'] }],
  '/api/herdr': { online: true, sessions: ['default'], workspaces: [{ session: 'default', workspace_id: 'w1', label: 'ACME-20' }], tabs: [],
    agents: [{ session: 'default', workspace_id: 'w1', pane_id: 'w1:p1', agent: 'claude', agent_status: 'blocked' }], panes: [] },
  '/api/orchestrators': [{ epic: 'ACME-20', sessionId: 'peer-o1', pane: { herdr: 'default', id: 'w1:p9' }, approvals: [], tasks: [{ id: 'bk1', kind: 'watch' }] }],
  '/api/workers': { 'ACME-21': { sessionId: 'peer-s1', pane: 'w1:p1', tasks: [], subagents: [] } },
  '/api/session-activity': { 'peer-s1': { intent: 'waiting at the plan gate', tasks: [] } },
};
const seen = [];
const peer = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && CANNED[path]) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(CANNED[path])); }
    if (req.method === 'GET' && path === '/api/run-file') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('# the peer\'s plan'); }
    if (req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, did: path })); }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}');
  });
});
const silent = createServer(() => { /* accepts, never answers */ });
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

let base, server;
before(async () => {
  const [p1, p2] = [await listen(peer), await listen(silent)];
  Object.assign(process.env, SECRETS, { MC_PEERS: `worker=http://127.0.0.1:${p1},slow=http://127.0.0.1:${p2},lan=http://10.9.9.9:4317` });
  ({ server } = await import('../server.mjs'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); peer.close(); silent.closeAllConnections(); silent.close(); });

const get = async path => (await fetch(`${base}${path}`)).json();
// The first ask starts each peer read in the background; the rows show from the next.
async function until(path, ok) {
  for (let i = 0; i < 50; i++) { const v = await get(path); if (ok(v)) return v; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`${path}: peer rows never arrived`);
}

test("a peer's rows join the read endpoints, tagged with its machine; a third machine's rows don't come along", async () => {
  const sessions = await until('/api/sessions', v => v.some(s => s.machine === 'worker'));
  assert.deepEqual(sessions.filter(s => s.machine).map(s => [s.id, s.machine]), [['peer-s1', 'worker']]);

  const runs = await until('/api/runs', v => v.runs.some(r => r.machine === 'worker'));
  const run = runs.runs.find(r => r.machine === 'worker');
  assert.equal(run.epic, 'ACME-20');
  assert.equal(run.tickets[0].step, 'plan-gate');

  const att = await until('/api/attention', v => v.some(a => a.machine === 'worker'));
  assert.deepEqual(att.find(a => a.machine === 'worker').options, ['Approve', 'Revise']);

  const herdr = await until('/api/herdr', v => v.agents?.some(a => a.machine === 'worker'));
  assert.ok(herdr.sessions.includes('worker|default'));

  const orch = await until('/api/orchestrators', v => v.some(o => o.machine === 'worker'));
  assert.equal(orch.find(o => o.machine === 'worker').tasks[0].machine, 'worker');

  const workers = await until('/api/workers', v => v['worker|ACME-21']);
  assert.equal(workers['worker|ACME-21'].machine, 'worker');

  const act = await until('/api/session-activity', v => v['peer-s1']);
  assert.equal(act['peer-s1'].machine, 'worker');
});

test('a peer that never answers holds nothing up, and a non-loopback peer is never contacted', async () => {
  const started = Date.now();
  await get('/api/sessions');
  assert.ok(Date.now() - started < 1500, `local panels waited ${Date.now() - started} ms on a silent peer`);
  const peers = await get('/api/peers');
  assert.deepEqual(peers.map(p => p.name), ['worker', 'slow']);              // lan=http://10.9.9.9 was refused
  assert.equal(peers.find(p => p.name === 'worker').online, true);
  assert.equal(peers.find(p => p.name === 'slow').online, false);
});

test("an action on a peer's row goes to that peer, under the guards it applies to its own page, without `machine`", async () => {
  const origin = `http://${new URL(base).host}`;
  const post = (path, body, o = origin) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: o }, body: JSON.stringify(body) });
  const peerPort = new URL((await get('/api/peers')).find(p => p.name === 'worker').url).port;
  const posts = () => seen.filter(r => r.method === 'POST');
  const before = posts().length;

  const gate = { ticket: 'ACME-21', choice: 0, question: 'Approve?', options: ['Approve', 'Revise'] };
  const r = await post('/api/gate/answer', { ...gate, machine: 'worker' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, did: '/api/gate/answer', machine: 'worker' });
  const sent = posts().at(-1);
  assert.equal(sent.url, '/api/gate/answer');
  assert.deepEqual(JSON.parse(sent.body), gate);                     // `machine` stays here
  assert.equal(sent.headers.host, `127.0.0.1:${peerPort}`);
  assert.equal(sent.headers.origin, `http://127.0.0.1:${peerPort}`);  // what the peer's actionBody wants
  assert.match(sent.headers['content-type'], /^application\/json/);

  // The same pane id on both machines: only the one naming the peer goes there.
  await post('/api/herdr/focus', { pane: 'w1:p1', machine: 'worker' });
  const local = await post('/api/herdr/focus', { pane: 'w1:p1' });
  assert.equal(local.status, 409);                                    // this machine has no such pane
  assert.deepEqual(posts().filter(p => p.url === '/api/herdr/focus').map(p => JSON.parse(p.body)), [{ pane: 'w1:p1' }]);

  for (const [path, body] of [['/api/merge/approve', { ticket: 'ACME-21' }], ['/api/runs/restart', { epic: 'ACME-20' }], ['/api/session/focus', { id: 'peer-s1' }]]) {
    const a = await post(path, { ...body, machine: 'worker' });
    assert.equal((await a.json()).did, path);
  }
  assert.equal(posts().length, before + 5);

  // Refused before anything is sent: a foreign page, an unknown machine.
  assert.equal((await post('/api/merge/approve', { ticket: 'ACME-21', machine: 'worker' }, 'http://evil.example')).status, 403);
  const unknown = await post('/api/merge/approve', { ticket: 'ACME-21', machine: 'nobody' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).reason, /no peer named nobody/);
  assert.equal(posts().length, before + 5);

  // A peer's plan, read through this server.
  const plan = await fetch(`${base}/api/run-file?epic=ACME-20&ticket=ACME-21&name=plan&machine=worker`);
  assert.equal(await plan.text(), "# the peer's plan");
  assert.equal(seen.at(-1).url, '/api/run-file?epic=ACME-20&ticket=ACME-21&name=plan');
  assert.equal((await fetch(`${base}/api/run-file?epic=A-1&ticket=A-2&name=plan&machine=nobody`)).status, 404);
});

test('nothing from .env reaches a peer: no token in any header or body', () => {
  assert.ok(seen.length > 0);
  for (const r of seen) {
    const text = JSON.stringify(r);
    for (const s of Object.values(SECRETS)) assert.ok(!text.includes(s), `${r.method} ${r.url} carried a secret`);
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers.cookie, undefined);
  }
});
