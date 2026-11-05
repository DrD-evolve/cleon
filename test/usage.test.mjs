import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { cost, blank, scanLines, attribute, usageReport, scanUsage, codexStatus } from '../lib/usage.mjs';

const M = 1e6;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('cost prices each kind of token at the model’s list rate; fast mode doubles it; unknown models are unpriced', () => {
  near(cost('claude-opus-5-5', [M, M, M, M, M]), 4 + 20 + 5 + 8 + 0.2);
  near(cost('claude-opus-5-5 (fast)', [0, M, 0, 0, 0]), 40);
  near(cost('claude-sonnet-5-5', [0, 0, 0, 0, M]), 0.2); // Opus 5.5 and Sonnet 5.5 read the cache at the same price
  near(cost('claude-haiku-4-5-20251001', [M, 0, 0, 0, 0]), 1);
  assert.equal(cost('gpt-9', [M, 0, 0, 0, 0]), null);
});

// Transcript lines as Claude Code writes them.
const reply = (id, ts, usage, model = 'claude-opus-5-5', extra = {}) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: `r${id}`,
  message: { id: `m${id}`, model, usage, content: [{ type: 'text', text: 'secret reply text' }] }, ...extra });
const user = (ts, content, extra = {}) => JSON.stringify({ type: 'user', timestamp: ts, cwd: extra.cwd, message: { content }, ...extra });
const U = (o, cw = 0, cw1h = 0, cr = 0, extra = {}) => ({ input_tokens: 1, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
  cache_creation: { ephemeral_1h_input_tokens: cw1h, ephemeral_5m_input_tokens: cw - cw1h }, ...extra });

test('scanLines counts each reply once, splits cache writes by lifetime, and reads the role and epic', () => {
  const st = scanLines([
    user('2026-11-03T10:00:00Z', 'Run `/orchestration:delegate review --self` for PR #12', { cwd: 'C:\\wt\\acme-api\\wt-ACME-12' }),
    reply(1, '2026-11-03T10:01:00Z', U(100, 1000, 600, 5000)),
    reply(1, '2026-11-03T10:01:00Z', U(100, 1000, 600, 5000)), // the same reply, next content block
    reply(2, '2026-11-03T10:02:00Z', U(10), '<synthetic>'),
    reply(3, '2026-11-03T10:03:00Z', U(50, 0, 0, 0, { speed: 'fast' })),
    'not json',
  ], blank());
  assert.equal(st.requests, 2);
  assert.equal(st.cwd, 'C:\\wt\\acme-api\\wt-ACME-12');
  assert.equal(st.reviewer, true);
  const day = Object.keys(st.days)[0];
  assert.deepEqual(st.days[day], { 'claude-opus-5-5': [1, 100, 400, 600, 5000], 'claude-opus-5-5 (fast)': [1, 50, 0, 0, 0] });
  assert.equal(st.head.length, 2);
  assert.ok(!JSON.stringify(st).includes('secret')); // no text is kept

  // An implementer (only the ticket id is kept from its prompt), and a session opened with the slash command itself.
  const impl = scanLines([user('2026-11-03T10:00:00Z', 'GOAL: Add a status page (ACME-13). The secret plan', { cwd: 'C:/dev/x' })], blank());
  assert.deepEqual([impl.reviewer, impl.workTicket], [false, 'ACME-13']);
  assert.ok(!JSON.stringify(impl).includes('secret'));
  assert.equal(scanLines([user('2026-11-03T10:00:00Z', 'Fix the ACME-13 thing', { cwd: 'C:/dev/x' })], blank()).workTicket, undefined); // not a worker prompt
  assert.equal(scanLines([user('2026-11-03T10:00:00Z',
    '<command-message>delegate</command-message><command-name>/orchestration:delegate</command-name><command-args>review --self</command-args>')], blank()).reviewer, true);

  // An orchestrator: the epic in the command you gave it, then the next epic whose watcher it arms (in a
  // reply, which is also where its tokens are). Each reply's tokens go to the epic running at the time.
  const watch = (id, ts, epic) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: `r${id}`, message: { id: `m${id}`, model: 'claude-opus-5-5',
    usage: U(7), content: [{ type: 'tool_use', name: 'Bash', input: { command: `bash "C:/p/scripts/workspace-dispatch.sh" watch --epic ${epic}` } }] } });
  const orch = scanLines([
    user('2026-11-03T09:00:00Z', '<command-name>/orchestration:orchestrate-work</command-name>\n<command-args>ACME-600</command-args>', { cwd: 'C:/dev/acme-api' }),
    reply(1, '2026-11-03T09:01:00Z', U(100)),
    watch(2, '2026-11-03T12:00:00Z', 'ACME-700'),
    reply(3, '2026-11-03T12:01:00Z', U(50)),
  ], blank());
  assert.equal(orch.epic, 'ACME-700');
  assert.deepEqual(orch.byEpic, { 'ACME-600': { 'claude-opus-5-5': [1, 100, 0, 0, 0] }, 'ACME-700': { 'claude-opus-5-5': [2, 57, 0, 0, 0] } });
  assert.deepEqual(orch.epicAt, { 'ACME-600': Date.parse('2026-11-03T09:01:00Z'), 'ACME-700': Date.parse('2026-11-03T12:01:00Z') });
  // A worker in a ticket's worktree is never an orchestrator, whatever it mentions.
  assert.equal(scanLines([user('2026-11-03T09:00:00Z', 'x', { cwd: 'C:/w/repo-wt-ACME-1' }), watch(4, '2026-11-03T09:01:00Z', 'ACME-1')], blank()).epic, null);
});

