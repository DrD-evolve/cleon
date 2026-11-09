// Which of your open PRs each live session is working on: PRs in the session folder's repo (its git
// remote) that the session mentions in its recent activity ("PR #148", ".../pull/148",
// ".../pull-requests/148"), newest first.
import { execFile } from './bin.mjs'; // not node's: see bin.mjs
import { EXCLUDE } from './config.mjs';
import { transcriptPath, readActivity } from './orchestrators.mjs';

const remotes = new Map(); // cwd → repo name (or null); a folder's remote rarely changes
const repoOf = cwd => remotes.has(cwd) ? Promise.resolve(remotes.get(cwd)) : new Promise(resolve =>
  execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 5000, windowsHide: true }, (err, out) => {
    const name = err ? null : out.trim().match(/([^/:]+?)(?:\.git)?$/)?.[1]?.toLowerCase() ?? null;
    remotes.set(cwd, name);
    resolve(name);
  }));

// Pure: PR numbers a piece of text mentions, in order of appearance.
export const prMentions = text => [...String(text ?? '').matchAll(/(?:\bPRs?\s*#?|\/pull(?:-requests)?\/|(?<![\w/])#)(\d{1,6})\b/gi)].map(m => Number(m[1]));

// Pure: the session's PRs among `prs` (your open PRs), latest mention first.
export function sessionPrs(texts, repo, prs) {
  const mine = prs.filter(p => p.repository?.name?.toLowerCase() === repo);
  const order = texts.flatMap(prMentions).reverse();
  return [...new Set(order)].map(n => mine.find(p => p.number === n)).filter(Boolean).map(p => p.url);
}

// { sessionId: [pr url, …] } for live sessions with at least one.
export async function listSessionPrs(sessions, prs) {
  const out = {};
  if (!prs?.length) return out;
  for (const s of sessions.filter(s => s.alive && !EXCLUDE.test(s.cwd ?? ''))) {
    const repo = s.cwd && await repoOf(s.cwd);
    const path = repo && await transcriptPath(s.id);
    if (!path || EXCLUDE.test(path)) continue;
    const act = await readActivity(path);
    const urls = sessionPrs([...act.events.map(e => e.text), act.intent ?? ''], repo, prs);
    if (urls.length) out[s.id] = urls;
  }
  return out;
}
