// GitHub through the already-authenticated `gh` CLI: my PRs (with CI + review state),
// PRs waiting on my review, and issues assigned to me.
import { execFile } from 'node:child_process';

// `tolerant`: keep stdout despite a non-zero exit — `gh pr checks` exits 8 while checks are pending.
const gh = (args, tolerant = false) => new Promise(resolve =>
  execFile('gh', args, { timeout: 20000, windowsHide: true, maxBuffer: 20e6 }, (err, out) => {
    try { resolve(err && !tolerant ? null : JSON.parse(out)); } catch { resolve(null); }
  }));

const PR_FIELDS = 'repository,number,title,updatedAt,isDraft,url,body,author';

// Pure: collapse a statusCheckRollup (CheckRuns + StatusContexts) to one word.
export function checkState(rollup) {
  if (!rollup?.length) return 'none';
  const bad = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  if (rollup.some(c => bad.has(c.conclusion) || bad.has(c.state))) return 'failing';
  if (rollup.some(c => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED')) return 'pending';
  return 'passing';
}

export async function githubSummary() {
  const [mine, reviews, issues] = await Promise.all([
    gh(['search', 'prs', '--author=@me', '--state=open', '--json', PR_FIELDS, '--limit', '30']),
    gh(['search', 'prs', '--review-requested=@me', '--state=open', '--json', PR_FIELDS, '--limit', '30']),
    gh(['search', 'issues', '--assignee=@me', '--state=open', '--json', 'repository,number,title,updatedAt,url,body', '--limit', '30']),
  ]);
  if (!mine && !reviews && !issues) return { online: false, reason: 'gh search failed — check `gh auth status`' };
  const myPrs = await Promise.all((mine ?? []).slice(0, 10).map(async p => {
    const v = await gh(['pr', 'view', p.url, '--json', 'statusCheckRollup,reviewDecision,headRefName']);
    return { ...p, checks: checkState(v?.statusCheckRollup), reviewDecision: v?.reviewDecision || null, branch: v?.headRefName ?? null };
  }));
  return { online: true, myPrs, reviewRequests: reviews ?? [], issues: issues ?? [] };
}

// CI checks for one PR, split into mutation-testing jobs ("mutations · <module>") and the rest.
export const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const BUCKET_ORDER = ['fail', 'cancel', 'pending', 'pass', 'skipping'];
const realTime = t => (t && !t.startsWith('0001-') ? t : null); // gh reports "not yet" as year 1

// Pure: normalise `gh pr checks --json` output and count mutation progress. A pending check is
// running only when its state is IN_PROGRESS — queued jobs carry a start time too, so the time
// can't tell them apart. Within pending, running sorts before queued.
export function summarizeChecks(list) {
  const checks = list.map(c => ({
    name: c.name, bucket: c.bucket, link: c.link,
    running: c.bucket === 'pending' && c.state === 'IN_PROGRESS',
    startedAt: realTime(c.startedAt), completedAt: realTime(c.completedAt),
    mutation: /^mutations\b/i.test(c.name),
  })).sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
    || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
  const m = checks.filter(c => c.mutation);
  const mutations = m.length ? {
    total: m.length,
    done: m.filter(c => c.bucket !== 'pending').length,
    running: m.filter(c => c.running).length,
    failed: m.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').length,
  } : null;
  return { checks, mutations };
}

export async function prChecks(url, run = gh) {
  if (!PR_URL.test(url)) return null;
  const list = await run(['pr', 'checks', url, '--json', 'name,state,bucket,link,startedAt,completedAt'], true);
  return list ? { url, ...summarizeChecks(list), at: Date.now() } : null;
}
