// Orchestration runs, read through the orchestration adapter (lib/adapters/; layout in docs/RUN-FORMAT.md):
// <RUNS_DIR>/<EPIC>/{fleet, workspace, watch dir, <TICKET>/{stage files, PR, artifacts}}
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { ROOT, RUNS_DIR, PLANS_DIR } from './config.mjs';
import { categories } from './projects.mjs';
import { execFile } from 'node:child_process';
import { prState, repoPrs, me } from './scm.mjs';
import adapter from './adapters/index.mjs';

// Pure: where one config puts runs and plans (the adapter decides).
export const locationsOf = cfg => adapter.locations(cfg ?? {});

// Every runs/plans dir in use: the tool's global options (settings.json) plus each repo under ROOT
// that has its own config file (`repos` lists those repos). Re-read every minute, so a repo's new
// orchestration shows up.
let locCache = { at: 0, value: null };
export async function runLocations() {
  if (locCache.value && Date.now() - locCache.at < 60_000) return locCache.value;
  const json = p => readFile(p, 'utf8').then(JSON.parse, () => null);
  const settings = await json(join(os.homedir(), '.claude', 'settings.json'));
  const global = locationsOf(Object.entries(settings?.pluginConfigs ?? {}).find(([k]) => k.startsWith(adapter.settingsKey))?.[1]?.options);
  const configs = [global], repos = [];
  for (const category of await categories()) {
    for (const d of await readdir(join(ROOT, category), { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      const cfg = await json(join(ROOT, category, d.name, adapter.repoConfig));
      if (cfg) { const l = locationsOf(cfg); configs.push({ runs: l.runs ?? global.runs, plans: l.plans ?? global.plans }); repos.push(join(ROOT, category, d.name)); }
    }
  }
  const uniq = list => [...new Map(list.filter(Boolean).map(p => [resolve(p).toLowerCase(), p])).values()];
  locCache = { at: Date.now(), value: { runs: uniq([...configs.map(c => c.runs), RUNS_DIR]), plans: uniq([...configs.map(c => c.plans), PLANS_DIR]), repos } };
  return locCache.value;
}

// The dashboard's flow. The adapter maps its tool's stage words onto these steps.
export const FLOW = [
  { id: 'queued', label: 'Queued' },
  { id: 'planning', label: 'Planning' },
  { id: 'plan-gate', label: 'Plan gate', you: true },
  { id: 'implementing', label: 'Implementing' },
  { id: 'self-review', label: 'Self-review' },
  { id: 'human-review', label: 'Review · merge', you: true },
  { id: 'done', label: 'Done' },
];

const TICKET_RE = adapter.idPattern;
const ARTIFACTS = adapter.artifacts;
const F = adapter.files;

// Pure: map the raw stage files to a FLOW step.
export const deriveStep = raw => adapter.deriveStep(raw);

const read = p => readFile(p, 'utf8').then(s => s.trim(), () => null);

export function parseFleet(tsv) {
  return (tsv ?? '').split(/\r?\n/).filter(Boolean).map(l => {
    const [ticket, role, tab, pane, , lane] = l.split('\t');
    return { ticket, role, tab, pane, lane };
  });
}

// `dirs`: one runs dir or several; by default every dir the plugin is configured to use.
// `lookup`: a PR URL's state on the source-control host (tests pass a stub).
// `found`: ticket → its PRs on the host (ticketPrs); only the configured dirs look by default.
export async function listRuns(dirs, { lookup = cachedPrState, found = dirs ? null : cachedFoundPrs } = {}) {
  dirs = dirs ? [dirs].flat() : (await runLocations()).runs;
  const runs = [];
  for (const dir of dirs) await collectRuns(dir, runs);
  const byTicket = found ? await found() : new Map();
  for (const t of runs.flatMap(r => r.tickets)) if (!t.pr) attachFound(t, byTicket.get(t.ticket));
  const settled = await settleRuns(runs, { lookup });
  const reviewOnly = await collectReviewOnly(dirs, new Set(runs.flatMap(r => r.tickets.map(t => t.ticket))), byTicket);
  return { ...settled, reviewOnly };
}
// Check open tickets' PRs, then apply the merged-anywhere rule and sort. Also run over this machine's runs
// plus a peer's (lib/peers.mjs), so a peer's PRs are looked up here, where the source-control token is, and
// a ticket merged on either machine reads done on both.
export async function settleRuns(runs, { lookup = cachedPrState } = {}) {
  await reconcileWithScm(runs, lookup);
  return finishRuns(runs);
}

// Pure: ticket → the PRs you wrote for it, newest first as listed. Yours only: in a shared repo a teammate's
// PR can carry the same ticket id, and with no idea who you are (`mine` null) nothing can be claimed.
export function ticketPrs(prs, mine, branchTicket = adapter.branchTicket) {
  const map = new Map();
  if (!mine) return map;
  for (const p of prs) {
    const ticket = p.author === mine ? branchTicket(p.branch) : null;
    if (ticket) map.set(ticket, [...(map.get(ticket) ?? []), p]);
  }
  return map;
}

// Pure: what a ticket's PRs add up to. Done takes a merged PR and none open, so a backport or a second PR
// still in review holds the ticket open. Declined PRs count for nothing. `urls`: the ones that count.
export function prOutcome(prs = []) {
  const open = prs.filter(p => p.state === 'OPEN'), merged = prs.filter(p => p.state === 'MERGED');
  return { urls: [...open, ...merged].map(p => p.url), pr: open[0]?.url ?? merged[0]?.url ?? null, done: !open.length && merged.length > 0 };
}

// Gives a ticket with no PR file the PRs found for it. An earlier PR merging doesn't finish a ticket whose
// worker is still at it, on the next one. The stage matters too: fleet lanes can stay "active" after a run closes.
const WORKING = new Set(['queued', 'planning', 'plan-gate', 'implementing']);
export function attachFound(t, prs) {
  const { urls, pr, done } = prOutcome(prs);
  if (!pr) return;
  Object.assign(t, { pr, prs: urls, prFound: true });
  if (done && !(t.active && WORKING.has(t.step))) Object.assign(t, { prState: 'MERGED', step: 'done', held: undefined, failed: undefined, fixRound: undefined, stale: false });
}

// Every repo with the tool's config, one list per repo however many tickets there are. Fetched at most
// every few minutes and never twice at once. A failure leaves tickets as they were.
const remoteOf = repo => new Promise(ok =>
  execFile('git', ['-C', repo, 'remote', 'get-url', 'origin'], { timeout: 5000, windowsHide: true }, (e, out) => ok(e ? null : out.trim())));
let foundCache = { at: 0, value: null };
function cachedFoundPrs() {
  if (foundCache.value && Date.now() - foundCache.at < PR_TTL) return foundCache.value;
  const value = (async () => {
    const mine = await me();
    if (!mine) return new Map();
    const prs = [];
    for (const repo of (await runLocations()).repos) {
      const remote = await remoteOf(repo);
      prs.push(...(remote && await repoPrs(remote)) || []);
    }
    return ticketPrs(prs, mine);
  })().catch(() => new Map());
  foundCache = { at: Date.now(), value };
  return value;
}

// Tickets with no run of their own, only a self-review folder: work done by hand, or a review of someone
// else's PR. Only tickets with PRs of yours count, which leaves the teammates' reviews out.
async function collectReviewOnly(dirs, inRuns, byTicket) {
  if (!adapter.reviewDir) return [];
  const out = [];
  for (const root of dirs) {
    for (const d of await readdir(join(root, adapter.reviewDir), { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory() || !TICKET_RE.test(d.name) || inRuns.has(d.name)) continue;
      const { urls, pr, done } = prOutcome(byTicket.get(d.name));
      if (pr) { inRuns.add(d.name); out.push({ ticket: d.name, root, pr, prs: urls, step: done ? 'done' : 'self-review' }); }
    }
  }
  return out;
}

// Watchers die (shells reaped under memory pressure) before recording a merge, leaving the run
// files short of MERGED. So a non-done ticket with a PR is checked on GitHub or Bitbucket. MERGED is
// cached for good; anything else, failures included, for a few minutes. A failure never marks a ticket done.
const PR_TTL = 5 * 60_000;
const prCache = new Map();
function cachedPrState(url) {
  const hit = prCache.get(url);
  if (hit && (hit.permanent || Date.now() - hit.at < PR_TTL)) return hit.state;
  const state = prState(url).catch(() => null);
  prCache.set(url, { state, at: Date.now() });
  state.then(s => { if (s === 'MERGED') prCache.set(url, { state, permanent: true }); });
  return state;
}

async function reconcileWithScm(runs, lookup) {
  const open = runs.flatMap(r => r.tickets).filter(t => t.pr && !t.prFound && t.step !== 'done' && t.prState !== 'MERGED');
  await Promise.all(open.map(async t => {
    if (await lookup(t.pr) === 'MERGED') Object.assign(t, { prState: 'MERGED', step: 'done', held: undefined, failed: undefined, fixRound: undefined, stale: false });
  }));
}

async function collectRuns(dir, runs) {
  const epics = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && TICKET_RE.test(d.name)).map(d => d.name);
  for (const epic of epics) {
    const root = join(dir, epic);
    const fleet = parseFleet(await read(join(root, F.fleet)));
    const [wsId, ...wsLabel] = (await read(join(root, F.workspace)) ?? '').split('\t');
    const ticketDirs = (await readdir(root, { withFileTypes: true }))
      .filter(d => d.isDirectory() && TICKET_RE.test(d.name)).map(d => d.name);
    const tickets = [];
    for (const t of new Set([...ticketDirs, ...fleet.map(f => f.ticket)])) {
      const td = join(root, t);
      const raw = {
        stage: await read(join(td, F.stage)) ?? await read(join(root, F.watchDir, `${t}.stage`)),
        reviewStage: await read(join(td, F.reviewStage)),
        prState: await read(join(root, F.watchDir, `${t}.pr`)),
      };
      const files = (await readdir(td).catch(() => [])).filter(f => ARTIFACTS.includes(f));
      const panes = fleet.filter(f => f.ticket === t);
      const mtime = p => stat(p).then(s => s.mtimeMs, () => 0);
      const since = Math.max(await mtime(join(td, F.stage)), await mtime(join(td, F.reviewStage)),
        await mtime(join(root, F.watchDir, `${t}.stage`)));
      tickets.push({
        ticket: t, ...raw, ...deriveStep({ ...raw, files }), files,
        blockedOn: raw.stage === 'blocked' ? await read(join(td, F.blocked)) : null,
        pr: await read(join(td, F.pr)),
        active: panes.some(p => p.lane === 'active'),
        panes,
        since: since || null,
        updatedAt: (await stat(td).catch(() => null))?.mtimeMs ?? 0,
      });
    }
    // No live pane and not merged: the run was abandoned or its watcher died mid-flow.
    for (const t of tickets) t.stale = !t.active && t.step !== 'done';
    tickets.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
    const updatedAt = (await stat(join(root, F.fleet)).catch(() => null))?.mtimeMs ?? 0;
    runs.push({ epic, root: dir, workspace: wsId || null, label: wsLabel.join('\t') || null, tickets, updatedAt,
      active: tickets.some(t => t.active) });
  }
}

function finishRuns(runs) {
  // A ticket can appear in more than one run (re-dispatched under a different epic). Once it
  // merged anywhere, older copies stuck at an earlier step are history, not work waiting on you.
  const merged = new Set(runs.flatMap(r => r.tickets.filter(t => t.prState === 'MERGED').map(t => t.ticket)));
  for (const r of runs) {
    for (const t of r.tickets) if (merged.has(t.ticket) && t.step !== 'done') Object.assign(t, { step: 'done', mergedElsewhere: true, stale: false });
    r.active = r.tickets.some(t => t.active && t.step !== 'done');
  }
  return { flow: FLOW, stepFiles: adapter.stepFiles, runs: runs.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt) };
}

// Only whitelisted artifact names inside a real epic/ticket dir — never an arbitrary path.
// Looks in each configured dir; the first that has the file wins.
export async function readRunFile(epic, ticket, name, dirs, planDirs) {
  if (!TICKET_RE.test(epic ?? '') || !TICKET_RE.test(ticket ?? '')) return null;
  if (name !== 'plan' && !ARTIFACTS.includes(name)) return null;
  const loc = dirs && (name !== 'plan' || planDirs) ? null : await runLocations();
  const paths = name === 'plan'
    ? [planDirs ?? loc.plans].flat().map(d => join(d, adapter.planFile(ticket)))
    : [dirs ?? loc.runs].flat().map(d => join(d, epic, ticket, name));
  for (const p of paths) { const text = await read(p); if (text != null) return text; }
  return null;
}
