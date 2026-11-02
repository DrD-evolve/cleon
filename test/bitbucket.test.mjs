import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrUrl, reviewDecision, toPr, toChecks, buildState, diffSize, bitbucketSummary, prChecks, prState, prDetail, call } from '../lib/bitbucket.mjs';
import { summarizeChecks } from '../lib/github.mjs';
import { prNumber } from '../lib/scm.mjs';

const BASE = 'https://bitbucket.example.com';
const URL1 = `${BASE}/projects/PROJ/repos/web-app/pull-requests/42`;
const REST1 = '/rest/api/1.0/projects/PROJ/repos/web-app/pull-requests/42';
const ms = s => Date.parse(s);

// Bitbucket Data Center REST shapes, trimmed to the fields Cleon reads.
const pr = (over = {}) => ({
  id: 42, title: 'Add the thing', description: 'Body', state: 'OPEN', draft: false,
  createdDate: ms('2026-11-01T10:00:00Z'), updatedDate: ms('2026-11-02T09:00:00Z'),
  fromRef: { displayId: 'proj-42-add-thing', latestCommit: 'abc123', repository: { slug: 'web-app' } },
  toRef: { displayId: 'main', repository: { slug: 'web-app' } },
  author: { user: { slug: 'alex' }, status: 'UNAPPROVED' },
  reviewers: [{ user: { slug: 'sam' }, status: 'UNAPPROVED' }],
  links: { self: [{ href: URL1 }] },
  ...over,
});
const build = (key, state, at = '2026-11-02T09:05:00Z') => ({ key, name: key, state, url: `https://ci.example.com/${key}`, dateAdded: ms(at) });

test('parsePrUrl reads project and personal repo PRs on the configured server only', () => {
  assert.deepEqual(parsePrUrl(URL1, BASE), { project: 'PROJ', repo: 'web-app', id: 42 });
  assert.deepEqual(parsePrUrl(`${BASE}/users/alex/repos/notes/pull-requests/7/overview`, BASE), { project: '~alex', repo: 'notes', id: 7 });
  assert.deepEqual(parsePrUrl(`${BASE}/scm/projects/PROJ/repos/web-app/pull-requests/42`, `${BASE}/scm`), { project: 'PROJ', repo: 'web-app', id: 42 });
  // The token goes to BASE, so anything else must not parse.
  for (const bad of ['https://bitbucket.example.com.evil.test/projects/PROJ/repos/web-app/pull-requests/42',
    'https://github.com/o/r/pull/42', `${BASE}/projects/PROJ/repos/web-app/pull-requests/42/../../x`, `${BASE}/projects/PROJ/repos/web-app`, null])
    assert.equal(parsePrUrl(bad, BASE), null, String(bad));
  assert.equal(parsePrUrl(URL1, null), null);
});

test('reviewDecision: needs work wins, then all approved, else review required', () => {
  const r = (...s) => s.map(status => ({ status }));
  assert.equal(reviewDecision([]), null);
  assert.equal(reviewDecision(r('APPROVED', 'NEEDS_WORK')), 'CHANGES_REQUESTED');
  assert.equal(reviewDecision(r('APPROVED', 'APPROVED')), 'APPROVED');
  assert.equal(reviewDecision(r('APPROVED', 'UNAPPROVED')), 'REVIEW_REQUIRED');
});

test('toPr gives the GitHub adapter\'s PR shape', () => {
  assert.deepEqual(toPr(pr({ draft: true })), {
    repository: { name: 'web-app' }, number: 42, title: 'Add the thing', updatedAt: '2026-11-02T09:00:00.000Z',
    isDraft: true, url: URL1, body: 'Body', author: { login: 'alex' }, reviewDecision: 'REVIEW_REQUIRED', branch: 'proj-42-add-thing',
  });
});

