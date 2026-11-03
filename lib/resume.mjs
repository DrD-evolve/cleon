// Restart an epic's orchestrator after its session died (a reboot, a closed window): the adapter's
// resumeCommand, in the herdr session of the epic's repo, as an "orchestrator" tab in the epic's own
// workspace when that's live, else in a workspace of its own. The browser names only an epic; its run,
// repo, permission mode and command are all worked out here.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import adapter from './adapters/index.mjs';

const base = p => String(p ?? '').split(/[\\/]/).pop();

// Pure: `git worktree list --porcelain` → [{ path, branch }] (branch null when detached).
export function parseWorktrees(out) {
  return (out ?? '').split(/\r?\n\r?\n/).map(block => {
    const field = k => block.split(/\r?\n/).find(l => l.startsWith(`${k} `))?.slice(k.length + 1) ?? null;
    return { path: field('worktree'), branch: field('branch')?.replace(/^refs\/heads\//, '') ?? null };
  }).filter(w => w.path);
}

// Pure: does a worktree belong to one of these ids? Its folder name or branch must carry the id whole,
// in any case (ACME-58 never matches ACME-588). Ids match adapter.idPattern, so they're safe in a regex.
const carries = (s, id) => new RegExp(`(^|[^a-z0-9])${id}($|[^0-9])`, 'i').test(s ?? '');
export const worktreeFor = (w, ids) => ids.some(id => carries(base(w.path), id) || carries(w.branch, id));

const gitWorktrees = repo => new Promise(r => execFile('git', ['-C', repo, 'worktree', 'list', '--porcelain'],
  { timeout: 5000, windowsHide: true }, (e, out) => r(e ? [] : parseWorktrees(out))));

// The repo an epic runs in: of `repos`, the one whose worktrees carry the epic's or a ticket's id. A run
// folder doesn't say (runs roots are shared between repos), but each ticket's worktree does.
export async function epicRepo(ids, repos, worktreesOf = gitWorktrees) {
  const hits = [];
  for (const repo of repos) if ((await worktreesOf(repo)).some(w => worktreeFor(w, ids))) hits.push(repo);
  if (hits.length === 1) return { repo: hits[0] };
  return { reason: hits.length ? `worktrees for it are in more than one repo (${hits.map(base).join(', ')})`
    : 'no repo has a worktree named for it or its tickets' };
}

// Claude Code's --permission-mode choices; the orchestration plugin records the mode in this spelling.
const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

// The permission mode the epic's last orchestrator ran in: the most recently written record among its
// tickets, or null when none holds a known mode.
export async function lastMode(runsDir, epic, tickets) {
  const name = adapter.files.permissionMode;
  if (!name) return null;
  let best = null;
  for (const t of tickets) {
    const p = join(runsDir, epic, t, name);
    const [text, s] = await Promise.all([readFile(p, 'utf8').catch(() => null), stat(p).catch(() => null)]);
    const mode = text?.trim();
    if (MODES.includes(mode) && (!best || s.mtimeMs > best.at)) best = { mode, at: s.mtimeMs };
  }
  return best?.mode ?? null;
}

// Epic → when a restart was started here. A new orchestrator takes a while to show up as live, so a
// second click inside this window is refused rather than starting a second orchestrator.
const STARTED = new Map();
const SETTLE_MS = 3 * 60_000;

// Deps: runs() → listRuns(); orchestrators() → the live ones; repos() → repos with the tool's config;
// findProject(path); start(project, { command, label }) → startInHerdr's result.
export async function restartOrchestrator(epic, { runs, orchestrators, repos, findProject, start, worktreesOf, started = STARTED, now = Date.now() }) {
  if (!adapter.idPattern.test(epic ?? '')) return { ok: false, reason: 'not an epic id' };
  const run = (await runs()).runs.find(r => r.epic === epic);
  if (!run) return { ok: false, reason: `${epic} isn't a listed run` };
  if (run.tickets.every(t => t.step === 'done')) return { ok: false, reason: `every ticket in ${epic} is done` };
  if ((await orchestrators()).some(o => o.epic === epic)) return { ok: false, reason: `${epic} already has a live orchestrator` };
  const ago = now - (started.get(epic) ?? -Infinity);
  if (ago < SETTLE_MS) return { ok: false, reason: `an orchestrator for ${epic} was started ${Math.round(ago / 1000)}s ago and may not show up yet` };
  started.set(epic, now); // claimed before anything else awaits, so two clicks can't both get past here
  const fail = reason => { started.delete(epic); return { ok: false, reason }; };
  const tickets = [...new Set([epic, ...run.tickets.map(t => t.ticket)])];
  const found = await epicRepo(tickets, await repos(), worktreesOf);
  if (!found.repo) return fail(`can't tell which repo ${epic} runs in: ${found.reason}`);
  const project = await findProject(found.repo);
  if (!project) return fail(`${found.repo} isn't a known project`);
  const mode = await lastMode(run.root, epic, tickets);
  // Beside its workers when the epic's workspace is back (herdr restores it with the session), else in its own.
  const tab = run.workspace && run.label ? { workspace: { id: run.workspace, label: run.label }, label: 'orchestrator' } : undefined;
  const r = await start(project, { command: adapter.resumeCommand(epic, mode), label: `${epic} orchestrator`, tab });
  if (!r.ok) return fail(r.reason);
  if (!r.ran) started.delete(epic); // the workspace opened but herdr didn't take the command: let it be retried
  return { ...r, epic, project: project.name, mode };
}
