// Process metrics for orchestrated tickets: where each merged ticket's time went (agent vs. you),
// and how much rework followed opening its PR. POC: rebuilt from what's already on disk.
//   - stage boundaries: mtimes of the run's artifacts (the adapter's timeline: kickoff → plan → report → review)
//   - plan-gate waits: AskUserQuestion ask → answer timestamps, for dialogs with the adapter's gate header
//   - PR opened/merged, size, and rework (commits pushed after the PR opened: review and CI fixes): GitHub
//   - when you were away: gaps of AWAY_AFTER or more between your prompts and dialog answers in any
//     transcript. Waits that fall in one (a night, mostly) are counted apart from waiting on you.
// Artifact mtimes are rewritten when a ticket is re-dispatched, so a segment that comes out negative
// is dropped and the ticket is flagged approximate rather than guessed at.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECTS_DIR } from './orchestrators.mjs';
import { prDetail } from './scm.mjs';
import adapter from './adapters/index.mjs';

const mtime = p => stat(p).then(s => s.mtimeMs, () => null);

// Pure: commits pushed after the PR opened (a minute's grace for the opening push). A rebase restamps
// commits, so a rebased PR over-counts.
export function reworkCommits(pr) {
  const opened = Date.parse(pr.createdAt) + 60_000;
  return (pr.commits ?? []).filter(c => Date.parse(c.committedDate) > opened).length;
}

// Pure: plan-gate waits in one transcript's lines, keyed by ticket. A gate's ticket is the first known
// ticket id in its question or answer, else the first one in the transcript's opening prompt.
export function gateWaits(lines, known) {
  const pick = s => (s.match(/[A-Z]+-\d+/g) ?? []).find(id => known.has(id));
  const asks = new Map();
  const out = [];
  let opening = null;
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const content = j.message?.content;
    if (opening == null && j.type === 'user') opening = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.input?.questions?.some(q => q.header === adapter.gateHeader)) {
        asks.set(b.id, { at: Date.parse(j.timestamp), text: JSON.stringify(b.input) });
      } else if (b.type === 'tool_result' && asks.has(b.tool_use_id)) {
        const a = asks.get(b.tool_use_id);
        const ticket = pick(a.text) ?? pick(JSON.stringify(b.content ?? '')) ?? (opening && pick(opening));
        const end = Date.parse(j.timestamp);
        if (ticket && end >= a.at) out.push({ ticket, askedAt: a.at, answeredAt: end });
      }
    }
  }
  return out;
}

// Pure: the times one transcript shows you at the machine: prompts you sent (`origin.kind` "human",
// which leaves out task notifications, compaction summaries and messages from other sessions) and
// answers to question dialogs. `typed` is false for a ticket worktree's session: herdr types the
// orchestrator's prompts into worker panes, so there only dialog answers (plan gates) are yours.
export function presence(lines, { typed = true } = {}) {
  const asks = new Set();
  const out = [];
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const content = j.message?.content;
    if (j.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b.type === 'tool_use' && b.name === 'AskUserQuestion') asks.add(b.id);
      continue;
    }
    if (j.type !== 'user' || j.isMeta || j.isSidechain || j.isCompactSummary) continue;
    const at = Date.parse(j.timestamp);
    if (Number.isNaN(at)) continue;
    if (Array.isArray(content) && content.some(b => b.type === 'tool_result')) {
      if (content.some(b => b.type === 'tool_result' && asks.has(b.tool_use_id))) out.push(at);
    } else if (typed && j.origin?.kind === 'human') out.push(at);
  }
  return out;
}

// You're away during any gap this long between one sign of you and the next: a night, not a meeting.
export const AWAY_AFTER = 3 * 3600e3;
// Pure: the stretches [from, to] you were away. Nothing before your first sign or after your last
// counts, so a ticket from before the transcripts begin is never marked away.
export function awayStretches(marks, gap = AWAY_AFTER) {
  const s = [...marks].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] >= gap) out.push([s[i - 1], s[i]]);
  return out;
}
// Pure: how much of [a, b] falls in an away stretch.
export const awayWithin = (a, b, away) => away.reduce((t, [x, y]) => t + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);

// Transcripts are large; re-read a file only when it changed. Plan-gate lines are kept only from
// files with a plan gate; presence is kept as timestamps.
const transcriptCache = new Map();
const WORKTREE = /wt-[A-Z]+-\d+/; // a ticket worktree's project folder (as lib/sessions.mjs reads a cwd)
async function readTranscripts(known, dir = PROJECTS_DIR) {
  const waits = [], marks = [];
  for (const p of await readdir(dir).catch(() => [])) {
    for (const f of await readdir(join(dir, p)).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, p, f);
      const s = await stat(file).catch(() => null);
      if (!s) continue;
      const key = `${s.mtimeMs}:${s.size}`;
      let hit = transcriptCache.get(file);
      if (hit?.key !== key) {
        const text = await readFile(file, 'utf8').catch(() => '');
        const all = text.split('\n');
        const lines = text.includes(JSON.stringify(adapter.gateHeader)) ? all.filter(l => l.includes('AskUserQuestion') || l.includes('tool_result') || l.includes('"type":"user"')) : [];
        // Only lines that can be a sign of you are parsed: prompts, and the answers to dialogs asked here.
        const asked = all.filter(l => l.includes('AskUserQuestion'));
        const ids = asked.flatMap(l => [...l.matchAll(/"id":"(toolu_\w+)"/g)].map(m => m[1]));
        const mine = all.filter(l => l.includes('"kind":"human"') || l.includes('AskUserQuestion') || (ids.length && l.includes('tool_result') && ids.some(id => l.includes(id))));
        hit = { key, lines, marks: presence(mine, { typed: !WORKTREE.test(p) }) };
        transcriptCache.set(file, hit);
      }
      if (hit.lines.length) waits.push(...gateWaits(hit.lines, known));
      marks.push(...hit.marks);
    }
  }
  return { waits, marks };
}

