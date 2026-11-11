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
const fresh = () => ({ runs: [], gates: [], asked: new Set() });

// Pure: fold complete transcript lines into `into`: consecutive replies on the same model and effort become
// one span { model, effort, from, to } in `runs`, so a long session stays small; plan-gate answers go to `gates`
// (times). `asked` holds the gate questions waiting for their answer.
export function foldReplies(lines, into = fresh()) {
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
export async function readRuns(path) {
  if (excludesPath(path)) return fresh();
  const size = await stat(path).then(s => s.size, () => null);
  if (size == null) { cache.delete(path); return fresh(); }
  let c = cache.get(path);
  if (!c || size < c.offset) cache.set(path, c = { offset: 0, ...fresh() });
  if (size > c.offset) {
    const fh = await open(path, 'r');
    try {
      for (let len = CHUNK; c.offset < size;) {
        const want = Math.min(len, size - c.offset), buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, c.offset);
        const cut = bytesRead ? buf.lastIndexOf(10, bytesRead - 1) + 1 : 0; // after the last newline: whole lines only
        // No whole line: the last one is unfinished (read again next time), or longer than the chunk (read more).
        if (!cut) { if (want === size - c.offset) break; len *= 2; continue; }
        foldReplies(buf.toString('utf8', 0, cut).split('\n'), c);
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
// { ran: [{ actor, model, effort, from, to }], gates: [ms] }. Sessions are found through Usage's attribution
// (which survives a closed pane): `files` from scanUsage. A session in an excluded folder (checked again here,
// as the ledger's flag was set when the session was first read), or one whose transcript is gone, adds none.
export async function spansByTicket(files, projects = [], dir = PROJECTS_DIR) {
  const mains = new Map(), out = new Map();
  for (const [rel, st] of Object.entries(files)) if (!rel.includes('/subagents/')) mains.set(rel.split('/')[1]?.replace(/\.jsonl$/, ''), attribute(rel, st, projects));
  for (const [rel, st] of Object.entries(files)) {
    if (st.excluded || (st.cwd && excludesFolder(st.cwd))) continue;
    const a = attribute(rel, st, projects, mains.get(rel.split('/')[1])), actor = a.ticket ? adapter.actorOf(a) : null;
    if (!actor) continue;
    const t = out.get(a.ticket) ?? out.set(a.ticket, { ran: [], gates: [] }).get(a.ticket);
    const { runs, gates } = await readRuns(join(dir, ...rel.split('/')));
    for (const r of runs) t.ran.push({ ...r, actor });
    if (actor === 'planner') t.gates.push(...gates);
  }
  return out;
}

// Pure: the answer for one ticket: `steps` (the rows of every flow step) and `roles` (the rows of a tile opened
// without a step). `flow`: step ids in order; `current`: the ticket's step; `furthest`: the furthest step it has
// reached (past `current` after a review sent it back to implementing); `gates`: the planner's gate answer times.
export function ticketModels({ flow, current, furthest = current, ran = [], gates = [], config }) {
  const at = Math.max(flow.indexOf(current), flow.indexOf(furthest)), boundary = adapter.boundaryOf(ran, gates);
  const reached = i => current === 'done' || i <= at;
  return {
    steps: Object.fromEntries(flow.map((s, i) => [s, stepRows(s, { ran, config, boundary, reached: reached(i) })])),
    roles: roleRows({ ran, config, reached: new Set(flow.filter((s, i) => reached(i)).flatMap(s => adapter.roleOfStep(s))) }),
  };
}
