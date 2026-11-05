import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeers, peerSource, ref, mergeList, mergeOrchestrators, mergeActivity, mergeWorkers, mergeHerdr, peerRuns, peerSamples, peerCounts } from '../lib/peers.mjs';
import { settleRuns } from '../lib/runs.mjs';

test('parsePeers takes loopback peers only, and says why it refused the rest', () => {
  const { peers, refused } = parsePeers(' worker=http://127.0.0.1:4319, box=http://localhost:4400/ ,lan=http://10.9.9.9:4317,'
    + 'v6=http://[::1]:4319,tls=https://127.0.0.1:4319,deep=http://127.0.0.1:4319/api,=http://127.0.0.1:1,WORKER=http://127.0.0.1:5,bad name=http://127.0.0.1:6');
  assert.deepEqual(peers, [{ name: 'worker', url: 'http://127.0.0.1:4319' }, { name: 'box', url: 'http://localhost:4400' }]);
  const why = Object.fromEntries(refused.map(r => [r.entry, r.reason]));
  assert.match(why['lan=http://10.9.9.9:4317'], /not loopback/);
  assert.match(why['v6=http://[::1]:4319'], /not loopback/); // a peer's own host check takes 127.0.0.1 and localhost only
  assert.match(why['tls=https://127.0.0.1:4319'], /only http/);
  assert.match(why['deep=http://127.0.0.1:4319/api'], /just scheme, host and port/);
  assert.match(why['=http://127.0.0.1:1'], /name it/);
  assert.match(why['WORKER=http://127.0.0.1:5'], /another peer/);
  assert.match(why['bad name=http://127.0.0.1:6'], /name it/);
  assert.deepEqual(parsePeers(undefined), { peers: [], refused: [] });
});

test('ref keys a peer row by machine, and leaves local ones alone', () => {
  assert.equal(ref('worker', 'ACME-1'), 'worker|ACME-1');
  assert.equal(ref(undefined, 'ACME-1'), 'ACME-1');
});

test('merges tag peer rows with their machine and drop rows a peer itself got from elsewhere', () => {
  const sessions = mergeList([{ id: 'a' }], [{ name: 'worker', value: [{ id: 'b' }, { id: 'c', machine: 'zen' }] }]);
  assert.deepEqual(sessions, [{ id: 'a' }, { id: 'b', machine: 'worker' }]);
  const orch = mergeOrchestrators([], [{ name: 'worker', value: [{ epic: 'ACME-1', tasks: [{ id: 't1' }] }] }]);
  assert.deepEqual(orch, [{ epic: 'ACME-1', machine: 'worker', tasks: [{ id: 't1', machine: 'worker' }] }]);
  const act = mergeActivity({ s1: { tasks: [] } }, [{ name: 'worker', value: { s2: { tasks: [{ id: 'k' }] } } }]);
  assert.deepEqual(act.s2, { machine: 'worker', tasks: [{ id: 'k', machine: 'worker' }] });
  // The same ticket can be on both machines: the peer's worker goes by machine|ticket.
  const w = mergeWorkers({ 'ACME-2': { sessionId: 'x', tasks: [], subagents: [] } },
    [{ name: 'worker', value: { 'ACME-2': { sessionId: 'y', tasks: [{ id: 'k' }], subagents: [{ tasks: [{ id: 's' }] }] }, 'zen|ACME-3': {} } }]);
  assert.deepEqual(Object.keys(w), ['ACME-2', 'worker|ACME-2']);
  assert.equal(w['worker|ACME-2'].sessionId, 'y');
  assert.equal(w['worker|ACME-2'].subagents[0].tasks[0].machine, 'worker');
});

