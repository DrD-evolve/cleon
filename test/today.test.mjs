import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { workItems, opportunities, buildCandidates } from '../lib/today.mjs';
import { readFacts, parseDetail } from '../lib/today-read.mjs';
import { linearIssues } from '../lib/linear.mjs';
import { localDate } from '../lib/scan.mjs';

const D = 864e5;
const NOW = new Date(2026, 10, 12, 9).getTime();
const TODAY = localDate(NOW);
const none = /^$a/; // matches nothing
const issue = (id, o = {}) => ({ identifier: id, title: `Issue ${id}`, url: `https://linear.example/${id}`, priority: 3, updatedAt: new Date(NOW - D).toISOString(),
  dueDate: null, state: { name: 'Todo', type: 'unstarted' }, project: null, ...o });

test('linearIssues asks for dueDate and passes an issue with one and one without through', async () => {
  let query;
  const fetchFn = async (_, o) => {
    query = JSON.parse(o.body).query;
    return { json: async () => ({ data: { viewer: { name: 'Pat', assignedIssues: { nodes: [issue('ACME-1', { dueDate: '2026-11-12' }), issue('ACME-2')] } } } }) };
  };
  const r = await linearIssues('key', fetchFn);
  assert.match(query, /\bdueDate\b/);
  assert.deepEqual(r.issues.map(i => [i.identifier, i.dueDate]).sort(), [['ACME-1', '2026-11-12'], ['ACME-2', null]]);
});

test('work items: due, ready, and completed or canceled left out', () => {
  const items = workItems({ now: NOW, linear: [
    issue('ACME-1', { dueDate: TODAY }), issue('ACME-2', { dueDate: '2026-11-01' }), issue('ACME-3', { priority: 1 }),
    issue('ACME-4'), issue('ACME-5', { state: { name: 'Doing', type: 'started' } }),
    issue('ACME-6', { state: { name: 'Done', type: 'completed' }, dueDate: '2026-11-01' }), issue('ACME-7', { state: { name: 'Canceled', type: 'canceled' } }),
    issue('ACME-8', { state: { name: 'Backlog', type: 'backlog' } }), issue('ACME-9', { dueDate: '2026-12-01' }),
  ] });
  const by = Object.fromEntries(items.map(i => [i.ref, i]));
  assert.deepEqual(['ACME-1', 'ACME-2', 'ACME-3'].map(r => by[r].kind), ['due', 'due', 'due']);
  assert.deepEqual(by['ACME-1'].why, ['due-today']);
  assert.deepEqual(by['ACME-2'].why, ['overdue']);
  assert.deepEqual(by['ACME-3'].why, ['urgent']);
  assert.deepEqual(['ACME-4', 'ACME-5', 'ACME-9'].map(r => by[r].kind), ['ready', 'ready', 'ready']);
  assert.ok(!by['ACME-6'] && !by['ACME-7'] && !by['ACME-8']);
  assert.equal(items[0].ref, 'ACME-2'); // due first, the earliest date first
});

test('work items: a PR waiting on your review is due; your own PR is due only when it needs action', () => {
  const pr = (n, o = {}) => ({ url: `https://github.com/acme/web/pull/${n}`, number: n, title: `PR ${n}`, repository: { name: 'web' }, ...o });
  const items = workItems({ now: NOW, reviews: [pr(1)], myPrs: [pr(2, { reviewDecision: 'CHANGES_REQUESTED' }), pr(3, { checks: 'failing' }), pr(4, { checks: 'passing' })] });
  assert.deepEqual(items.map(i => [i.ref, i.why]), [['web#1', ['review-requested']], ['web#2', ['changes-requested']], ['web#3', ['checks-failing']]]);
  assert.ok(items.every(i => i.kind === 'due' && i.source === 'pr'));
});

const old = n => NOW - n * D;
const run = (facts, extra = {}) => opportunities({ now: NOW, exclude: none, ...facts, ...extra });
const sources = list => list.map(o => o.source);

test('rule:uncommitted-old fires past 7 days and not before', () => {
  assert.deepEqual(sources(run({ dirty: [{ name: 'acme', path: '/r/acme', newestChange: old(8), ahead: 0 }] })), ['rule:uncommitted-old']);
  assert.deepEqual(run({ dirty: [{ name: 'acme', path: '/r/acme', newestChange: old(2), ahead: 0 }, { name: 'x', path: '/r/x', newestChange: null, ahead: 0 }] }), []);
});

