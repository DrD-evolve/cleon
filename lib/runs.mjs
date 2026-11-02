// Orchestration runs, read through the orchestration adapter (lib/adapters/; layout in docs/RUN-FORMAT.md):
// <RUNS_DIR>/<EPIC>/{fleet, workspace, watch dir, <TICKET>/{stage files, PR, artifacts}}
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { ROOT, RUNS_DIR, PLANS_DIR } from './config.mjs';
import { categories } from './projects.mjs';
import { prState } from './github.mjs';
import adapter from './adapters/index.mjs';

// Pure: where one config puts runs and plans (the adapter decides).
export const locationsOf = cfg => adapter.locations(cfg ?? {});

// Every runs/plans dir in use: the tool's global options (settings.json) plus each repo under ROOT
// that has its own config file. Re-read every minute, so a repo's new orchestration shows up.
let locCache = { at: 0, value: null };
export async function runLocations() {
  if (locCache.value && Date.now() - locCache.at < 60_000) return locCache.value;
  const json = p => readFile(p, 'utf8').then(JSON.parse, () => null);
  const settings = await json(join(os.homedir(), '.claude', 'settings.json'));
  const global = locationsOf(Object.entries(settings?.pluginConfigs ?? {}).find(([k]) => k.startsWith(adapter.settingsKey))?.[1]?.options);
  const configs = [global];
  for (const category of await categories()) {
    for (const d of await readdir(join(ROOT, category), { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      const cfg = await json(join(ROOT, category, d.name, adapter.repoConfig));
      if (cfg) { const l = locationsOf(cfg); configs.push({ runs: l.runs ?? global.runs, plans: l.plans ?? global.plans }); }
    }
  }
  const uniq = list => [...new Map(list.filter(Boolean).map(p => [resolve(p).toLowerCase(), p])).values()];
  locCache = { at: Date.now(), value: { runs: uniq([...configs.map(c => c.runs), RUNS_DIR]), plans: uniq([...configs.map(c => c.plans), PLANS_DIR]) } };
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
// `lookup`: a PR URL's GitHub state (tests pass a stub).
export async function listRuns(dirs, { lookup = cachedPrState } = {}) {
  dirs = dirs ? [dirs].flat() : (await runLocations()).runs;
  const runs = [];
  for (const dir of dirs) await collectRuns(dir, runs);
  await reconcileWithGitHub(runs, lookup);
  return finishRuns(runs);
}

// Watchers die (shells reaped under memory pressure) before recording a merge, leaving the run
// files short of MERGED. So a non-done ticket with a PR is checked on GitHub. MERGED is cached for
// good; anything else, gh failures included, for a few minutes. A failure never marks a ticket done.
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

async function reconcileWithGitHub(runs, lookup) {
  const open = runs.flatMap(r => r.tickets).filter(t => t.pr && t.step !== 'done' && t.prState !== 'MERGED');
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