test('mergeHerdr keeps pane ids that repeat across machines apart by machine', () => {
  const local = { online: true, sessions: ['acme'], workspaces: [{ workspace_id: 'w1', session: 'acme' }], tabs: [], agents: [{ pane_id: 'w1:p1', session: 'acme' }], panes: [], focused: 'w1:p1' };
  const worker = { online: true, sessions: ['default'], workspaces: [{ workspace_id: 'w1', session: 'default' }], tabs: [], agents: [{ pane_id: 'w1:p1', session: 'default' }], panes: [] };
  const h = mergeHerdr(local, [{ name: 'worker', value: worker }]);
  assert.deepEqual(h.sessions, ['acme', 'worker|default']);
  assert.deepEqual(h.agents.map(a => [a.pane_id, a.machine]), [['w1:p1', undefined], ['w1:p1', 'worker']]);
  assert.equal(h.focused, 'w1:p1');
  // herdr off here but on there: the peer's still show, and the local reason is kept.
  const off = mergeHerdr({ online: false, reason: 'herdr not installed' }, [{ name: 'worker', value: worker }]);
  assert.equal(off.online, true);
  assert.equal(off.localReason, 'herdr not installed');
  assert.equal(off.agents.length, 1);
  assert.deepEqual(mergeHerdr({ online: false, reason: 'x' }, []), { online: false, reason: 'x' });
});

test("peerSamples keeps each peer's Resources sample apart, and says why one is missing", () => {
  const up = { online: true, error: null }, down = { online: false, error: 'nothing listening (is the SSH tunnel up?)' };
  const [a, b, c] = peerSamples([
    { name: 'worker', value: { at: 5, cpu: { pct: 80 }, procs: [], peers: [{ machine: 'zen', sample: {} }] }, status: up },
    { name: 'box', value: null, status: up },
    { name: 'gone', value: null, status: down },
  ]);
  assert.deepEqual(a, { machine: 'worker', sample: { at: 5, cpu: { pct: 80 }, procs: [] }, online: true, reason: null }); // never its own peers'
  assert.deepEqual(b, { machine: 'box', sample: null, online: true, reason: 'Sampling…' });
  assert.deepEqual(c, { machine: 'gone', sample: null, online: false, reason: 'Not answering: nothing listening (is the SSH tunnel up?)' });
});

test("settleRuns: a peer's ticket is checked against this machine's source control, and merged anywhere is done everywhere", async () => {
  const t = (ticket, step, extra = {}) => ({ ticket, step, active: true, stale: false, ...extra });
  const local = [{ epic: 'ACME-1', tickets: [t('ACME-2', 'human-review', { pr: 'https://scm.example/p/1' }), t('ACME-3', 'implementing')], updatedAt: 1 }];
  const theirs = peerRuns([{ name: 'worker', value: { runs: [
    { epic: 'ACME-9', tickets: [t('ACME-3', 'done', { prState: 'MERGED' }), t('ACME-4', 'human-review', { pr: 'https://scm.example/p/4' })], updatedAt: 2 },
  ] } }]);
  const lookups = [];
  const { runs } = await settleRuns([...local, ...theirs], { lookup: async url => { lookups.push(url); return url.endsWith('/4') ? 'MERGED' : 'OPEN'; } });
  const find = (machine, ticket) => runs.find(r => r.machine === machine && r.tickets.some(x => x.ticket === ticket)).tickets.find(x => x.ticket === ticket);
  assert.equal(find('worker', 'ACME-4').step, 'done');               // the peer's open PR, merged per this machine's lookup
  assert.ok(lookups.includes('https://scm.example/p/4'));
  assert.equal(find(undefined, 'ACME-3').step, 'done');           // merged on the peer, so done here too
  assert.equal(find(undefined, 'ACME-3').mergedElsewhere, true);
  assert.equal(find(undefined, 'ACME-2').step, 'human-review');
});

test("peerSource.get never waits on the peer: it serves the last answer and refreshes in the background", async () => {
  let clock = 1_000, answer = { n: 1 }, calls = 0;
  const fetch = async () => { calls++; return { ok: true, status: 200, json: async () => answer }; };
  const p = peerSource({ name: 'worker', url: 'http://127.0.0.1:4319' }, { fetch, now: () => clock });
  assert.equal(p.get('/api/sessions'), null);                      // nothing yet; a read has started
  await p.settle();
  assert.deepEqual(p.get('/api/sessions'), { n: 1 });
  assert.equal(calls, 1);                                          // fresh: no second read
  answer = { n: 2 }; clock += 2_500;
  assert.deepEqual(p.get('/api/sessions'), { n: 1 });              // stale but served; refresh started
  await p.settle();
  assert.deepEqual(p.get('/api/sessions'), { n: 2 });
  assert.equal(p.status().online, true);
});