test('rule:unsent-draft fires for an old draft-only thread, not a fresh one or one with a sent version', () => {
  const d = files => ({ project: 'acme', path: '/r/acme', files });
  const fired = run({ drafts: [d([{ name: 'reply-draft.md', mtime: old(6) }])] });
  assert.deepEqual(sources(fired), ['rule:unsent-draft']);
  assert.equal(fired[0].detail, 'communications/reply-draft.md');
  assert.deepEqual(run({ drafts: [d([{ name: 'reply-draft.md', mtime: old(2) }])] }), []);
  assert.deepEqual(run({ drafts: [d([{ name: 'reply-draft.md', mtime: old(9) }, { name: 'reply.md', mtime: old(8) }])] }), []);
});

test('rule:active-no-issue fires on recent commits with no open issue, not otherwise', () => {
  const p = { name: 'acme-web', path: '/r/acme-web', repo: true, lastCommitAt: old(3) };
  assert.deepEqual(sources(run({ projects: [p], linearOpen: [issue('ACME-1', { project: { name: 'Other' } })] })), ['rule:active-no-issue']);
  assert.deepEqual(run({ projects: [p], linearOpen: [issue('ACME-1', { project: { name: 'Acme Web' } })] }), []); // an open issue
  assert.deepEqual(run({ projects: [{ ...p, lastCommitAt: old(10) }], linearOpen: [] }), []); // not recent
  assert.deepEqual(run({ projects: [p], linearOpen: null }), []); // Linear unread: no claim
});

test('rule:plan-no-run fires for a plan whose ticket has no run, not one that has', () => {
  const plans = [{ ticket: 'ACME-1', path: '/plans', file: 'ACME-1-plan.md', mtime: old(1) }, { ticket: 'ACME-2', path: '/plans', file: 'ACME-2-plan.md', mtime: old(1) }];
  const r = run({ plans }, { runTickets: new Set(['ACME-2']) });
  assert.deepEqual(r.map(o => o.id), ['rule:plan-no-run:-:ACME-1']);
  assert.deepEqual(run({ plans }, { runTickets: new Set(['ACME-1', 'ACME-2']) }), []);
});

test('rule:adr-proposed fires for a Proposed ADR, not for one that is not', () => {
  const a = proposed => ({ project: 'acme', path: '/r/acme', file: 'adrs/0001-x.md', proposed, mtime: old(3) });
  assert.deepEqual(sources(run({ adrs: [a(true)] })), ['rule:adr-proposed']);
  assert.deepEqual(run({ adrs: [a(false)] }), []);
});

test('rule:unpushed fires when a dirty repo is ahead, not when it is level', () => {
  const r = run({ dirty: [{ name: 'acme', path: '/r/acme', newestChange: old(1), ahead: 3 }] });
  assert.deepEqual(r.map(o => [o.source, o.title]), [['rule:unpushed', 'acme has 3 unpushed commits']]);
  assert.deepEqual(run({ dirty: [{ name: 'acme', path: '/r/acme', newestChange: old(1), ahead: 0 }] }), []);
});

test('each rule hands on at most ten opportunities', () => {
  const plans = Array.from({ length: 25 }, (_, i) => ({ ticket: `ACME-${i + 1}`, path: '/plans', file: `ACME-${i + 1}-plan.md`, mtime: old(1 + i) }));
  assert.equal(run({ plans }).length, 10);
});

test('an MC_EXCLUDE-matched folder appears in no opportunity, in any rule', () => {
  const exclude = /[\\/]secret-proj[\\/]/;
  const path = '/r/secret-proj', plansPath = '/r/secret-proj/plans';
  const facts = {
    projects: [{ name: 'secret-proj', path, repo: true, lastCommitAt: old(1) }],
    dirty: [{ name: 'secret-proj', path, newestChange: old(9), ahead: 2 }],
    drafts: [{ project: 'secret-proj', path, files: [{ name: 'a-draft.md', mtime: old(9) }] }],
    adrs: [{ project: 'secret-proj', path, file: 'adrs/1.md', proposed: true, mtime: old(1) }],
    plans: [{ ticket: 'ACME-1', path: plansPath, file: 'ACME-1-plan.md', mtime: old(1) }],
  };
  assert.deepEqual(run(facts, { exclude: none, linearOpen: [] }).map(o => o.source).sort(),
    ['rule:active-no-issue', 'rule:adr-proposed', 'rule:plan-no-run', 'rule:uncommitted-old', 'rule:unpushed', 'rule:unsent-draft'], 'all six fire without the exclusion');
  const shown = run(facts, { exclude, linearOpen: [] });
  assert.deepEqual(shown, []);
});