test('attribute: a worktree is its ticket’s, an orchestrator its epic’s, a subagent its parent’s, the rest yours', () => {
  const projects = [{ name: 'acme-api', path: 'C:\\dev\\tooling\\acme-api' }, { name: 'acme', path: 'C:\\dev\\tooling' }];
  const st = o => ({ ...blank(), ...o });
  assert.deepEqual(attribute('C--wt-acme-api-wt-ACME-12/a1.jsonl', st({ cwd: 'C:\\wt\\acme-api\\wt-ACME-12', reviewer: true, ticketEpic: 'ACME-600' }), projects),
    { session: 'a1', sub: false, project: 'acme-api', ticket: 'ACME-12', epic: 'ACME-600', role: 'reviewer' });
  // The orchestration plugin's layout: one flat folder of "<repo>-wt-<TICKET>" worktrees.
  assert.deepEqual(attribute('C--x/a2.jsonl', st({ cwd: 'C:\\Users\\me\\.claude-worktrees\\acme-billing-db-wt-ACME-15' }), projects),
    { session: 'a2', sub: false, project: 'acme-billing-db', ticket: 'ACME-15', epic: null, role: 'implementer' });
  const orch = attribute('C--dev-tooling-acme-api/o1.jsonl', st({ cwd: 'C:\\dev\\tooling\\acme-api\\lib', epic: 'ACME-600' }), projects);
  assert.deepEqual([orch.project, orch.role, orch.epic], ['acme-api', 'orchestrator', 'ACME-600']); // the deepest project wins
  const sub = attribute('C--dev-tooling-acme-api/o1/subagents/agent-x.jsonl', st({ cwd: 'C:\\dev\\tooling\\acme-api' }), projects, orch);
  assert.deepEqual([sub.session, sub.sub, sub.role, sub.epic], ['o1', true, 'orchestrator', 'ACME-600']);
  // A worker that starts in the repo's folder, before its worktree exists, is on the ticket its prompt names;
  // its subagent too. A worker an orchestrator dispatches as a subagent is the ticket's, not the orchestrator's.
  const early = attribute('C--dev-tooling-acme-api/w1.jsonl', st({ cwd: 'C:\\dev\\tooling\\acme-api', workTicket: 'ACME-31', reviewer: false }), projects);
  assert.deepEqual([early.project, early.ticket, early.role], ['acme-api', 'ACME-31', 'implementer']);
  const helper = attribute('C--dev-tooling-acme-api/w1/subagents/agent-h.jsonl', st({ cwd: 'C:\\dev\\tooling\\acme-api' }), projects, early);
  assert.deepEqual([helper.ticket, helper.role], ['ACME-31', 'implementer']);
  const dispatched = attribute('C--dev-tooling-acme-api/o1/subagents/agent-w.jsonl', st({ cwd: 'C:\\w\\acme-api-wt-ACME-32', reviewer: true }), projects, orch);
  assert.deepEqual([dispatched.ticket, dispatched.role, dispatched.epic], ['ACME-32', 'reviewer', 'ACME-600']);
  assert.equal(attribute('C--elsewhere/y.jsonl', st({ cwd: 'D:\\scratch\\thing' }), projects).project, 'thing');
  assert.equal(attribute('C--elsewhere/y.jsonl', st({ cwd: 'D:\\scratch\\thing' }), projects).role, 'you');
});

