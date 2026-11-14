import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { workItems, opportunities, buildCandidates, inFocus, hiddenBy } from '../lib/today.mjs';
import { readFacts, parseDetail } from '../lib/today-read.mjs';
import { linearIssues } from '../lib/linear.mjs';
import { localDate } from '../lib/scan.mjs';
import { plannerInput } from '../lib/today-plan.mjs';

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

test('work items: a triage or backlog issue is in only when it is due, and Urgent alone does not bring it in', () => {
  const backlog = { name: 'Backlog', type: 'backlog' }, triage = { name: 'Triage', type: 'triage' };
  const items = workItems({ now: NOW, linear: [issue('ACME-1', { state: backlog, dueDate: '2026-11-01' }), issue('ACME-2', { state: triage, dueDate: TODAY }),
    issue('ACME-3', { state: backlog, priority: 1 }), issue('ACME-4', { state: backlog, dueDate: '2026-12-01' })] });
  assert.deepEqual(items.map(i => [i.ref, i.kind, i.why]), [['ACME-1', 'due', ['overdue']], ['ACME-2', 'due', ['due-today']]]);
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

test('rule thresholds hold at the exact boundary: more than 7 days, more than 5 days, within 7 days', () => {
  const H = 36e5;
  const dirty = at => run({ dirty: [{ name: 'acme', path: '/r/acme', newestChange: at, ahead: 0 }] });
  assert.deepEqual(dirty(old(7)), []);
  assert.deepEqual(sources(dirty(old(7) - H)), ['rule:uncommitted-old']);
  const draft = at => run({ drafts: [{ project: 'acme', path: '/r/acme', files: [{ name: 'reply-draft.md', mtime: at }] }] });
  assert.deepEqual(draft(old(5)), []);
  assert.deepEqual(sources(draft(old(5) - H)), ['rule:unsent-draft']);
  const active = at => run({ projects: [{ name: 'acme', path: '/r/acme', repo: true, lastCommitAt: at }], linearOpen: [] });
  assert.deepEqual(sources(active(old(7))), ['rule:active-no-issue']);
  assert.deepEqual(active(old(7) - H), []);
});

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
  assert.ok(calls.every(([, args]) => args.includes('--branch') && args.includes('--untracked-files=all') && !args.includes('--no-ahead-behind')));
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(facts.dirty.length, 10);
  assert.ok(facts.dirty.every(d => d.ahead === 2));
  assert.equal(facts.gitFailed, 0);
});

