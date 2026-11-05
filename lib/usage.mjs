// Claude usage: what each reply cost at list API prices, from the token counts Claude Code records in its
// transcripts (~/.claude/projects/<folder>/<session>.jsonl and <session>/subagents/agent-<id>.jsonl).
//
// Read from each transcript: its replies' model and token counts, the session's folder, the opening prompt
// (only to tell a ticket's reviewer from its implementer) and an orchestrator's epic. Only totals are kept.
// Claude Code deletes transcripts after 30 days by default, so each one's totals are kept in
// data/usage-ledger.json and outlive it. Transcripts under MC_EXCLUDE paths are never opened, and a session
// working in an excluded folder is counted only as "(excluded)".
import { readdir, stat, open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { PROJECTS_DIR, epicOf } from './orchestrators.mjs';
import { EXCLUDE } from './config.mjs';
import { weekOf } from './metrics.mjs';
import adapter from './adapters/index.mjs';

// $ per million tokens at Anthropic's list API prices (first-party, as of 2026-10-06): input, output,
// 5-minute cache write, 1-hour cache write, cache read. Fast mode bills twice the standard rate.
export const PRICES = {
  'claude-fable-5-1': [10, 50, 12.5, 20, 0.25], 'claude-fable-5': [10, 50, 12.5, 20, 1],
  'claude-opus-5-5': [4, 20, 5, 8, 0.2], 'claude-opus-5': [5, 25, 6.25, 10, 0.5], 'claude-opus-4-8': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-7': [5, 25, 6.25, 10, 0.5], 'claude-opus-4-6': [5, 25, 6.25, 10, 0.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.2], 'claude-sonnet-5': [2, 10, 2.5, 4, 0.2], 'claude-sonnet-4-6': [3, 15, 3.75, 6, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01], 'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
};
// What-if: the same tokens on this model.
export const WHAT_IF = 'claude-sonnet-5-5';
// "claude-haiku-4-5-20251001" → "claude-haiku-4-5". Replies in fast mode are kept as "<model> (fast)".
const FAST = ' (fast)';
const priceKey = model => String(model ?? '').replace(FAST, '').replace(/-\d{8}$/, '');
// Pure: dollars for one tuple of tokens [in, out, cache write 5m, cache write 1h, cache read]; null if unpriced.
export function cost(model, tokens) {
  const p = PRICES[priceKey(model)];
  return p ? tokens.reduce((a, n, i) => a + n * p[i], 0) / 1e6 * (String(model).endsWith(FAST) ? 2 : 1) : null;
}

const day = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayStart = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const segs = p => String(p ?? '').split(/[\\/]+/).filter(Boolean);
const norm = p => segs(p).join('/').toLowerCase();
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
// A ticket's worktree folder: "<repo>-wt-<TICKET>" (the orchestration plugin's), or "wt-<TICKET>" inside a
// folder named for the repo. Group 1 is the repo when the name carries it, group 2 the ticket.
const WORKTREE = /^(?:(.+)-)?wt-([A-Z]+-\d+)$/;
const worktreeOf = cwd => { const m = WORKTREE.exec(segs(cwd).at(-1) ?? ''); return m && { repo: m[1] ?? segs(cwd).at(-2) ?? '?', ticket: m[2] }; };

// One transcript's running totals. `days`: { 'YYYY-MM-DD': { model: [in, out, cw5m, cw1h, cr] } }.
// `byEpic`: an orchestrator's tokens by the epic it was running at the time (one session can run several in
// turn), as { epic: { model: tokens } }, and `epicAt` when it last worked on each. `head`/`tail`: the first and latest ten replies' costs, to show how a
// long session's cost per reply grew.
export const blank = () => ({ offset: 0, size: 0, cwd: null, excluded: false, reviewer: null, epic: null,
  requests: 0, first: null, last: null, days: {}, byEpic: {}, epicAt: {}, head: [], tail: [], recent: [] });

// Pure: fold complete transcript lines into `st`. A reply is written once per content block, so a reply
// already counted (by message and request id) is skipped; `recent` carries the last few across reads.
export function scanLines(lines, st) {
  for (const line of lines) {
    const usage = line.includes('"usage"'), withCwd = !st.cwd && line.includes('"cwd"');
    const opening = st.reviewer === null && line.includes('"type":"user"');
    const epicish = line.includes('orchestrate-work') || line.includes('--epic');
    if (!usage && !withCwd && !opening && !epicish) continue;
    const j = parse(line);
    if (!j) continue;
    if (withCwd && j.cwd) { st.cwd = j.cwd; st.excluded = EXCLUDE.test(j.cwd); }
    // Before the reply's tokens are counted: the reply that arms an epic's watcher is that epic's.
    if (epicish && !st.excluded && !worktreeOf(st.cwd)) st.epic = epicOf([j]) ?? st.epic;
    const u = j.message?.usage;
    if (j.type === 'assistant' && u) {
      const key = `${j.message.id}|${j.requestId}`;
      if (st.recent.includes(key) || j.message.model === '<synthetic>') continue;
      st.recent = [...st.recent.slice(-39), key];
      const h1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const t = [u.input_tokens ?? 0, u.output_tokens ?? 0, Math.max(0, (u.cache_creation_input_tokens ?? 0) - h1), h1, u.cache_read_input_tokens ?? 0];
      const at = Date.parse(j.timestamp), d = Number.isNaN(at) ? 'unknown' : day(at), m = (j.message.model ?? 'unknown') + (u.speed === 'fast' ? FAST : '');
      const slot = (st.days[d] ??= {})[m] ??= [0, 0, 0, 0, 0];
      t.forEach((n, i) => { slot[i] += n; });
      if (st.epic) {
        const e = ((st.byEpic ??= {})[st.epic] ??= {})[m] ??= [0, 0, 0, 0, 0];
        t.forEach((n, i) => { e[i] += n; });
        if (!Number.isNaN(at)) (st.epicAt ??= {})[st.epic] = Math.max(st.epicAt[st.epic] ?? 0, at);
      }
      st.requests++;
      if (!Number.isNaN(at)) { st.first = Math.min(st.first ?? at, at); st.last = Math.max(st.last ?? at, at); }
      const usd = cost(m, t) ?? 0;
      if (st.head.length < 10) st.head.push(usd);
      st.tail = [...st.tail.slice(-9), usd];
      continue;
    }
    if (st.excluded) continue; // nothing but token counts from a session in an excluded folder
    if (opening && j.type === 'user' && !j.isMeta && !j.isCompactSummary) {
      const c = j.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find(x => x.type === 'text')?.text : null;
      // A slash command reads as "<command-name>/x</command-name>…<command-args>y</command-args>": test "/x y".
      const cmd = text?.match(/<command-name>([^<]+)<\/command-name>[\s\S]*?<command-args>([^<]*)<\/command-args>/);
      const said = cmd ? `${cmd[1]} ${cmd[2]}` : text && !text.startsWith('<') ? text : null;
      if (said) {
        st.reviewer = (adapter.reviewerPrompt ?? /(?!)/).test(said);
        // Only the ticket id is kept from a worker prompt, never its text.
        if ((adapter.workerPrompt ?? /(?!)/).test(said)) st.workTicket = said.match(/\b[A-Z]+-\d+\b/)?.[0] ?? null;
      }
    }
  }
  return st;
}

// Read what a transcript has gained since the last read, in chunks, up to its last complete line.
async function readNew(path, st, size) {
  const fh = await open(path, 'r');
  try {
    let carry = '';
    while (st.offset < size) {
      const buf = Buffer.alloc(Math.min(16 << 20, size - st.offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, st.offset);
      if (!bytesRead) break;
      const text = carry + buf.toString('utf8', 0, bytesRead);
      const cut = text.lastIndexOf('\n') + 1;
      scanLines(text.slice(0, cut).split('\n'), st);
      st.offset += bytesRead;
      carry = text.slice(cut);
    }
    st.offset -= Buffer.byteLength(carry); // an unfinished last line is read again next time
    st.size = size;
  } finally { await fh.close(); }
}

async function transcripts(dir) {
  const out = [];
  const walk = async (d, rel) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else if (e.name.endsWith('.jsonl')) out.push({ rel: r, path: join(d, e.name) });
    }
  };
  await walk(dir, '');
  return out;
}