// Pure: the time segments of one ticket. `t` holds ms timestamps; null where unknown. `gate` and
// `mergeWait` are the time a ticket waited while you were around; `gateAway` and `mergeAway` the time
// it waited while you were away (`away`: awayStretches). `lead` is wall-clock and includes both.
export function segments({ kickoff, plan, report, review, merged, gateMs = 0, gateAwayMs = 0, away = [] }) {
  const span = (a, b) => (a != null && b != null && b >= a ? b - a : null);
  const impl = span(plan, report);
  const wait = span(review ?? report, merged);
  const mergeAway = wait == null ? 0 : awayWithin(review ?? report, merged, away);
  const seg = {
    planning: span(kickoff, plan),
    gate: gateMs - gateAwayMs,
    implementing: impl == null ? null : Math.max(0, impl - gateMs),
    selfReview: span(report, review),
    mergeWait: wait == null ? null : wait - mergeAway,
  };
  const approx = [kickoff, plan, report, review].some(v => v == null) || Object.values(seg).some(v => v == null);
  return {
    ...seg,
    gateAway: gateAwayMs,
    mergeAway,
    agent: (seg.planning ?? 0) + (seg.implementing ?? 0) + (seg.selfReview ?? 0),
    you: (seg.gate ?? 0) + (seg.mergeWait ?? 0),
    away: gateAwayMs + mergeAway,
    lead: span(kickoff, merged),
    approx,
  };
}

const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

// Pure: Monday 00:00 local of the week holding `ms`.
export function weekOf(ms) {
  const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// Pure: weekly roll-up of merged tickets.
export function rollup(tickets) {
  const weeks = new Map();
  for (const t of tickets) {
    const w = weekOf(t.mergedAt);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(t);
  }
  return [...weeks].sort((a, b) => b[0] - a[0]).map(([week, ts]) => ({
    week,
    merged: ts.length,
    medianLead: median(ts.map(t => t.seg.lead)),
    agent: ts.reduce((s, t) => s + t.seg.agent, 0),
    you: ts.reduce((s, t) => s + t.seg.you, 0),
    away: ts.reduce((s, t) => s + (t.seg.away ?? 0), 0),
    gate: ts.reduce((s, t) => s + (t.seg.gate ?? 0), 0),
    rework: ts.reduce((s, t) => s + t.rework, 0),
    reworked: ts.filter(t => t.rework > 0).length,
    medianSize: median(ts.map(t => t.size)),
  }));
}

// A merged PR never changes, so it's cached for good; any other answer for five minutes. A few at a time.
const prCache = new Map();
async function prMap(urls, detail = prDetail) {
  const map = new Map();
  const todo = urls.filter(u => { const h = prCache.get(u); return !(h && (h.merged || Date.now() - h.at < 5 * 60_000)); });
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async u => {
      const d = await detail(u).catch(() => null);
      prCache.set(u, { at: Date.now(), merged: Boolean(d?.mergedAt), d });
    }));
  }
  for (const u of urls) if (prCache.get(u)?.d) map.set(u, prCache.get(u).d);
  return map;
}

// `runs`: listRuns().runs. Options let tests swap in fixtures.
export async function processMetrics(runs, { prs = prMap, transcripts = readTranscripts } = {}) {
  // A ticket can sit in several runs (re-dispatched); use the newest copy that got as far as a PR.
  const best = new Map();
  for (const r of runs) for (const t of r.tickets) {
    if (!t.pr) continue;
    const cur = best.get(t.ticket);
    if (!cur || t.updatedAt > cur.t.updatedAt) best.set(t.ticket, { r, t });
  }
  const prInfo = await prs([...best.values()].map(b => b.t.pr));
  const { waits, marks } = await transcripts(new Set(best.keys()));
  const away = awayStretches(marks);
  const gate = new Map();
  for (const w of waits) {
    const g = gate.get(w.ticket) ?? { ms: 0, away: 0 };
    gate.set(w.ticket, { ms: g.ms + (w.answeredAt - w.askedAt), away: g.away + awayWithin(w.askedAt, w.answeredAt, away) });
  }

  const tickets = [];
  for (const [ticket, { r, t }] of best) {
    const pr = prInfo.get(t.pr);
    if (!pr?.mergedAt) continue;
    const td = join(r.root, r.epic, ticket);
    const at = {
      kickoff: await mtime(join(td, adapter.timeline.kickoff)),
      plan: await mtime(join(td, adapter.timeline.plan)),
      report: await mtime(join(td, adapter.timeline.report)),
      review: await mtime(join(td, adapter.timeline.review)),
      merged: Date.parse(pr.mergedAt),
    };
    tickets.push({
      ticket, epic: r.epic, pr: t.pr, title: pr.title, mergedAt: at.merged, openedAt: Date.parse(pr.createdAt),
      size: (pr.additions ?? 0) + (pr.deletions ?? 0), rework: reworkCommits(pr), at, seg: segments({ ...at, gateMs: gate.get(ticket)?.ms ?? 0, gateAwayMs: gate.get(ticket)?.away ?? 0, away }),
    });
  }
  tickets.sort((a, b) => b.mergedAt - a.mergedAt || a.ticket.localeCompare(b.ticket));
  return { tickets, weeks: rollup(tickets), at: Date.now() };
}
