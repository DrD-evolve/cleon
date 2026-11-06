// Tickets with no PR file: finding their PRs on the host, and what those PRs add up to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import os from 'node:os';
import adapter from '../lib/adapters/orchestration-plugin.mjs';
import { listRuns, ticketPrs, prOutcome } from '../lib/runs.mjs';
import { combinePrs, processMetrics } from '../lib/metrics.mjs';
import * as github from '../lib/github.mjs';
import * as bitbucket from '../lib/bitbucket.mjs';

const H = 3600e3;
const BASE = 'https://bitbucket.example.com';

async function mkRun(files) {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-runs-'));
  for (const [p, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), body);
  }
  return dir;
}
const pr = (n, state, branch, author = 'me') => ({ url: `https://github.com/o/r/pull/${n}`, state, branch, author });

test('branchTicket finds the ticket id on exact boundaries, wherever the branch puts it', () => {
  for (const [branch, want] of [['ACME-12/fix', 'ACME-12'], ['feature/ACME-12-fix', 'ACME-12'], ['bugfix/ACME-123', 'ACME-123'],
    ['docs/notes', null], ['ACME12', null], ['xACME-12', null], [null, null]])
    assert.equal(adapter.branchTicket(branch), want, String(branch));
});

test('ticketPrs claims only your own PRs, and nothing when it cannot tell who you are', () => {
  const prs = [pr(3, 'MERGED', 'ACME-1/b'), pr(2, 'OPEN', 'feature/ACME-1-teammate', 'them'), pr(1, 'MERGED', 'ACME-1/a'), pr(9, 'MERGED', 'docs/x')];
  assert.deepEqual(ticketPrs(prs, 'me').get('ACME-1').map(p => p.url.slice(-1)), ['3', '1']);
  assert.equal(ticketPrs(prs, 'me').size, 1);
  assert.equal(ticketPrs(prs, null).size, 0);
});

test('prOutcome: done takes a merged PR and none open; declined PRs count for nothing', () => {
  assert.equal(prOutcome([pr(1, 'MERGED', 'a')]).done, true);
  const mixed = prOutcome([pr(2, 'OPEN', 'a'), pr(1, 'MERGED', 'a')]);
  assert.equal(mixed.done, false);
  assert.match(mixed.pr, /2$/);
  assert.deepEqual(prOutcome([pr(1, 'CLOSED', 'a')]), { urls: [], pr: null, done: false });
  assert.equal(prOutcome(undefined).pr, null);
});

test('a ticket with no PR file gets its PRs from the host; one still being worked stays open', async () => {
  const dir = await mkRun({
    'ACME-1/ACME-2/STAGE': 'report-done', // merged: done, though its fleet lane still says active
    'ACME-1/ACME-3/STAGE': 'report-done', // one PR still open
    'ACME-1/ACME-4/STAGE': 'implementing', // first PR merged, worker on the next
    'ACME-1/ACME-5/STAGE': 'report-done', // only a declined PR
    'ACME-1/ACME-6/STAGE': 'report-done', // nothing found
    'ACME-1/fleet.tsv': ['ACME-2', 'ACME-4'].map(t => `${t}\timplement\tw:t\tw:p\tw:p\tactive`).join('\n'),
  });
  const found = new Map([
    ['ACME-2', [pr(21, 'MERGED', 'ACME-2/b')]],
    ['ACME-3', [pr(32, 'OPEN', 'ACME-3/b'), pr(31, 'MERGED', 'ACME-3/a')]],
    ['ACME-4', [pr(41, 'MERGED', 'ACME-4/a')]],
    ['ACME-5', [pr(51, 'CLOSED', 'ACME-5/a')]],
  ]);
  const asked = [];
  const { runs } = await listRuns(dir, { found: async () => found, lookup: async u => { asked.push(u); return null; } });
  const t = id => runs[0].tickets.find(x => x.ticket === id);
  assert.equal(t('ACME-2').step, 'done');
  assert.equal(t('ACME-3').step, 'self-review');
  assert.match(t('ACME-3').pr, /32$/);
  assert.equal(t('ACME-3').prs.length, 2);
  assert.equal(t('ACME-4').step, 'implementing');
  assert.equal(t('ACME-5').step, 'self-review');
  assert.equal(t('ACME-5').pr, null);
  assert.equal(t('ACME-6').pr, null);
  assert.deepEqual(asked, []); // found PRs need no per-ticket lookups
});