export const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'usage-ledger.json');
const ledgers = new Map(); // by store file
const LEDGER_VERSION = 4;
// Bring every transcript's totals up to date and save them. `ticketEpic` (ticket → epic, from the runs) is
// recorded on the worktree sessions it names, so a ticket keeps its epic after its run folder is gone.
export async function scanUsage({ dir = PROJECTS_DIR, store = STORE, ticketEpic = new Map() } = {}) {
  const saved = ledgers.get(store) ?? await readFile(store, 'utf8').then(parse).catch(() => null);
  // A ledger from an older version is read again from the transcripts still on disk.
  const ledger = saved?.version === LEDGER_VERSION ? saved : { version: LEDGER_VERSION, files: {} };
  ledgers.set(store, ledger);
  let changed = false;
  const onDisk = new Set();
  for (const f of await transcripts(dir)) {
    if (EXCLUDE.test(f.path)) continue;
    onDisk.add(f.rel);
    const size = await stat(f.path).then(s => s.size, () => null);
    if (size == null) continue;
    let st = ledger.files[f.rel];
    if (!st || size < st.offset) st = ledger.files[f.rel] = blank();
    if (st.gone) { delete st.gone; changed = true; }
    if (size !== st.size) { await readNew(f.path, st, size); changed = true; }
    const ticket = worktreeOf(st.cwd)?.ticket ?? (st.epic ? null : st.workTicket);
    if (ticket && ticketEpic.get(ticket) && st.ticketEpic !== ticketEpic.get(ticket)) { st.ticketEpic = ticketEpic.get(ticket); changed = true; }
  }
  for (const [rel, st] of Object.entries(ledger.files)) if (!onDisk.has(rel) && !st.gone) { st.gone = true; changed = true; }
  if (changed) {
    await mkdir(dirname(store), { recursive: true }).catch(() => {});
    await writeFile(store, JSON.stringify(ledger)).catch(() => {});
  }
  return ledger.files;
}

