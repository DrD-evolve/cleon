// GitHub through the already-authenticated `gh` CLI: my PRs (with CI + review state),
// PRs waiting on my review, and issues assigned to me.
import { execFile } from 'node:child_process';

const gh = args => new Promise(resolve =>
  execFile('gh', args, { timeout: 20000, windowsHide: true, maxBuffer: 20e6 }, (err, out) => {
    try { resolve(err ? null : JSON.parse(out)); } catch { resolve(null); }
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
