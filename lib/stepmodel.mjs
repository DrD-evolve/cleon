// The model and effort behind each flow step: what ran it (from the transcripts of the sessions that worked
// on the ticket), or, for a step not reached yet, what its role is configured to use. Every assumption about
// the plugin's roles, config and transcript fields is the adapter's (lib/adapters/); this file holds none.
//
// Privacy: only each reply's model, effort and time are kept, never its text. Transcripts under MC_EXCLUDE
// paths, and sessions working in an excluded folder, are never opened.
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECTS_DIR } from './orchestrators.mjs';
import { excludesPath, excludesFolder } from './config.mjs';
import { attribute } from './usage.mjs';
import adapter from './adapters/index.mjs';

const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const fresh = () => ({ runs: [], gates: [], asked: new Set(), events: [] });

// Pure: fold complete transcript lines into `into`: consecutive replies on the same model and effort become
// one span { model, effort, from, to } in `runs`, so a long session stays small; plan-gate answers go to `gates`
// (times). `asked` holds the gate questions waiting for their answer. The steps a reply shows (adapter.stepEventOf,
// on records already parsed here) go to `events` as { n, at }: times only. `ctx`: { verify }, the repo's verify command.
export function foldReplies(lines, into = fresh(), ctx = {}) {
  const askHint = adapter.gateHeader ? JSON.stringify(adapter.gateHeader) : null;
  for (const line of lines) {
    const reply = line.includes(adapter.replyHint ?? '"model"');
    const gate = askHint && (line.includes(askHint) || [...into.asked].some(id => line.includes(id)));
    if (!reply && !gate) continue;
    const rec = parse(line);
    const answered = gate ? adapter.gateAnswerOf?.(rec, into.asked) : null;
    if (answered != null) into.gates.push(answered);
    const r = reply ? adapter.replyOf(rec) : null;
    if (!r) continue;
    for (const e of adapter.stepEventOf?.(rec, ctx) ?? []) into.events.push({ n: e.n, at: e.at });
    const last = into.runs.at(-1);
    if (last && last.model === r.model && last.effort === r.effort) {
      if (r.at != null) { last.from = Math.min(last.from ?? r.at, r.at); last.to = Math.max(last.to ?? r.at, r.at); }
    } else into.runs.push({ model: r.model, effort: r.effort, from: r.at, to: r.at });
  }
  return into;
}

// One transcript's spans and gate answers, read once and then only what it has gained (complete lines only),
// in chunks so a long transcript is never one string.
const cache = new Map();
const CHUNK = 16 << 20;
export async function readRuns(path, ctx = {}) {
  if (excludesPath(path)) return fresh();
  const size = await stat(path).then(s => s.size, () => null);
  if (size == null) { cache.delete(path); return fresh(); }
  let c = cache.get(path);
  // The verify command is a config value, not transcript text; a changed one reads this transcript again.
  const verify = ctx.verify ?? null;
  if (!c || size < c.offset || c.verify !== verify) cache.set(path, c = { offset: 0, verify, ...fresh() });
  if (size > c.offset) {
    const fh = await open(path, 'r');
    try {
      for (let len = CHUNK; c.offset < size;) {
        const want = Math.min(len, size - c.offset), buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, c.offset);
        const cut = bytesRead ? buf.lastIndexOf(10, bytesRead - 1) + 1 : 0; // after the last newline: whole lines only
        // No whole line: the last one is unfinished (read again next time), or longer than the chunk (read more).
        if (!cut) { if (want === size - c.offset) break; len *= 2; continue; }
        foldReplies(buf.toString('utf8', 0, cut).split('\n'), c, ctx);
        c.offset += cut; len = CHUNK;
      }
    } finally { await fh.close(); }
  }
  return c;
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

// Pure: a ticket opened without a step: one row per role, from everything its sessions did. A role none of whose
// steps is reached (`reached`: a Set of roles) shows its configured values; one that is reached with nothing read
// stays unknown.
export function roleRows({ ran = [], config = {}, reached = new Set() } = {}) {
  return Object.keys(config).map(role => {
    const spans = ran.filter(r => r.actor === role);
    if (spans.length) return { role, source: 'ran', model: distinct(spans.map(s => s.model)), effort: distinct(spans.map(s => s.effort)) };
    if (reached.has(role)) return { role, source: null, model: [], effort: [] };
    const model = distinct([config[role].model]), effort = distinct([config[role].effort]);
    return { role, source: model.length || effort.length ? 'configured' : null, model, effort };
  });
}

// The spans of every session that worked on a ticket, and the planner's plan-gate answers, by ticket:
// { ran: [{ actor, model, effort, from, to }], gates: [ms], events: [{ actor, n, at }] } (the steps the worker's and the
// reviewer's sessions show happened; `verifyFor(ticket)`: that ticket's repo verify command, or null). Sessions are found through Usage's attribution
// (which survives a closed pane): `files` from scanUsage. A session in an excluded folder (checked again here,
// as the ledger's flag was set when the session was first read), or one whose transcript is gone, adds none.
export async function spansByTicket(files, projects = [], dir = PROJECTS_DIR, verifyFor = () => null) {
  const mains = new Map(), out = new Map();
  for (const [rel, st] of Object.entries(files)) if (!rel.includes('/subagents/')) mains.set(rel.split('/')[1]?.replace(/\.jsonl$/, ''), attribute(rel, st, projects));
  for (const [rel, st] of Object.entries(files)) {
    if (st.excluded || (st.cwd && excludesFolder(st.cwd))) continue;
    const a = attribute(rel, st, projects, mains.get(rel.split('/')[1])), actor = a.ticket ? adapter.actorOf(a) : null;
    if (!actor) continue;
    const t = out.get(a.ticket) ?? out.set(a.ticket, { ran: [], gates: [], events: [] }).get(a.ticket);
    const { runs, gates, events } = await readRuns(join(dir, ...rel.split('/')), { verify: verifyFor(a.ticket) });
    for (const r of runs) t.ran.push({ ...r, actor });
    if (actor === 'planner') t.gates.push(...gates);
    if (actor === 'planner' || actor === 'reviewer') for (const e of events) t.events.push({ ...e, actor });
  }
  return out;
}

// Pure: the answer for one ticket: `steps` (the rows of every flow step) and `roles` (the rows of a tile opened
// without a step). `flow`: step ids in order; `current`: the ticket's step; `furthest`: the furthest step it has
// reached (past `current` after a review sent it back to implementing); `gates`: the planner's gate answer times;
// `events`: what spansByTicket found. `seen`: { <step n>: ms } for the steps only transcripts show.
export function ticketModels({ flow, current, furthest = current, ran = [], gates = [], events = [], config }) {
  const at = Math.max(flow.indexOf(current), flow.indexOf(furthest)), boundary = adapter.boundaryOf(ran, gates);
  const reached = i => current === 'done' || i <= at;
  return {
    steps: Object.fromEntries(flow.map((s, i) => [s, stepRows(s, { ran, config, boundary, reached: reached(i) })])),
    seen: adapter.seenSteps?.(events, boundary) ?? {},
    roles: roleRows({ ran, config, reached: new Set(flow.filter((s, i) => reached(i)).flatMap(s => adapter.roleOfStep(s))) }),
  };
}