test('usageReport: windows, cost per merged ticket with the orchestrator shared, what-if, and recent sessions', () => {
  const now = new Date(2026, 10, 4, 12).getTime();
  const D = (n, models) => ({ [new Date(now - n * 864e5).toLocaleDateString('sv-SE')]: models });
  const f = (o, days) => ({ ...blank(), ...o, days, first: now - 20 * 864e5, last: o.last ?? now - 864e5, requests: 3, head: [0.1], tail: [0.5] });
  const files = {
    'wt-a/i1.jsonl': f({ cwd: 'C:/wt/repo/wt-T-1', reviewer: false }, D(1, { 'claude-opus-5-5': [0, M, 0, 0, 0] })), // $20, this week
    'wt-a/r1.jsonl': f({ cwd: 'C:/wt/repo/wt-T-1', reviewer: true }, D(10, { 'claude-sonnet-5-5': [0, M, 0, 0, 0] })), // $10, prior week
    'wt-b/i2.jsonl': f({ cwd: 'C:/wt/repo/wt-T-2', reviewer: false }, D(2, { 'claude-opus-5-5': [0, 0, 0, 0, 10 * M] })), // $2 of cache reads
    'repo/o1.jsonl': f({ cwd: 'C:/dev/repo', epic: 'E-1', byEpic: { 'E-1': { 'claude-opus-5-5': [0, 0.2 * M, 0, 0, 0] } } },
      D(3, { 'claude-opus-5-5': [0, 0.2 * M, 0, 0, 0] })), // $4 of orchestration
    'repo/o1/subagents/agent-1.jsonl': f({ cwd: 'C:/dev/repo' }, D(3, { 'claude-haiku-5-5': [M, 0, 0, 0, 0] })), // $0.10, the orchestrator's
    'repo/old.jsonl': f({ cwd: 'C:/dev/repo', last: now - 40 * 864e5 }, D(40, { 'claude-opus-5-5': [0, M, 0, 0, 0] })), // $20, outside 30 days
    'x/odd.jsonl': f({ cwd: 'C:/dev/repo' }, D(1, { 'gpt-9': [5, 5, 0, 0, 0] })),
  };
  const r = usageReport(files, { projects: [{ name: 'repo', path: 'C:/dev/repo' }], now, alive: new Set(['o1']),
    tickets: [{ ticket: 'T-1', epic: 'E-1', step: 'done' }, { ticket: 'T-2', epic: 'E-1', step: 'implementing' }] });
  near(r.tiles.week, 20 + 2 + 4 + 0.1);
  near(r.tiles.prior, 10);
  near(r.tiles.month, 36.1);
  near(r.tiles.all, 56.1);
  near(r.tiles.cacheShare, 2 / 36.1);
  // T-1: $20 implementing + $10 review + half of the epic's $4.10 orchestration.
  const e = r.epics.find(e => e.epic === 'E-1');
  near(e.orchestrator, 4.1);
  near(e.tickets.find(k => k.ticket === 'T-1').total, 32.05);
  assert.deepEqual([r.tiles.perTicket.n, Math.round(r.tiles.perTicket.median * 100)], [1, 3205]);
  // What-if: the orchestrator's Opus output on Sonnet costs half; its Haiku stays as it is.
  const orch = r.models.find(m => m.role === 'orchestrator');
  near(orch.usd, 4.1);
  near(orch.ifSonnet, 2.1);
  // Sessions active in the last week, costliest first; the subagent folds into its parent.
  assert.deepEqual(r.sessions.map(s => [s.id, s.role, Math.round(s.usd * 100), s.alive]),
    [['i1', 'implementer', 2000, false], ['o1', 'orchestrator', 410, true], ['i2', 'implementer', 200, false]]);
  assert.deepEqual(r.unpriced, [{ model: 'gpt-9', tokens: 10 }]);
  assert.equal(r.projects[0].project, 'repo');
});