test('a self-review folder alone counts only with PRs of yours, and never becomes an epic', async () => {
  const dir = await mkRun({
    'ACME-1/ACME-2/STAGE': 'report-done',
    'delegate/ACME-2/REVIEW_REPORT.md': 'in a run already',
    'delegate/ACME-7/REVIEW_REPORT.md': 'mine, merged',
    'delegate/ACME-8/REVIEW_REPORT.md': 'mine, open',
    'delegate/ACME-9/REVIEW_REPORT.md': 'a teammate PR I reviewed',
  });
  const found = ticketPrs([pr(2, 'OPEN', 'ACME-2/a'), pr(7, 'MERGED', 'ACME-7/a'), pr(8, 'OPEN', 'ACME-8/a'), pr(9, 'MERGED', 'ACME-9/a', 'them')], 'me');
  const { runs, reviewOnly } = await listRuns(dir, { found: async () => found });
  assert.deepEqual(runs.map(r => r.epic), ['ACME-1']);
  assert.deepEqual(reviewOnly.map(t => [t.ticket, t.step]), [['ACME-7', 'done'], ['ACME-8', 'self-review']]);
  assert.equal(reviewOnly[0].root, dir);
});

test('explicit run dirs never ask the host unless told to', async () => {
  const dir = await mkRun({ 'ACME-1/ACME-2/STAGE': 'report-done', 'delegate/ACME-7/REVIEW_REPORT.md': 'x' });
  const { runs, reviewOnly } = await listRuns(dir, { lookup: async () => null });
  assert.equal(runs[0].tickets[0].pr, null);
  assert.deepEqual(reviewOnly, []);
});

test('GitHub repoSlug reads github.com remotes only', () => {
  for (const r of ['https://github.com/o/my.repo.git', 'https://github.com/o/my.repo', 'git@github.com:o/my.repo.git', 'ssh://git@github.com/o/my.repo.git', 'https://x-token@github.com/o/my.repo/'])
    assert.equal(github.repoSlug(r), 'o/my.repo', r);
  for (const r of ['https://github.com.evil.test/o/r.git', `${BASE}/scm/P/r.git`, 'https://github.com/--repo/r', '', null])
    assert.equal(github.repoSlug(r), null, String(r));
});

test('GitHub repoPrs normalises gh pr list, is null when gh fails, and never runs gh for another host', async () => {
  const got = await github.repoPrs('https://github.com/o/r.git', async args => {
    assert.deepEqual(args.slice(0, 4), ['pr', 'list', '--repo', 'o/r']);
    return [{ url: 'https://github.com/o/r/pull/1', state: 'MERGED', headRefName: 'ACME-1/a', author: { login: 'me' } }];
  });
  assert.deepEqual(got, [{ url: 'https://github.com/o/r/pull/1', state: 'MERGED', branch: 'ACME-1/a', author: 'me' }]);
  assert.equal(await github.repoPrs('https://github.com/o/r.git', async () => null), null);
  let called = false;
  assert.equal(await github.repoPrs('https://evil.example/o/r.git', async () => { called = true; return []; }), null);
  assert.equal(called, false);
  assert.equal(await github.me(async () => ({ login: 'me' })), 'me');
  assert.equal(await github.me(async () => null), null);
});

test('Bitbucket parseRemote reads every clone URL form, on the configured server only', () => {
  const P = { project: 'PROJ', repo: 'web-app' };
  for (const r of [`${BASE}/scm/PROJ/web-app.git`, 'https://me@bitbucket.example.com/scm/PROJ/web-app.git', 'ssh://git@bitbucket.example.com:7999/PROJ/web-app.git',
    'git@bitbucket.example.com:PROJ/web-app.git', 'https://BITBUCKET.example.com/ctx/scm/PROJ/web-app'])
    assert.deepEqual(bitbucket.parseRemote(r, BASE), P, r);
  assert.deepEqual(bitbucket.parseRemote('ssh://git@bitbucket.example.com:7999/~me/dots.git', BASE), { project: '~me', repo: 'dots' });
  for (const r of ['https://github.com/o/r.git', 'https://bitbucket.example.com.evil.test/scm/P/r.git', 'git@evil.example:P/r.git', 'https://bitbucket.example.com/r.git', null])
    assert.equal(bitbucket.parseRemote(r, BASE), null, String(r));
  assert.equal(bitbucket.parseRemote(`${BASE}/scm/P/r.git`, null), null);
});