test('build statuses map to gh checks: in progress runs, failures lead, cancelled fails the PR', () => {
  const checks = toChecks([build('unit', 'SUCCESSFUL'), build('mutations · core', 'INPROGRESS'), build('lint', 'FAILED')]);
  assert.deepEqual(checks.map(c => [c.name, c.bucket]), [['unit', 'pass'], ['mutations · core', 'pending'], ['lint', 'fail']]);
  assert.equal(checks[0].completedAt, '2026-11-02T09:05:00.000Z');
  assert.equal(checks[1].startedAt, '2026-11-02T09:05:00.000Z');
  const s = summarizeChecks(checks);
  assert.deepEqual(s.checks.map(k => [k.name, k.running]), [['lint', false], ['mutations · core', true], ['unit', false]]);
  assert.deepEqual(s.mutations, { total: 1, done: 0, running: 1, failed: 0 });
  assert.equal(buildState([]), 'none');
  assert.equal(buildState(toChecks([build('a', 'SUCCESSFUL')])), 'passing');
  assert.equal(buildState(toChecks([build('a', 'SUCCESSFUL'), build('b', 'INPROGRESS')])), 'pending');
  assert.equal(buildState(toChecks([build('a', 'CANCELLED'), build('b', 'INPROGRESS')])), 'failing');
});

test('diffSize counts added and removed lines, not context', () => {
  const seg = (type, n) => ({ type, lines: Array.from({ length: n }, () => ({})) });
  assert.deepEqual(diffSize({ diffs: [{ hunks: [{ segments: [seg('ADDED', 3), seg('CONTEXT', 5), seg('REMOVED', 2)] }] }, { hunks: [{ segments: [seg('ADDED', 1)] }] }] }),
    { additions: 4, deletions: 2 });
  assert.deepEqual(diffSize(null), { additions: 0, deletions: 0 });
});

test('bitbucketSummary: my PRs with CI and review state, unapproved review requests, no issues', async () => {
  const asked = [];
  const api = async path => {
    asked.push(path);
    if (path.includes('role=AUTHOR')) return { values: [pr()] };
    if (path.includes('role=REVIEWER')) return { values: [pr({ id: 9, title: 'Review me' })] };
    if (path === '/rest/build-status/1.0/commits/abc123?limit=100') return { values: [build('unit', 'FAILED')] };
    return null;
  };
  const s = await bitbucketSummary(api);
  assert.equal(s.online, true);
  assert.deepEqual(s.myPrs.map(p => [p.number, p.checks, p.reviewDecision]), [[42, 'failing', 'REVIEW_REQUIRED']]);
  assert.deepEqual(s.reviewRequests.map(p => p.title), ['Review me']);
  assert.deepEqual(s.issues, []);
  assert.ok(asked.some(p => /role=REVIEWER.*participantStatus=UNAPPROVED/.test(p)));
  assert.deepEqual(await bitbucketSummary(async () => null), { online: false, reason: 'Bitbucket request failed — check BITBUCKET_URL and BITBUCKET_TOKEN in .env' });
});

test('prChecks reads the builds of the PR\'s latest commit', async () => {
  const api = async path => path === REST1 ? pr() : path.startsWith('/rest/build-status/1.0/commits/abc123') ? { values: [build('unit', 'INPROGRESS')] } : null;
  const c = await prChecks(URL1, { base: BASE, api });
  assert.equal(c.url, URL1);
  assert.deepEqual(c.checks.map(k => [k.name, k.bucket, k.running]), [['unit', 'pending', true]]);
  assert.equal(await prChecks(URL1, { base: BASE, api: async () => null }), null);
});

test('prState reads OPEN, MERGED and DECLINED (as CLOSED), and never asks about a foreign URL', async () => {
  for (const [state, want] of [['OPEN', 'OPEN'], ['MERGED', 'MERGED'], ['DECLINED', 'CLOSED']])
    assert.equal(await prState(URL1, { base: BASE, api: async p => (p === REST1 ? { state } : null) }), want);
  assert.equal(await prState(URL1, { base: BASE, api: async () => null }), null);
  let called = false;
  assert.equal(await prState('https://evil.example/projects/P/repos/r/pull-requests/1', { base: BASE, api: async () => { called = true; return { state: 'MERGED' }; } }), null);
  assert.equal(called, false);
});