test('scanUsage reads only what a transcript gained, and keeps totals after Claude Code deletes it', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-usage-'));
  const store = join(dir, 'ledger.json'), tdir = join(dir, 'projects', 'C--dev-repo'), file = join(tdir, 's1.jsonl');
  await mkdir(join(tdir, 's1', 'subagents'), { recursive: true });
  await writeFile(file, `${user('2026-11-03T10:00:00Z', 'hi', { cwd: 'C:/dev/repo' })}\n${reply(1, '2026-11-03T10:01:00Z', U(1000))}\n`);
  await writeFile(join(tdir, 's1', 'subagents', 'agent-a.jsonl'), `${reply(9, '2026-11-03T10:05:00Z', U(10), 'claude-haiku-5-5')}\n`);
  try {
    let files = await scanUsage({ dir: join(dir, 'projects'), store });
    assert.deepEqual(Object.keys(files).sort(), ['C--dev-repo/s1.jsonl', 'C--dev-repo/s1/subagents/agent-a.jsonl']);
    assert.equal(files['C--dev-repo/s1.jsonl'].requests, 1);
    // A half-written line isn't read until it's finished; the reply's second content block isn't counted again.
    await appendFile(file, `${reply(1, '2026-11-03T10:01:00Z', U(1000))}\n${reply(2, '2026-11-03T10:02:00Z', U(500))}\n{"type":"assist`);
    files = await scanUsage({ dir: join(dir, 'projects'), store });
    assert.equal(files['C--dev-repo/s1.jsonl'].requests, 2);
    await appendFile(file, `ant"}\n`);
    await scanUsage({ dir: join(dir, 'projects'), store });
    // Deleted by Claude Code's cleanup: still counted, marked gone, and saved.
    await rm(file);
    files = await scanUsage({ dir: join(dir, 'projects'), store });
    assert.equal(files['C--dev-repo/s1.jsonl'].gone, true);
    assert.equal(files['C--dev-repo/s1.jsonl'].requests, 2);
    const saved = JSON.parse(await readFile(store, 'utf8'));
    assert.equal(saved.files['C--dev-repo/s1.jsonl'].requests, 2);
    assert.ok(!(await readFile(store, 'utf8')).includes('secret'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('codexStatus says whether Codex has left any session logs', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-codex-'));
  try {
    assert.deepEqual(await codexStatus(join(dir, 'missing')), { found: false, sessions: 0 });
    await mkdir(join(dir, '2026', '11', '04'), { recursive: true });
    await writeFile(join(dir, '2026', '11', '04', 'rollout-1.jsonl'), '{}\n');
    assert.deepEqual(await codexStatus(dir), { found: true, sessions: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