test('Bitbucket repoPrs pages a repo into the shared shape, with addresses parsePrUrl accepts', async () => {
  const raw = (id, state, branch, slug = 'me') => ({ id, state, fromRef: { displayId: branch }, author: { user: { slug } } });
  const asked = [];
  const got = await bitbucket.repoPrs(`${BASE}/scm/PROJ/web-app.git`, { base: BASE, api: async p => {
    asked.push(p);
    return p.endsWith('start=0') ? { values: [raw(2, 'DECLINED', 'feature/ACME-1-x')], isLastPage: false, nextPageStart: 100 }
      : { values: [raw(1, 'MERGED', 'ACME-1/y', 'them')], isLastPage: true };
  } });
  assert.deepEqual(got, [
    { url: `${BASE}/projects/PROJ/repos/web-app/pull-requests/2`, state: 'CLOSED', branch: 'feature/ACME-1-x', author: 'me' },
    { url: `${BASE}/projects/PROJ/repos/web-app/pull-requests/1`, state: 'MERGED', branch: 'ACME-1/y', author: 'them' },
  ]);
  assert.equal(asked.length, 2);
  assert.ok(asked.every(p => p.includes('/projects/PROJ/repos/web-app/pull-requests?state=ALL')));
  for (const p of got) assert.ok(bitbucket.parsePrUrl(p.url, BASE));
  // A personal repo's address is under /users, its REST path under ~user.
  const [mine] = await bitbucket.repoPrs(`${BASE}/scm/~me/dots.git`, { base: BASE, api: async () => ({ values: [raw(5, 'OPEN', 'b')] }) });
  assert.deepEqual(bitbucket.parsePrUrl(mine.url, BASE), { project: '~me', repo: 'dots', id: 5 });
});

test('Bitbucket repoPrs stops at its page limit, keeps what it read when a later page fails, and sends nothing for a foreign remote', async () => {
  const remote = `${BASE}/scm/P/r.git`;
  let n = 0;
  await bitbucket.repoPrs(remote, { base: BASE, api: async () => { n++; return { values: [], isLastPage: false, nextPageStart: n * 100 }; } });
  assert.equal(n, 3);
  assert.equal(await bitbucket.repoPrs(remote, { base: BASE, api: async () => null }), null);
  let page = 0;
  const partial = await bitbucket.repoPrs(remote, { base: BASE, api: async () => (page++ ? null : { values: [{ id: 1, state: 'OPEN' }], isLastPage: false, nextPageStart: 100 }) });
  assert.equal(partial.length, 1);
  let called = false;
  assert.equal(await bitbucket.repoPrs('https://github.com/o/r.git', { base: BASE, api: async () => { called = true; return {}; } }), null);
  assert.equal(called, false);
});

test('Bitbucket me reads your slug off one of your PRs, null when you have none', async () => {
  assert.equal(await bitbucket.me({ api: async () => ({ values: [{ author: { user: { slug: 'me' } } }] }) }), 'me');
  assert.equal(await bitbucket.me({ api: async () => ({ values: [] }) }), null);
  assert.equal(await bitbucket.me({ api: async () => null }), null);
});

test('combinePrs makes one row from a ticket\'s PRs, and none until it merged with nothing open', () => {
  const d = (opened, merged, extra = {}) => ({ state: merged ? 'MERGED' : 'OPEN', title: `t${opened}`, createdAt: `2026-11-0${opened}T00:00:00Z`, mergedAt: merged ? `2026-11-0${merged}T00:00:00Z` : null, additions: 10, deletions: 5, commits: [], ...extra });
  const row = combinePrs([['u2', d(3, 4)], ['u1', d(1, 2, { commits: [{ committedDate: '2026-11-01T12:00:00Z' }] })], ['u0', { state: 'CLOSED', mergedAt: null }]]);
  assert.deepEqual(row, { pr: 'u2', title: 't3', mergedAt: Date.parse('2026-11-04T00:00:00Z'), prCount: 2, openedAt: Date.parse('2026-11-01T00:00:00Z'), size: 30, rework: 1 });
  assert.equal(combinePrs([['u2', d(3, null)], ['u1', d(1, 2)]]), null);
  assert.equal(combinePrs([]), null);
});

