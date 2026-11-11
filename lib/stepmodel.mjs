// The model and effort behind each flow step: what ran it (from the transcripts of the sessions that worked
// on the ticket), or, for a step not reached yet, what its role is configured to use. Every assumption about
// the plugin's roles, config and transcript fields is the adapter's (lib/adapters/); this file holds none.
//
// Privacy: only each reply's model, effort and time are kept, never its text. Transcripts under MC_EXCLUDE
// paths, and sessions working in an excluded folder, are never opened.
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECTS_DIR } from './orchestrators.mjs';
import { excludesPath } from './config.mjs';
import { attribute } from './usage.mjs';
import adapter from './adapters/index.mjs';

const parse = s => { try { return JSON.parse(s); } catch { return null; } };

// Pure: fold complete transcript lines into `runs`: consecutive replies on the same model and effort become
// one span { model, effort, from, to }, so a long session stays small.
export function foldReplies(lines, runs = []) {
  for (const line of lines) {
    if (!line.includes(adapter.replyHint ?? '"model"')) continue;
    const r = adapter.replyOf(parse(line));
    if (!r) continue;
    const last = runs.at(-1);
    if (last && last.model === r.model && last.effort === r.effort) {
      if (r.at != null) { last.from = Math.min(last.from ?? r.at, r.at); last.to = Math.max(last.to ?? r.at, r.at); }
    } else runs.push({ model: r.model, effort: r.effort, from: r.at, to: r.at });
  }
  return runs;
}

// One transcript's spans, read once and then only what it has gained (complete lines only).
const cache = new Map();
export async function readRuns(path) {
  if (excludesPath(path)) return [];
  const size = await stat(path).then(s => s.size, () => null);
  if (size == null) return [];
  let c = cache.get(path);
  if (!c || size < c.offset) cache.set(path, c = { offset: 0, runs: [] });
  if (size > c.offset) {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(size - c.offset);
      await fh.read(buf, 0, buf.length, c.offset);
      const text = buf.toString('utf8'), cut = text.lastIndexOf('\n') + 1;
      foldReplies(text.slice(0, cut).split('\n'), c.runs);
      c.offset += Buffer.byteLength(text.slice(0, cut));
    } finally { await fh.close(); }
  }
  return c.runs;
}

// Pure: the distinct values, in the order first seen.
const distinct = xs => [...new Set(xs.filter(Boolean))];
const overlaps = (r, [from, to]) => (to == null || r.from == null || r.from <= to) && (from == null || r.to == null || r.to >= from);

// Pure: the rows for one step. `ran`: [{ actor, model, effort, from, to }] spans of the ticket's sessions;
// `reached`: whether the ticket has got to this step; `config`: { role: { model, effort } } (what each role is
// configured to use); `boundary`: where the planner's session passes from planning to implementing, or null.
// Each row is { role, source, model: [...], effort: [...] }. source: 'ran' (read from transcripts),
// 'configured' (the role's configured values, for a step not reached), or null (nobody knows: both lists are
// empty). What ran is never filled in from the config.
export function stepRows(step, { ran = [], reached = true, config = {}, boundary = null } = {}) {
  return adapter.roleOfStep(step).map(role => {
    if (!reached) {
      const c = config[role] ?? {};
      const model = distinct([c.model]), effort = distinct([c.effort]);
      return { role, source: model.length || effort.length ? 'configured' : null, model, effort };
    }
    const win = adapter.stepWindow(step, role, boundary);
    const spans = ran.filter(r => r.actor === role && overlaps(r, win));
    return { role, source: spans.length ? 'ran' : null, model: distinct(spans.map(s => s.model)), effort: distinct(spans.map(s => s.effort)) };
  });
}

// Pure: a ticket opened without a step: one row per role, from everything its sessions did.
export function roleRows({ ran = [], config = {} } = {}) {
  return Object.keys(config).map(role => {
    const spans = ran.filter(r => r.actor === role);
    if (spans.length) return { role, source: 'ran', model: distinct(spans.map(s => s.model)), effort: distinct(spans.map(s => s.effort)) };
    const model = distinct([config[role].model]), effort = distinct([config[role].effort]);
    return { role, source: model.length || effort.length ? 'configured' : null, model, effort };
  });
}

// The spans of every session that worked on a ticket, by ticket, found through Usage's attribution (which
// survives a closed pane): `files` from scanUsage. A session in an excluded folder, or one whose transcript
// is gone, adds none.
export async function spansByTicket(files, projects = [], dir = PROJECTS_DIR) {
  const mains = new Map(), out = new Map();
  for (const [rel, st] of Object.entries(files)) if (!rel.includes('/subagents/')) mains.set(rel.split('/')[1]?.replace(/\.jsonl$/, ''), attribute(rel, st, projects));
  for (const [rel, st] of Object.entries(files)) {
    if (st.excluded) continue;
    const a = attribute(rel, st, projects, mains.get(rel.split('/')[1])), actor = a.ticket ? adapter.actorOf(a) : null;
    if (!actor) continue;
    const list = out.get(a.ticket) ?? out.set(a.ticket, []).get(a.ticket);
    for (const r of await readRuns(join(dir, ...rel.split('/')))) list.push({ ...r, actor });
  }
  return out;
}

// Pure: the answer for one ticket: `steps` (the rows of every flow step) and `roles` (the rows of a tile opened
// without a step). `flow`: step ids in order; `current`: the ticket's step; `times`: its artifacts' write times.
export function ticketModels({ flow, current, ran = [], config, times }) {
  const at = flow.indexOf(current), boundary = adapter.boundaryOf(ran, times);
  return {
    steps: Object.fromEntries(flow.map((s, i) => [s, stepRows(s, { ran, config, boundary, reached: current === 'done' || i <= at })])),
    roles: roleRows({ ran, config }),
  };
}
