// Orchestration runs written by the orchestration plugin's herdr/cmux mode:
// <RUNS_DIR>/<EPIC>/{fleet.tsv, herdr-workspace, .watch-state/*, <TICKET>/{STAGE, REVIEW_STAGE, PR, *.md}}
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const RUNS_DIR = 'C:/wt/.orchestrate-runs';
export const PLANS_DIR = 'C:/wt/plans';

// Lifecycle from skills/orchestrate-work/SKILL.md, collapsed to what the files can show.
export const FLOW = [
  { id: 'queued', label: 'Queued' },
  { id: 'planning', label: 'Planning' },
  { id: 'plan-gate', label: 'Plan gate', you: true },
  { id: 'implementing', label: 'Implementing' },
  { id: 'self-review', label: 'Self-review' },
  { id: 'human-review', label: 'Review · merge', you: true },
  { id: 'done', label: 'Done' },
];

const TICKET_RE = /^[A-Z]+-\d+$/;
const ARTIFACTS = ['KICKOFF.md', 'PLAN.md', 'REPORT.md', 'REDIRECT.md', 'REVIEW_KICKOFF.md', 'REVIEW_REPORT.md'];

// A worker that can't proceed writes STAGE=blocked (reason in BLOCKED), overwriting its stage, so
// where it stopped is read from its artifacts: it's held before the first step whose output is missing.
const HELD_BEFORE = [['PLAN.md', 'planning'], ['REPORT.md', 'implementing'], ['REVIEW_REPORT.md', 'self-review']];

// Pure: map the raw stage files to a FLOW step.
export function deriveStep({ stage, reviewStage, prState, files = [] }) {
  if (prState === 'MERGED') return { step: 'done' };
  if (stage === 'blocked') return { step: HELD_BEFORE.find(([f]) => !files.includes(f))?.[1] ?? 'human-review', held: true };
  if (stage === 'failed' || reviewStage === 'review-failed') return { step: stage === 'failed' ? 'implementing' : 'self-review', failed: true };
  if (['queued', 'planning', 'plan-gate', 'implementing'].includes(stage)) {
    return { step: stage, fixRound: stage === 'implementing' && Boolean(reviewStage) };
  }
  if (reviewStage === 'review-done') return { step: 'human-review' };
  if (stage === 'report-done' || reviewStage === 'review-running') return { step: 'self-review' };
  return { step: stage && FLOW.some(f => f.id === stage) ? stage : 'queued' };
}

const read = p => readFile(p, 'utf8').then(s => s.trim(), () => null);

export function parseFleet(tsv) {
  return (tsv ?? '').split(/\r?\n/).filter(Boolean).map(l => {
    const [ticket, role, tab, pane, , lane] = l.split('\t');
    return { ticket, role, tab, pane, lane };
  });
}

export async function listRuns(dir = RUNS_DIR) {
  const epics = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && TICKET_RE.test(d.name)).map(d => d.name);
  const runs = [];
  for (const epic of epics) {
    const root = join(dir, epic);
    const fleet = parseFleet(await read(join(root, 'fleet.tsv')));
    const [wsId, ...wsLabel] = (await read(join(root, 'herdr-workspace')) ?? '').split('\t');
    const ticketDirs = (await readdir(root, { withFileTypes: true }))
      .filter(d => d.isDirectory() && TICKET_RE.test(d.name)).map(d => d.name);
    const tickets = [];
    for (const t of new Set([...ticketDirs, ...fleet.map(f => f.ticket)])) {
      const td = join(root, t);
      const raw = {
        stage: await read(join(td, 'STAGE')) ?? await read(join(root, '.watch-state', `${t}.stage`)),
        reviewStage: await read(join(td, 'REVIEW_STAGE')),
        prState: await read(join(root, '.watch-state', `${t}.pr`)),
      };
      const files = (await readdir(td).catch(() => [])).filter(f => ARTIFACTS.includes(f));
      const panes = fleet.filter(f => f.ticket === t);
      const mtime = p => stat(p).then(s => s.mtimeMs, () => 0);
      const since = Math.max(await mtime(join(td, 'STAGE')), await mtime(join(td, 'REVIEW_STAGE')),
        await mtime(join(root, '.watch-state', `${t}.stage`)));
      tickets.push({
        ticket: t, ...raw, ...deriveStep({ ...raw, files }), files,
        blockedOn: raw.stage === 'blocked' ? await read(join(td, 'BLOCKED')) : null,
        pr: await read(join(td, 'PR')),
        active: panes.some(p => p.lane === 'active'),
        panes,
        since: since || null,
        updatedAt: (await stat(td).catch(() => null))?.mtimeMs ?? 0,
      });
    }
    // No live pane and not merged: the run was abandoned or its watcher died mid-flow.
    for (const t of tickets) t.stale = !t.active && t.step !== 'done';
    tickets.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
    const updatedAt = (await stat(join(root, 'fleet.tsv')).catch(() => null))?.mtimeMs ?? 0;
    runs.push({ epic, workspace: wsId || null, label: wsLabel.join('\t') || null, tickets, updatedAt,
      active: tickets.some(t => t.active) });
  }
  // A ticket can appear in more than one run (re-dispatched under a different epic). Once it
  // merged anywhere, older copies stuck at an earlier step are history, not work waiting on you.
  const merged = new Set(runs.flatMap(r => r.tickets.filter(t => t.prState === 'MERGED').map(t => t.ticket)));
  for (const r of runs) {
    for (const t of r.tickets) if (merged.has(t.ticket) && t.step !== 'done') Object.assign(t, { step: 'done', mergedElsewhere: true, stale: false });
    r.active = r.tickets.some(t => t.active && t.step !== 'done');
  }
  return { flow: FLOW, runs: runs.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt) };
}

// Only whitelisted artifact names inside a real epic/ticket dir — never an arbitrary path.
export async function readRunFile(epic, ticket, name, dir = RUNS_DIR) {
  if (!TICKET_RE.test(epic ?? '') || !TICKET_RE.test(ticket ?? '')) return null;
  if (name === 'plan') return read(join(PLANS_DIR, `${ticket}-plan.md`));
  if (!ARTIFACTS.includes(name)) return null;
  return read(join(dir, epic, ticket, name));
}