test('a peer that never answers goes offline after the timeout, and its rows stop being served', async () => {
  const fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const p = peerSource({ name: 'worker', url: 'http://127.0.0.1:4319' }, { fetch, timeoutMs: 50 });
  const started = Date.now();
  assert.equal(p.get('/api/sessions'), null);
  assert.ok(Date.now() - started < 20, 'get() returned without waiting');
  await p.settle();
  const s = p.status();
  assert.equal(s.online, false);
  assert.match(s.error, /no answer in 0.05 s/);
});

test("a peer missing an endpoint (an older Cleon) stays online: only that path comes back empty", async () => {
  // The clock moves on every read of it, so a failure recorded after a success is never at the same instant.
  let clock = 1_000;
  const answers = { '/api/sessions': { status: 200, body: [{ id: 'b' }] }, '/api/process-input': { status: 404, body: { error: 'not found' } },
    '/api/workers': { status: 500, body: { error: 'boom' } } };
  const fetch = async url => {
    const a = answers[new URL(url).pathname];
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  };
  const p = peerSource({ name: 'worker', url: 'http://127.0.0.1:4319' }, { fetch, now: () => clock++ });
  for (const path of Object.keys(answers)) p.get(path);
  await p.settle();
  assert.equal(p.status().online, true);
  assert.deepEqual(mergeList([{ id: 'a' }], [{ name: 'worker', value: p.get('/api/sessions') }]), [{ id: 'a' }, { id: 'b', machine: 'worker' }]);
  assert.equal(p.get('/api/process-input'), null);
  assert.equal(p.get('/api/workers'), null);
  const s = p.status();
  assert.equal(s.error, null);
  assert.deepEqual(s.missing, ['/api/process-input']);
  assert.deepEqual(s.failing, [{ path: '/api/workers', status: 500 }]);
  // Once the peer is updated and serves it, the path is no longer missing.
  answers['/api/process-input'] = { status: 200, body: { marks: [] } };
  clock += 2_500;
  p.get('/api/process-input');
  await p.settle();
  assert.deepEqual(p.get('/api/process-input'), { marks: [] });
  assert.deepEqual(p.status().missing, []);
});

test('a 200 that is not JSON marks the peer offline: something other than a Cleon is on that port', async () => {
  let clock = 1_000;
  const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });
  const p = peerSource({ name: 'worker', url: 'http://127.0.0.1:4319' }, { fetch, now: () => clock++ });
  p.get('/api/sessions');
  await p.settle();
  const s = p.status();
  assert.equal(s.online, false);
  assert.match(s.error, /\/api\/sessions answered, but not with JSON/);
});

test("an action goes with the peer's own guards and nothing else", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const p = peerSource({ name: 'worker', url: 'http://127.0.0.1:4319' }, { fetch });
  const r = await p.post('/api/gate/answer', { ticket: 'ACME-2', choice: 1 });
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  assert.equal(seen[0].url, 'http://127.0.0.1:4319/api/gate/answer');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'application/json', origin: 'http://127.0.0.1:4319' });
  assert.equal(seen[0].init.body, '{"ticket":"ACME-2","choice":1}');
  // Unreachable: a clear refusal, not a throw.
  const down = peerSource({ name: 'worker', url: 'http://127.0.0.1:4319' }, { fetch: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  const d = await down.post('/api/merge/approve', { ticket: 'ACME-2' });
  assert.equal(d.status, 502);
  assert.match(d.body.reason, /couldn't reach worker: nothing listening/);
});

test('peerCounts says which peers a panel built from every machine counted, and why not the rest', () => {
  const st = (name, o = {}) => ({ name, online: true, error: null, missing: [], ...o });
  assert.deepEqual(peerCounts([st('worker'), st('old', { missing: ['/api/usage-input'] }), st('gone', { online: false, error: 'no answer in 4 s' }), st('slow')],
    new Set(['worker']), '/api/usage-input'), [
    { machine: 'worker', counted: true, reason: null },
    { machine: 'old', counted: false, reason: "on an older Cleon, which doesn't share this" },
    { machine: 'gone', counted: false, reason: 'not answering (no answer in 4 s)' },
    { machine: 'slow', counted: false, reason: 'no answer yet' },
  ]);
});