test('readFacts: a clean repo gets no git call, a dirty one gets one, and never more than four run at once', async () => {
  const calls = []; let live = 0, peak = 0;
  const stub = async (cwd, args) => {
    calls.push([cwd, args]); live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 5)); live--;
    return '# branch.oid 1\n# branch.head main\n# branch.ab +2 -0\n? new.txt\n';
  };
  const projects = [{ name: 'clean', path: '/nowhere/clean', repo: true, dirty: 0 },
    ...Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, path: `/nowhere/d${i}`, repo: true, dirty: 1 })),
    { name: 'plain', path: '/nowhere/plain', repo: false, dirty: 0 }];
  const facts = await readFacts({ projects, exclude: none, git: stub });
  assert.equal(calls.length, 10);
  assert.ok(!calls.some(([cwd]) => cwd.endsWith('clean') || cwd.endsWith('plain')));
  assert.ok(calls.every(([, args]) => args.includes('--branch') && !args.includes('--no-ahead-behind')));
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(facts.dirty.length, 10);
  assert.ok(facts.dirty.every(d => d.ahead === 2));
});

test('parseDetail reads ahead and the changed paths of every status line kind', () => {
  const out = ['# branch.head main', '# branch.ab +3 -1', '1 .M N... 100644 100644 100644 a b src/x y.js', '2 R. N... 100644 100644 100644 a b R100 new.js\told.js',
    'u UU N... 1 2 3 4 a b c merge.js', '? notes.md'].join('\n');
  assert.deepEqual(parseDetail(out), { ahead: 3, paths: ['src/x y.js', 'new.js', 'merge.js', 'notes.md'] });
  assert.deepEqual(parseDetail('# branch.head main\n'), { ahead: 0, paths: [] });
});

test('end to end on a temp tree: marker text never reaches the candidates, and every path is project-relative', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'cleon-today-'));
  const MARK = 'ZXQ-MARKER-7731';
  try {
    const proj = join(root, 'tools', 'acme-web'), secret = join(root, 'tools', 'secret-proj'), plans = join(root, 'plans');
    for (const p of [proj, secret]) {
      await mkdir(join(p, 'adrs'), { recursive: true }); await mkdir(join(p, 'communications'), { recursive: true });
      await writeFile(join(p, 'adrs', '0001-pick.md'), `# ${MARK} title\n\nStatus: Proposed\n\n${MARK} body\n`);
      await writeFile(join(p, 'adrs', '0002-done.md'), `# ${MARK}\n\nStatus: Accepted\n`);
      await writeFile(join(p, 'communications', 'reply-draft.md'), `${MARK} draft body`);
      const t = new Date(NOW - 9 * D);
      await utimes(join(p, 'communications', 'reply-draft.md'), t, t);
    }
    await mkdir(plans); await writeFile(join(plans, 'ACME-1-plan.md'), `${MARK} plan`);
    const projects = [{ name: 'acme-web', path: proj, repo: false, dirty: 0 }, { name: 'secret-proj', path: secret, repo: false, dirty: 0 }];
    const exclude = /[\\/]secret-proj([\\/]|$)/;
    const facts = await readFacts({ projects, plansDirs: [plans], exclude });
    const c = buildCandidates({ linear: { online: true, issues: [] }, scm: { online: false, reason: 'stub' }, facts, runTickets: new Set(), now: NOW, exclude });
    assert.deepEqual(c.opportunities.map(o => o.source).sort(), ['rule:adr-proposed', 'rule:plan-no-run', 'rule:unsent-draft']);
    const json = JSON.stringify(c);
    assert.ok(!json.includes(MARK), 'file text leaked');
    assert.ok(!/secret-proj/.test(json), 'an excluded folder was named');
    for (const o of c.opportunities) for (const p of [o.detail]) assert.ok(!/^([a-z]:|[\\/])|(^|[\\/])\.\.([\\/]|$)/i.test(p), `not project-relative: ${p}`);
    assert.ok(!json.includes(root.replace(/\\/g, '\\\\')) && !json.includes(root), 'an absolute path leaked');
    assert.equal(c.sources.scm, 'offline: stub');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