test('a git call that fails is counted, and the candidates say git was not read', async () => {
  const projects = [{ name: 'd1', path: '/nowhere/d1', repo: true, dirty: 1 }, { name: 'd2', path: '/nowhere/d2', repo: true, dirty: 1 }];
  const facts = await readFacts({ projects, exclude: none, git: async () => null });
  assert.deepEqual([facts.dirty, facts.gitFailed], [[], 2]);
  const c = buildCandidates({ linear: { online: false }, scm: { online: false }, facts, runTickets: new Set(), now: NOW, exclude: none });
  assert.equal(c.sources.git, 'offline: 2 repos unreadable');
  assert.equal(buildCandidates({ facts: { ...facts, gitFailed: 0 }, now: NOW, exclude: none }).sources.git, 'ok');
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
      await writeFile(join(p, 'adrs', '0003-old.md'), `# ${MARK}\n\nStatus: Superseded, was Proposed\n`);
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

test('MC_EXCLUDE keeps PRs from an excluded repository and issues from an excluded Linear project out of the candidates', () => {
  const pr = (repo, n, o = {}) => ({ repository: { name: repo, ...o }, number: n, title: `PR ${n}`, url: `https://example.test/${repo}/pull/${n}`, updatedAt: '2026-11-11T00:00:00Z', reviewDecision: null, checks: 'passing' });
  const issue = (key, project) => ({ identifier: key, title: `Issue ${key}`, url: `https://example.test/${key}`, priority: 1, updatedAt: '2026-11-11T00:00:00Z', dueDate: null, state: { name: 'Started', type: 'started' }, project: project ? { name: project } : null });
  const linear = { online: true, issues: [issue('ACME-1', 'Acme Web'), issue('ACME-2', 'Secret Proj'), issue('ACME-3', null), issue('ACME-4', 'secret-proj')] };
  const scm = { online: true, reviewRequests: [pr('acme-web', 1), pr('secret-proj', 2), pr('docs', 3, { nameWithOwner: 'org/secret-proj-docs' })],
    myPrs: [{ ...pr('secret-proj', 4), checks: 'failing' }, { ...pr('acme-web', 5), checks: 'failing' }] };
  const facts = { projects: [], dirty: [], drafts: [], adrs: [], plans: [] };
  const ids = exclude => buildCandidates({ linear, scm, facts, runTickets: new Set(), now: NOW, exclude }).items.map(i => i.ref).sort();
  assert.deepEqual(ids(/(?!)/), ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4', 'acme-web#1', 'acme-web#5', 'docs#3', 'secret-proj#2', 'secret-proj#4']);
  assert.deepEqual(ids(/secret[ -]proj/i), ['ACME-1', 'ACME-3', 'acme-web#1', 'acme-web#5']);
  // A pattern written for a folder's separators matches the bare name too, as excludesFolder does.
  assert.deepEqual(ids(/[\/]secret-proj[\/]/i), ['ACME-1', 'ACME-2', 'ACME-3', 'acme-web#1', 'acme-web#5', 'docs#3']);
});

test('MC_EXCLUDE also drops a PR or issue whose title names an excluded folder, before the planner input', () => {
  const pr = (n, title) => ({ repository: { name: 'acme-web' }, number: n, title, url: `https://example.test/acme-web/pull/${n}`, updatedAt: '2026-11-11T00:00:00Z', reviewDecision: null, checks: 'passing' });
  const issue = (key, title) => ({ identifier: key, title, url: `https://example.test/${key}`, priority: 1, updatedAt: '2026-11-11T00:00:00Z', dueDate: null, state: { name: 'Started', type: 'started' }, project: null });
  const linear = { online: true, issues: [issue('ACME-1', 'Fix the footer'), issue('ACME-2', 'Port the secret-proj importer')] };
  const scm = { online: true, reviewRequests: [pr(1, 'Tidy styles'), pr(2, 'Rename secret-proj config')], myPrs: [] };
  const facts = { projects: [], dirty: [], drafts: [], adrs: [], plans: [] };
  const cands = exclude => buildCandidates({ linear, scm, facts, runTickets: new Set(), now: NOW, exclude });
  const excl = /[\/]secret-proj[\/]/i;
  assert.deepEqual(cands(excl).items.map(i => i.ref).sort(), ['ACME-1', 'acme-web#1']);
  const sent = JSON.stringify(plannerInput({ candidates: cands(excl) }).sent);
  assert.ok(!/secret-proj/.test(sent));
  assert.equal(cands(/(?!)/).items.length, 4);
});

const pr = (n, repo, o = {}) => ({ url: `https://github.com/acme/${repo}/pull/${n}`, number: n, title: `PR ${n}`, repository: { name: repo, nameWithOwner: `acme/${repo}` }, ...o });
const FOCUS = { projects: ['Acme Web'] };

test('focus: an item carries its project, a Linear project name or a repository name', () => {
  const items = workItems({ now: NOW, linear: [issue('ACME-1', { project: { name: 'Acme Web' } }), issue('ACME-2')], reviews: [pr(1, 'web')] });
  assert.deepEqual(Object.fromEntries(items.map(i => [i.ref, i.project])), { 'ACME-1': 'Acme Web', 'ACME-2': null, 'web#1': 'web' });
});

test('focus: inFocus is a whitelist compared with norm; empty filters nothing; no project is out once something is chosen', () => {
  assert.equal(inFocus('anything', undefined), true);
  assert.equal(inFocus(null, { projects: [] }), true);
  assert.equal(inFocus('Acme Web', FOCUS), true);
  assert.equal(inFocus('acme-web', FOCUS), true, 'case and punctuation');
  assert.equal(inFocus('acme-web-2', FOCUS), false, 'a near-miss is not a match');
  assert.equal(inFocus('acme', FOCUS), false);
  assert.equal(inFocus(null, FOCUS), false);
  assert.equal(inFocus('---', { projects: ['***'] }), false, 'names with nothing to compare never match');
});

test('focus: buildCandidates keeps a Linear issue by its project name and a PR by its repository name, and counts what it hides', () => {
  const linear = { online: true, issues: [issue('ACME-1', { project: { name: 'Acme Web' } }), issue('ACME-2', { project: { name: 'Other' } }), issue('ACME-3')] };
  const scm = { online: true, reviewRequests: [pr(1, 'acme-web'), pr(2, 'other')], myPrs: [] };
  const facts = { projects: [], dirty: [{ name: 'other', path: '/p/other', ahead: 2 }] };
  const c = buildCandidates({ linear, scm, facts, runTickets: new Set(), now: NOW, exclude: none, focus: FOCUS });
  assert.deepEqual(c.items.map(i => i.ref).sort(), ['ACME-1', 'acme-web#1']);
  assert.deepEqual(c.opportunities, [], 'the rule opportunity of another project is out');
  assert.deepEqual(c.hidden, { items: 3, opportunities: 1, reasons: { project: 4, state: 0, age: 0 } });
  assert.deepEqual(c.focus, { ...FOCUS, age: null, states: [] });
  assert.deepEqual(c.available.map(n => n.toLowerCase().replace(/[^a-z]/g, '')), ['acmeweb', 'other'], 'names before focus, one per norm');
  const all = buildCandidates({ linear, scm, facts, runTickets: new Set(), now: NOW, exclude: none });
  assert.equal(all.items.length, 5);
  assert.deepEqual(all.hidden, { items: 0, opportunities: 0, reasons: { project: 0, state: 0, age: 0 } }, 'no focus, no chip');
});

test('focus: it comes before the caps, so a chosen project is never cut by items focus hides', () => {
  const facts = { projects: [], dirty: Array.from({ length: 12 }, (_, n) => ({ name: `p${String(n).padStart(2, '0')}`, path: `/p/p${n}`, ahead: 1 })) };
  // all twelve are "1 unpushed commit": the per-rule cap of 10 leaves two out without focus, whichever they are
  const out = opportunities({ ...facts, now: NOW, exclude: none });
  assert.equal(out.length, 10);
  const cut = ['p00', 'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p11'].find(n => !out.some(o => o.project === n));
  assert.equal(opportunities({ ...facts, now: NOW, exclude: none, focus: { projects: [cut] } }).filter(o => o.project === cut).length, 1);
  const linear = { online: true, issues: Array.from({ length: 45 }, (_, n) => issue(`ACME-${n}`, { project: { name: n === 44 ? 'Mine' : 'Noise' }, priority: n === 44 ? 4 : 1 })) };
  const c = buildCandidates({ linear, scm: { online: false }, facts: {}, runTickets: new Set(), now: NOW, exclude: none, focus: { projects: ['Mine'] } });
  assert.deepEqual(plannerInput({ candidates: c }).items.map(i => i.ref), ['ACME-44'], 'it survives the planner 40-item cap');
});

test('focus: MC_EXCLUDE still applies on top of it', () => {
  const linear = { online: true, issues: [issue('ACME-1', { project: { name: 'Secret' } }), issue('ACME-2', { project: { name: 'Acme Web' } })] };
  const c = buildCandidates({ linear, scm: { online: false }, facts: {}, runTickets: new Set(), now: NOW, exclude: /secret/i, focus: { projects: ['Secret', 'Acme Web'] } });
  assert.deepEqual(c.items.map(i => i.ref), ['ACME-2']);
});

test('focus: the picker list and the hidden count are taken before the per-rule cap', () => {
  const dirty = Array.from({ length: 15 }, (_, n) => ({ name: `p${String(n).padStart(2, '0')}`, path: `/p/p${n}`, ahead: 1 }));
  const all = buildCandidates({ linear: { online: false }, scm: { online: false }, facts: { projects: [], dirty }, runTickets: new Set(), now: NOW, exclude: none });
  assert.equal(all.opportunities.length, 10, 'the cap still applies to what is offered');
  assert.equal(all.available.length, 15, 'every project can be chosen, including the ones the cap cuts');
  const c = buildCandidates({ linear: { online: false }, scm: { online: false }, facts: { projects: [], dirty }, runTickets: new Set(), now: NOW, exclude: none, focus: { projects: ['p00', 'p14'] } });
  assert.deepEqual(c.opportunities.map(o => o.project).sort(), ['p00', 'p14']);
  assert.equal(c.hidden.opportunities, 13);
});

const aged = (id, days, o = {}) => issue(id, { updatedAt: new Date(NOW - days * D).toISOString(), ...o });
const limited = (linear, focus, extra = {}) => buildCandidates({ linear: { online: true, issues: linear }, scm: extra.scm ?? { online: false }, facts: extra.facts ?? {}, runTickets: new Set(), now: NOW, exclude: none, focus });

test('limits: hiddenBy answers project, state, age or null, first match in that order, and nothing set hides nothing', () => {
  const ready = { source: 'linear', kind: 'ready', project: 'Acme Web', state: 'Todo', updatedAt: new Date(NOW - 30 * D).toISOString() };
  assert.equal(hiddenBy(ready, undefined, NOW), null);
  assert.equal(hiddenBy(ready, { projects: [], age: null, states: [] }, NOW), null);
  assert.equal(hiddenBy(ready, { projects: ['Other'], age: 7, states: ['todo'] }, NOW), 'project', 'project wins');
  assert.equal(hiddenBy(ready, { projects: ['Acme Web'], age: 7, states: ['TODO'] }, NOW), 'state', 'state before age, compared with norm');
  assert.equal(hiddenBy(ready, { age: 7 }, NOW), 'age');
  assert.equal(hiddenBy(ready, { age: 31 }, NOW), null);
  assert.equal(hiddenBy({ ...ready, updatedAt: new Date(NOW - 7 * D).toISOString() }, { age: 7 }, NOW), null, 'exactly the limit is kept');
  assert.equal(hiddenBy({ ...ready, updatedAt: new Date(NOW - 7 * D - 60e3).toISOString() }, { age: 7 }, NOW), 'age', 'a minute over is out');
  assert.equal(hiddenBy({ ...ready, kind: 'due' }, { age: 7 }, NOW), null, 'age never cuts a due item');
  assert.equal(hiddenBy({ ...ready, kind: 'due' }, { states: ['Todo'] }, NOW), 'state', 'a listed state hides even a due one');
  assert.equal(hiddenBy({ ...ready, updatedAt: null, state: null }, { age: 1, states: ['Todo'] }, NOW), null, 'missing updatedAt or state is not judged');
});

test('limits: an opportunity is cut when ageDays is over the limit; 0 and null stay', () => {
  const o = ageDays => ({ source: 'rule:x', project: null, ageDays });
  assert.equal(hiddenBy(o(8), { age: 7 }, NOW), 'age');
  assert.equal(hiddenBy(o(7), { age: 7 }, NOW), null);
  assert.equal(hiddenBy(o(0), { age: 1 }, NOW), null);
  assert.equal(hiddenBy(o(null), { age: 1 }, NOW), null);
});

test('limits: the age limit comes before the per-rule cap, so 3 recent opportunities show behind 15 old ones', () => {
  const dirty = [...Array.from({ length: 15 }, (_, n) => ({ name: `old${n}`, path: `/p/old${n}`, newestChange: NOW - 40 * D, ahead: 0 })),
    ...Array.from({ length: 3 }, (_, n) => ({ name: `new${n}`, path: `/p/new${n}`, newestChange: NOW - 9 * D, ahead: 0 }))];
  const rule = o => o.source === 'rule:uncommitted-old';
  const without = opportunities({ dirty, now: NOW, exclude: none }).filter(rule);
  assert.equal(without.length, 10);
  assert.ok(without.every(o => o.project.startsWith('old')), 'the cap alone would fill the rule with the old ones');
  const got = opportunities({ dirty, now: NOW, exclude: none, focus: { age: 20 } }).filter(rule);
  assert.deepEqual(got.map(o => o.project).sort(), ['new0', 'new1', 'new2']);
  const c = limited([], { age: 20 }, { facts: { projects: [], dirty } });
  assert.equal(c.hidden.opportunities, 15);
  assert.deepEqual(c.hidden.reasons, { project: 0, state: 0, age: 15 });
});

test('limits: age hides ready work older than the limit, never a due one or a PR, and keeps one with no updatedAt', () => {
  const linear = [aged('ACME-1', 30), aged('ACME-2', 2), aged('ACME-3', 30, { dueDate: TODAY }), aged('ACME-4', 30, { updatedAt: undefined })];
  const scm = { online: true, reviewRequests: [{ ...pr(1, 'web'), updatedAt: new Date(NOW - 99 * D).toISOString() }], myPrs: [] };
  const c = limited(linear, { age: 7 }, { scm });
  assert.deepEqual(c.items.map(i => i.ref).sort(), ['ACME-2', 'ACME-3', 'ACME-4', 'web#1']);
  assert.deepEqual(c.hidden, { items: 1, opportunities: 0, reasons: { project: 0, state: 0, age: 1 } });
  assert.deepEqual(c.focus, { projects: [], age: 7, states: [] });
});

test('limits: a listed state hides its issues by norm, even due ones, and availableStates lists the names before the limits', () => {
  const st = name => ({ state: { name, type: 'unstarted' } });
  const linear = [aged('ACME-1', 1, st('In Review')), aged('ACME-2', 1, { ...st('Todo'), dueDate: TODAY }), aged('ACME-3', 1, st('Todo')), aged('ACME-4', 1, st('in-review'))];
  const c = limited(linear, { states: ['In Review', 'todo'] });
  assert.deepEqual(c.items, []);
  assert.deepEqual(c.hidden.reasons, { project: 0, state: 4, age: 0 });
  assert.deepEqual(c.availableStates, ['In Review', 'Todo'], 'one per norm, sorted');
  assert.deepEqual(limited(linear, { states: ['Todo'] }).items.map(i => i.ref), ['ACME-1', 'ACME-4']);
});

test('limits: an item hit by several reasons counts once, so the reasons sum to the total; focus and MC_EXCLUDE still apply', () => {
  const linear = [aged('ACME-1', 30, { project: { name: 'Other' } }), aged('ACME-2', 30, { project: { name: 'Acme Web' } }), aged('ACME-3', 1, { project: { name: 'Acme Web' } }),
    aged('ACME-4', 1, { project: { name: 'Secret' } })];
  const c = buildCandidates({ linear: { online: true, issues: linear }, scm: { online: false }, facts: {}, runTickets: new Set(), now: NOW, exclude: /secret/i,
    focus: { projects: ['Acme Web', 'Secret'], age: 7, states: [] } });
  assert.deepEqual(c.items.map(i => i.ref), ['ACME-3']);
  assert.deepEqual(c.hidden.reasons, { project: 1, state: 0, age: 1 });
  assert.equal(c.hidden.items, c.hidden.reasons.project + c.hidden.reasons.state + c.hidden.reasons.age);
});

test('limits: no settings, or an old focus with only projects, filter nothing', () => {
  const linear = [aged('ACME-1', 400), aged('ACME-2', 1)];
  assert.equal(limited(linear, undefined).items.length, 2);
  assert.equal(limited(linear, { projects: [] }).items.length, 2);
  assert.deepEqual(limited(linear, { projects: [] }).focus, { projects: [], age: null, states: [] });
});

test('limits: a PR is never offered or hidden as a Linear state, even when a Linear state is called Open', () => {
  const scm = { online: true, reviewRequests: [pr(1, 'web')], myPrs: [] };
  const linear = [aged('ACME-1', 1, { state: { name: 'Open', type: 'unstarted' } })];
  const c = limited(linear, { states: ['Open'] }, { scm });
  assert.deepEqual(c.items.map(i => i.ref), ['web#1'], 'the Linear issue in Open is out; the PR stays');
  assert.deepEqual(c.hidden.reasons, { project: 0, state: 1, age: 0 });
  assert.deepEqual(limited([], {}, { scm }).availableStates, [], 'a PR adds no state to the picker');
});