test('prDetail gives gh pr view\'s fields, and nothing when any request fails', async () => {
  const merged = pr({ state: 'MERGED', closedDate: ms('2026-11-02T12:00:00Z') });
  const parts = {
    [REST1]: merged,
    [`${REST1}/commits?limit=1000`]: { values: [{ committerTimestamp: ms('2026-11-01T09:00:00Z') }, { committerTimestamp: ms('2026-11-01T15:00:00Z') }] },
    [`${REST1}/diff?contextLines=0&withComments=false`]: { diffs: [{ hunks: [{ segments: [{ type: 'ADDED', lines: [{}, {}] }, { type: 'REMOVED', lines: [{}] }] }] }] },
  };
  const d = await prDetail(URL1, { base: BASE, api: async p => parts[p] ?? null });
  assert.deepEqual(d, {
    state: 'MERGED', title: 'Add the thing', createdAt: '2026-11-01T10:00:00.000Z', mergedAt: '2026-11-02T12:00:00.000Z',
    additions: 2, deletions: 1, commits: [{ committedDate: '2026-11-01T09:00:00.000Z' }, { committedDate: '2026-11-01T15:00:00.000Z' }],
  });
  assert.equal(await prDetail(URL1, { base: BASE, api: async p => (p.includes('/diff') ? null : parts[p]) }), null);
});

test('call waits out a rate limit (429 + Retry-After) and tries again, up to 4 attempts', async () => {
  const res = (status, data = {}, retry) => ({ status, ok: status < 300, headers: new Headers(retry ? { 'retry-after': retry } : {}),
    body: { cancel: async () => {} }, json: async () => data });
  const opts = (fetchFn, waits = []) => ({ base: BASE, token: 't', fetchFn, wait: async ms => { waits.push(ms); } });
  let n = 0, waits = [];
  assert.deepEqual(await call('/x', opts(async () => (++n <= 2 ? res(429, null, '2') : res(200, { state: 'MERGED' })), waits)), { state: 'MERGED' });
  assert.equal(n, 3);
  assert.ok(waits.length === 2 && waits.every(ms => ms >= 2000 && ms < 3000), JSON.stringify(waits));
  // Four attempts at most, then null; no Retry-After means 5 s, and a long one is capped at 30 s.
  n = 0; waits = [];
  assert.equal(await call('/x', opts(async () => (n++, res(429)), waits)), null);
  assert.equal(n, 4);
  assert.ok(waits.length === 3 && waits.every(ms => ms >= 5000 && ms < 6000), JSON.stringify(waits));
  waits = [];
  await call('/x', opts(async () => res(429, null, '600'), waits));
  assert.ok(waits.every(ms => ms >= 30000 && ms < 31000), JSON.stringify(waits));
  // Other failures aren't retried.
  n = 0;
  assert.equal(await call('/x', opts(async () => (n++, res(401)))), null);
  assert.equal(n, 1);
  // The token goes to the configured server only, and nothing is sent without one.
  let seen;
  await call('/rest/y', { base: BASE, token: 'secret', fetchFn: async (u, init) => { seen = [u, init.headers.authorization]; return res(200); } });
  assert.deepEqual(seen, [`${BASE}/rest/y`, 'Bearer secret']);
  assert.equal(await call('/x', { base: BASE, token: null, fetchFn: async () => { throw new Error('sent without a token'); } }), null);
});

test('prNumber reads GitHub and Bitbucket PR addresses', () => {
  assert.equal(prNumber('https://github.com/o/r/pull/148'), 148);
  assert.equal(prNumber(URL1), 42);
  assert.equal(prNumber(`${BASE}/users/alex/repos/notes/pull-requests/7/overview`), 7);
  assert.equal(prNumber('https://example.com/nothing'), null);
  assert.equal(prNumber(undefined), null);
});
