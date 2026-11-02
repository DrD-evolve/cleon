// Bitbucket Server / Data Center through its REST API and a read-only HTTP access token. Returns the
// same shapes as lib/github.mjs: my open PRs (with CI and review state) and PRs waiting on my review.
// Bitbucket has no issues; Linear covers them.
import { summarizeChecks } from './github.mjs';
import { BITBUCKET_URL, BITBUCKET_TOKEN } from './config.mjs';

export const NAME = 'Bitbucket';
const BASE = BITBUCKET_URL?.replace(/\/+$/, '') ?? null;

// GET a REST path on the configured server: parsed JSON, or null on any failure (including no config).
async function call(path) {
  if (!BASE || !BITBUCKET_TOKEN) return null;
  try {
    const r = await fetch(BASE + path, {
      headers: { authorization: `Bearer ${BITBUCKET_TOKEN}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const iso = ms => (ms ? new Date(ms).toISOString() : null);
const STATE = { OPEN: 'OPEN', MERGED: 'MERGED', DECLINED: 'CLOSED' }; // in gh's words

// Pure: { project, repo, id } from a PR's web address, or null. Personal repos (/users/<u>/repos/…) are
// project "~<u>" in the REST API. Only addresses on the configured server parse, so the token is never
// sent anywhere else.
export function parsePrUrl(url, base = BASE) {
  if (!base || typeof url !== 'string' || !url.startsWith(`${base}/`)) return null;
  const m = url.slice(base.length).match(/^\/(projects|users)\/([\w.-]+)\/repos\/([\w.-]+)\/pull-requests\/(\d+)(?:\/[a-z]+)?\/?$/i);
  return m ? { project: m[1].toLowerCase() === 'users' ? `~${m[2]}` : m[2], repo: m[3], id: Number(m[4]) } : null;
}
const prPath = ({ project, repo, id }) => `/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests/${id}`;
const buildsPath = sha => `/rest/build-status/1.0/commits/${sha}?limit=100`;

// Pure: the reviewers' verdict in gh's words: any "needs work" wins, then all approved; null with no reviewers.
export function reviewDecision(reviewers = []) {
  if (!reviewers.length) return null;
  if (reviewers.some(r => r.status === 'NEEDS_WORK')) return 'CHANGES_REQUESTED';
  return reviewers.every(r => r.status === 'APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
}

// Pure: one Bitbucket PR in lib/github.mjs's PR shape (without `checks`). The repository name is the
// target repo's slug, which is what a clone's git remote ends in.
export const toPr = p => ({
  repository: { name: p.toRef?.repository?.slug ?? null }, number: p.id, title: p.title,
  updatedAt: iso(p.updatedDate), isDraft: Boolean(p.draft), url: p.links?.self?.[0]?.href ?? null,
  body: p.description ?? '', author: { login: p.author?.user?.slug ?? null },
  reviewDecision: reviewDecision(p.reviewers), branch: p.fromRef?.displayId ?? null,
});

// Pure: build statuses as `gh pr checks --json` entries, for summarizeChecks(). Bitbucket keeps one
// timestamp per build (its latest update) and has no queued state, so in progress reads as running.
const BUCKET = { SUCCESSFUL: 'pass', FAILED: 'fail', INPROGRESS: 'pending', CANCELLED: 'cancel' };
export const toChecks = builds => builds.map(b => ({
  name: b.name || b.key, bucket: BUCKET[b.state] ?? 'skipping', link: b.url,
  state: b.state === 'INPROGRESS' ? 'IN_PROGRESS' : b.state,
  startedAt: b.state === 'INPROGRESS' ? iso(b.dateAdded) : null,
  completedAt: b.state === 'INPROGRESS' ? null : iso(b.dateAdded),
}));

// Pure: one word for a PR's CI, as checkState() gives for GitHub.
export const buildState = checks => !checks.length ? 'none'
  : checks.some(c => c.bucket === 'fail' || c.bucket === 'cancel') ? 'failing'
  : checks.some(c => c.bucket === 'pending') ? 'pending' : 'passing';

// Pure: lines added and removed in a pull-request diff response.
export function diffSize(diff) {
  const n = { additions: 0, deletions: 0 };
  for (const d of diff?.diffs ?? []) for (const h of d.hunks ?? []) for (const s of h.segments ?? []) {
    if (s.type === 'ADDED') n.additions += s.lines?.length ?? 0;
    else if (s.type === 'REMOVED') n.deletions += s.lines?.length ?? 0;
  }
  return n;
}

const DASHBOARD = '/rest/api/1.0/dashboard/pull-requests?state=OPEN';

export async function bitbucketSummary(api = call) {
  const [mine, reviews] = await Promise.all([
    api(`${DASHBOARD}&role=AUTHOR&limit=10`),
    // Bitbucket filters by your reviewer status, so this is only PRs you haven't approved or marked.
    api(`${DASHBOARD}&role=REVIEWER&participantStatus=UNAPPROVED&limit=30`),
  ]);
  if (!mine && !reviews) return { online: false, reason: 'Bitbucket request failed — check BITBUCKET_URL and BITBUCKET_TOKEN in .env' };
  const myPrs = await Promise.all((mine?.values ?? []).map(async p => {
    const sha = p.fromRef?.latestCommit;
    const builds = sha ? (await api(buildsPath(sha)))?.values ?? [] : [];
    return { ...toPr(p), checks: buildState(toChecks(builds)) };
  }));
  return { online: true, myPrs, reviewRequests: (reviews?.values ?? []).map(toPr), issues: [] };
}

// CI checks for one PR's latest commit, in prChecks()'s shape from lib/github.mjs.
export async function prChecks(url, { base = BASE, api = call } = {}) {
  const pr = parsePrUrl(url, base);
  const sha = pr && (await api(prPath(pr)))?.fromRef?.latestCommit;
  const builds = sha && await api(buildsPath(sha));
  return builds ? { url, ...summarizeChecks(toChecks(builds.values ?? [])), at: Date.now() } : null;
}

// A PR's state (OPEN, CLOSED or MERGED), or null when the request fails.
export async function prState(url, { base = BASE, api = call } = {}) {
  const pr = parsePrUrl(url, base);
  const p = pr && await api(prPath(pr));
  return p ? STATE[p.state] ?? null : null;
}

// One PR's state, dates, size and commits in `gh pr view --json` names, or null when any request fails
// (so a merged PR is never cached with a partial answer). Bitbucket doesn't count lines; the diff does.
export async function prDetail(url, { base = BASE, api = call } = {}) {
  const pr = parsePrUrl(url, base);
  if (!pr) return null;
  const [p, commits, diff] = await Promise.all([
    api(prPath(pr)), api(`${prPath(pr)}/commits?limit=1000`), api(`${prPath(pr)}/diff?contextLines=0&withComments=false`),
  ]);
  if (!p || !commits || !diff) return null;
  return {
    state: STATE[p.state] ?? null, title: p.title, createdAt: iso(p.createdDate),
    mergedAt: p.state === 'MERGED' ? iso(p.closedDate) : null, ...diffSize(diff),
    commits: (commits.values ?? []).map(c => ({ committedDate: iso(c.committerTimestamp) })),
  };
}