test('a kickoff file rewritten after the first PR opened gives no lead time, not a short one', async () => {
  const root = await mkRun({ 'ACME-1/ACME-2/KICKOFF.md': 'x', 'ACME-1/ACME-2/REPORT.md': 'x' });
  const rewritten = Date.parse('2026-11-02T02:00:00Z') / 1000;
  await utimes(join(root, 'ACME-1', 'ACME-2', 'KICKOFF.md'), rewritten, rewritten);
  const url = 'https://github.com/o/r/pull/2';
  const m = await processMetrics([{ root, epic: 'ACME-1', tickets: [{ ticket: 'ACME-2', pr: url, prs: [url], updatedAt: 0 }] }], {
    prs: async () => new Map([[url, { state: 'MERGED', title: 't', createdAt: '2026-11-02T00:00:00Z', mergedAt: '2026-11-02T03:00:00Z', commits: [] }]]),
    transcripts: async () => ({ waits: [], marks: [] }),
  });
  assert.equal(m.tickets[0].seg.lead, null);
  assert.equal(m.tickets[0].seg.approx, true);
});

test('a peer\'s review-only tickets are tagged with their machine, and read its times from what it sent', async () => {
  const { peerReviewOnly } = await import('../lib/peers.mjs');
  const url = 'https://github.com/o/r/pull/7';
  const peers = [{ name: 'other', value: { reviewOnly: [{ ticket: 'ACME-7', root: 'D:/theirs', pr: url, prs: [url], step: 'done' }, { ticket: 'ACME-8', machine: 'third', pr: url }] } },
    { name: 'older', value: { runs: [] } }]; // a peer on an older Cleon sends none
  const reviewOnly = peerReviewOnly(peers);
  assert.deepEqual(reviewOnly.map(t => [t.ticket, t.machine]), [['ACME-7', 'other']]);
  const review = Date.parse('2026-11-02T01:00:00Z');
  const m = await processMetrics([], {
    reviewOnly,
    peers: [{ name: 'other', input: { marks: [], waits: [], times: { 'ACME-7': { review } } } }],
    prs: async () => new Map([[url, { state: 'MERGED', title: 't', createdAt: '2026-11-02T00:00:00Z', mergedAt: '2026-11-02T03:00:00Z', commits: [] }]]),
    transcripts: async () => ({ waits: [], marks: [] }),
  });
  assert.equal(m.tickets[0].seg.selfReview, H);
  assert.equal(m.tickets[0].seg.mergeWait, 2 * H);
});

test('processInputs sends a review-only ticket\'s times for a peer\'s Process panel', async () => {
  const { processInputs } = await import('../lib/metrics.mjs');
  const root = await mkRun({ 'delegate/ACME-7/REVIEW_REPORT.md': 'x' });
  const at = Date.parse('2026-11-02T01:00:00Z') / 1000;
  await utimes(join(root, 'delegate', 'ACME-7', 'REVIEW_REPORT.md'), at, at);
  const url = 'https://github.com/o/r/pull/7';
  const input = await processInputs([], { reviewOnly: [{ ticket: 'ACME-7', root, pr: url, prs: [url], step: 'done' }], transcripts: async () => ({ waits: [], marks: [] }) });
  assert.deepEqual(input.times['ACME-7'], { kickoff: null, plan: null, report: null, review: at * 1000 });
});

test('processMetrics counts a review-only ticket, with the stages it has no files for left out', async () => {
  const root = await mkRun({ 'delegate/ACME-7/REVIEW_REPORT.md': 'x' });
  const reviewed = Date.parse('2026-11-02T01:00:00Z') / 1000;
  await utimes(join(root, 'delegate', 'ACME-7', 'REVIEW_REPORT.md'), reviewed, reviewed);
  const url = 'https://github.com/o/r/pull/7';
  const m = await processMetrics([], {
    reviewOnly: [{ ticket: 'ACME-7', root, pr: url, prs: [url], step: 'done' }],
    prs: async () => new Map([[url, { state: 'MERGED', title: 'by hand', createdAt: '2026-11-02T00:00:00Z', mergedAt: '2026-11-02T03:00:00Z', additions: 1, deletions: 1, commits: [] }]]),
    transcripts: async () => ({ waits: [], marks: [] }),
  });
  const [t] = m.tickets;
  assert.equal(t.ticket, 'ACME-7');
  assert.equal(t.epic, null);
  assert.equal(t.seg.approx, true);
  assert.equal(t.seg.planning, null);
  assert.equal(t.seg.lead, null);
  assert.equal(t.seg.selfReview, H);
  assert.equal(t.seg.mergeWait, 2 * H);
});