// Pure: who a transcript was working for. `projects`: [{ name, path }]. A ticket's worktree folder is
// named wt-<TICKET> inside a folder named for its repo. A subagent takes its parent session's role and epic.
export function attribute(rel, st, projects = [], parent = null) {
  const parts = rel.split('/'), sub = parts.includes('subagents');
  const session = sub ? parts[1] : parts[1]?.replace(/\.jsonl$/, '');
  const cwd = segs(st.cwd), wt = st.excluded ? null : worktreeOf(st.cwd);
  // Its own ticket: the worktree it works in, or the ticket its worker prompt names.
  const own = wt?.ticket ?? (st.excluded || st.epic ? null : st.workTicket) ?? null;
  const ticket = own ?? (sub && parent ? parent.ticket : null);
  const home = norm(os.homedir());
  const owner = !wt && !st.excluded && projects.filter(p => norm(st.cwd) === norm(p.path) || norm(st.cwd).startsWith(`${norm(p.path)}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const project = st.excluded ? '(excluded)' : wt ? wt.repo : owner?.name ?? (norm(st.cwd) === home ? '~' : cwd.at(-1) ?? '?');
  // A subagent works for its parent, unless it's a worker an orchestrator dispatched onto a ticket.
  const role = sub && parent && !(own && !parent.ticket) ? parent.role
    : own ? (st.reviewer ? 'reviewer' : 'implementer') : st.epic ? 'orchestrator' : 'you';
  const epic = st.epic ?? st.ticketEpic ?? (sub && parent ? parent.epic : null) ?? null;
  return { session, sub, project, ticket, epic, role };
}

const add = (a, b) => a.map((x, i) => x + (b[i] ?? 0));
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
const ROLES = ['orchestrator', 'implementer', 'reviewer', 'you'];

// Pure: each transcript's totals with who it worked for (`attribute`): what the Usage panel counts, and what
// this machine serves its peers (/api/usage-input). Token counts by day and model, the role, ticket and epic,
// and the project's folder name: never a path (the ledger's keys and `cwd` are paths) or prompt text.
export function usageInput(files, projects = []) {
  const mains = new Map();
  for (const [rel, st] of Object.entries(files)) if (!rel.includes('/subagents/')) mains.set(rel.split('/')[1]?.replace(/\.jsonl$/, ''), attribute(rel, st, projects));
  return Object.entries(files).map(([rel, st]) => ({ ...attribute(rel, st, projects, mains.get(rel.split('/')[1])),
    requests: st.requests, first: st.first, last: st.last, days: st.days, byEpic: st.byEpic ?? {}, epicAt: st.epicAt ?? {}, head: st.head, tail: st.tail }));
}

// Pure: the panel's numbers. `files`: { rel: totals } from scanUsage; `tickets`: [{ ticket, epic, step }] from
// the runs; `alive`: ids of live Claude sessions; `peers`: [{ name, input }], each peer's usageInput. A ticket
// or epic worked on several machines is one row with all their cost; projects and sessions are per machine.
export function usageReport(files, { projects = [], tickets = [], alive = new Set(), now = Date.now(), peers = [] } = {}) {
  const D = 864e5, since7 = now - 7 * D, since14 = now - 14 * D, since30 = now - 30 * D, weeks0 = weekOf(now) - 11 * 7 * D;
  const tiles = { week: 0, prior: 0, month: 0, opus: 0, cache: 0, all: 0, first: null };
  const byWeek = new Map(), byProject = new Map(), byTicket = new Map(), byEpicOrch = new Map(), epicLast = new Map(), sessions = new Map();
  const mix = Object.fromEntries(ROLES.map(r => [r, {}])), unpriced = {};
  for (const a of [...usageInput(files, projects), ...peers.flatMap(p => (p.input ?? []).map(x => ({ ...x, machine: p.name })))]) {
    const machine = a.machine ?? null, pk = machine ? `${machine}|${a.project}` : a.project; // a project, per machine
    const s = sessions.get(a.session) ?? sessions.set(a.session, { id: a.session, machine, role: null, project: a.project, ticket: a.ticket, epic: a.epic,
      usd: 0, week: 0, requests: 0, first: null, last: null, models: {}, head: [], tail: [] }).get(a.session);
    if (!a.sub) Object.assign(s, { role: a.role, project: a.project, ticket: a.ticket, epic: a.epic, head: a.head, tail: a.tail });
    s.role ??= a.role;
    s.requests += a.requests;
    if (a.first != null) s.first = Math.min(s.first ?? a.first, a.first);
    s.last = Math.max(s.last ?? 0, a.last ?? 0);
    for (const [d, models] of Object.entries(a.days)) {
      const at = d === 'unknown' ? null : dayStart(d);
      for (const [m, t] of Object.entries(models)) {
        const usd = cost(m, t);
        if (usd == null) { unpriced[m] = add(unpriced[m] ?? [0, 0, 0, 0, 0], t); continue; }
        tiles.all += usd; s.usd += usd; s.models[m] = (s.models[m] ?? 0) + usd;
        if (at != null) tiles.first = Math.min(tiles.first ?? at, at);
        if (at >= since7) { tiles.week += usd; s.week += usd; } else if (at >= since14) tiles.prior += usd;
        if (at >= since30) {
          tiles.month += usd;
          if (/opus/.test(m)) tiles.opus += usd;
          tiles.cache += cost(m, [0, 0, t[2], t[3], t[4]]);
          const r = mix[a.role] ?? (mix[a.role] = {});
          const cell = r[m] ??= { usd: 0, tokens: [0, 0, 0, 0, 0] };
          cell.usd += usd; cell.tokens = add(cell.tokens, t);
        }
        if (at >= weeks0) {
          const w = weekOf(at), row = byWeek.get(w) ?? byWeek.set(w, {}).get(w);
          row[pk] = (row[pk] ?? 0) + usd;
        }
        const p = byProject.get(pk) ?? byProject.set(pk, { project: a.project, machine, week: 0, month: 0, all: 0 }).get(pk);
        p.all += usd; if (at >= since30) p.month += usd; if (at >= since7) p.week += usd;
        if (a.ticket) {
          const k = byTicket.get(a.ticket) ?? byTicket.set(a.ticket, { ticket: a.ticket, epic: a.epic, project: a.project, implement: 0, review: 0, last: 0 }).get(a.ticket);
          k[a.role === 'reviewer' ? 'review' : 'implement'] += usd; k.epic ??= a.epic; k.last = Math.max(k.last, a.last ?? 0);
        } else if (a.role === 'orchestrator' && a.sub && a.epic) byEpicOrch.set(a.epic, (byEpicOrch.get(a.epic) ?? 0) + usd);
      }
    }
    // An orchestrator's own replies go to the epic it was running at the time; its subagents' (above) to its epic.
    if (!a.sub && !a.ticket) for (const [epic, models] of Object.entries(a.byEpic ?? {})) {
      for (const [m, t] of Object.entries(models)) byEpicOrch.set(epic, (byEpicOrch.get(epic) ?? 0) + (cost(m, t) ?? 0));
      epicLast.set(epic, Math.max(epicLast.get(epic) ?? 0, a.epicAt?.[epic] ?? a.last ?? 0));
    }
  }
  // Tickets and epics: the run files say which tickets belong to an epic and which merged. An epic's
  // orchestrator cost is shared evenly among its tickets.
  const runTicket = new Map(tickets.map(t => [t.ticket, t]));
  for (const t of tickets) if (!byTicket.has(t.ticket) && byEpicOrch.has(t.epic))
    byTicket.set(t.ticket, { ticket: t.ticket, epic: t.epic, project: null, implement: 0, review: 0, last: 0 });
  const epics = new Map([...byEpicOrch.keys()].map(e => [e, []])); // an epic with no ticket work yet still shows
  for (const k of byTicket.values()) {
    k.epic = runTicket.get(k.ticket)?.epic ?? k.epic;
    k.step = runTicket.get(k.ticket)?.step ?? null;
    (epics.get(k.epic) ?? epics.set(k.epic, []).get(k.epic)).push(k);
  }
  const epicList = [...epics].map(([epic, ts]) => {
    const orchestrator = epic ? byEpicOrch.get(epic) ?? 0 : 0, share = ts.length ? orchestrator / ts.length : 0;
    for (const k of ts) Object.assign(k, { orchestrator: share, total: k.implement + k.review + share });
    return { epic, orchestrator, total: ts.length ? ts.reduce((a, k) => a + k.total, 0) : orchestrator,
      last: Math.max(epicLast.get(epic) ?? 0, ...ts.map(k => k.last)), tickets: ts.sort((a, b) => b.total - a.total) };
  }).sort((a, b) => b.last - a.last);
  const merged = [...byTicket.values()].filter(k => k.step === 'done').map(k => k.total);
  // What-if: each role's last 30 days on the what-if model, where it ran on a pricier one.
  const models = ROLES.map(role => {
    const cells = Object.entries(mix[role] ?? {});
    const usd = cells.reduce((a, [, c]) => a + c.usd, 0);
    const ifSonnet = cells.reduce((a, [m, c]) => a + Math.min(c.usd, cost(WHAT_IF, c.tokens)), 0);
    return { role, usd, ifSonnet, byModel: Object.fromEntries(cells.map(([m, c]) => [m, c.usd])) };
  });
  const weekRows = [...byWeek].sort((a, b) => a[0] - b[0]).map(([week, row]) => ({ week, byProject: row }));
  const avg = xs => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
  return {
    at: now, since: tiles.first,
    tiles: { week: tiles.week, prior: tiles.prior, month: tiles.month, all: tiles.all,
      opusShare: tiles.month ? tiles.opus / tiles.month : null, cacheShare: tiles.month ? tiles.cache / tiles.month : null,
      perTicket: merged.length ? { median: median(merged), p90: pct(merged, 0.9), n: merged.length } : null },
    epics: epicList,
    projects: [...byProject.values()].sort((a, b) => b.all - a.all),
    weeks: weekRows,
    models,
    sessions: [...sessions.values()].filter(s => s.week > 0).sort((a, b) => b.usd - a.usd).slice(0, 20)
      .map(s => ({ ...s, alive: alive.has(s.id), model: Object.entries(s.models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        firstPer: avg(s.head), latestPer: avg(s.tail), models: undefined, head: undefined, tail: undefined })),
    unpriced: Object.entries(unpriced).map(([model, t]) => ({ model, tokens: t.reduce((a, n) => a + n, 0) })),
  };
}

// Codex: not read yet. Its session logs (~/.codex/sessions) are only counted, so the panel can say whether
// there's anything to read once Codex reviews start.
export async function codexStatus(dir = join(os.homedir(), '.codex', 'sessions')) {
  let n = 0;
  const walk = async (d, depth) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => null) ?? []) {
      if (e.isDirectory() && depth < 4) await walk(join(d, e.name), depth + 1);
      else if (e.name.endsWith('.jsonl')) n++;
    }
  };
  const found = await stat(dir).then(s => s.isDirectory(), () => false);
  if (found) await walk(dir, 0);
  return { found, sessions: n };
}
