// Process metrics for orchestrated tickets: where each merged ticket's time went (agent vs. you),
// and how much rework followed opening its PR. POC: rebuilt from what's already on disk.
//   - stage boundaries: mtimes of the run's artifacts (KICKOFF → PLAN → REPORT → REVIEW_REPORT)
//   - plan-gate waits: AskUserQuestion "Plan gate" ask → answer timestamps in worker transcripts
//   - PR opened/merged, size, and rework (commits pushed after the PR opened: review and CI fixes): GitHub
// Artifact mtimes are rewritten when a ticket is re-dispatched, so a segment that comes out negative
// is dropped and the ticket is flagged approximate rather than guessed at.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECTS_DIR } from './orchestrators.mjs';
import { prDetail } from './github.mjs';

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
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.input?.questions?.some(q => q.header === 'Plan gate')) {
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

// Transcripts are large; re-read a file only when it changed, and skip any without a plan gate.
const gateCache = new Map();
async function allGateWaits(known, dir = PROJECTS_DIR) {
  const waits = [];
  for (const p of await readdir(dir).catch(() => [])) {
    for (const f of await readdir(join(dir, p)).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, p, f);
      const s = await stat(file).catch(() => null);
      if (!s) continue;
      const key = `${s.mtimeMs}:${s.size}`;
      let hit = gateCache.get(file);
      if (hit?.key !== key) {
        const text = await readFile(file, 'utf8').catch(() => '');
        const lines = text.includes('"Plan gate"') ? text.split('\n').filter(l => l.includes('AskUserQuestion') || l.includes('tool_result') || l.includes('"type":"user"')) : [];
        hit = { key, lines };
        gateCache.set(file, hit);
      }
      if (hit.lines.length) waits.push(...gateWaits(hit.lines, known));
    }
  }
  return waits;
}

// Pure: the time segments of one ticket. `t` holds ms timestamps; null where unknown.
export function segments({ kickoff, plan, report, review, merged, gateMs = 0 }) {
  const span = (a, b) => (a != null && b != null && b >= a ? b - a : null);
  const impl = span(plan, report);
  const seg = {
    planning: span(kickoff, plan),
    gate: gateMs,
    implementing: impl == null ? null : Math.max(0, impl - gateMs),
    selfReview: span(report, review),
    mergeWait: span(review ?? report, merged),
  };
  const approx = [kickoff, plan, report, review].some(v => v == null) || Object.values(seg).some(v => v == null);
  return {
    ...seg,
    agent: (seg.planning ?? 0) + (seg.implementing ?? 0) + (seg.selfReview ?? 0),
    you: (seg.gate ?? 0) + (seg.mergeWait ?? 0),
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
export async function processMetrics(runs, { prs = prMap, waits = allGateWaits } = {}) {
  // A ticket can sit in several runs (re-dispatched); use the newest copy that got as far as a PR.
  const best = new Map();
  for (const r of runs) for (const t of r.tickets) {
    if (!t.pr) continue;
    const cur = best.get(t.ticket);
    if (!cur || t.updatedAt > cur.t.updatedAt) best.set(t.ticket, { r, t });
  }
  const prInfo = await prs([...best.values()].map(b => b.t.pr));
  const gate = new Map();
  for (const w of await waits(new Set(best.keys()))) gate.set(w.ticket, (gate.get(w.ticket) ?? 0) + (w.answeredAt - w.askedAt));

  const tickets = [];
  for (const [ticket, { r, t }] of best) {
    const pr = prInfo.get(t.pr);
    if (!pr?.mergedAt) continue;
    const td = join(r.root, r.epic, ticket);
    const at = {
      kickoff: await mtime(join(td, 'KICKOFF.md')),
      plan: await mtime(join(td, 'PLAN.md')),
      report: await mtime(join(td, 'REPORT.md')),
      review: await mtime(join(td, 'REVIEW_REPORT.md')),
      merged: Date.parse(pr.mergedAt),
    };
    tickets.push({
      ticket, epic: r.epic, pr: t.pr, title: pr.title, mergedAt: at.merged, openedAt: Date.parse(pr.createdAt),
      size: (pr.additions ?? 0) + (pr.deletions ?? 0), rework: reworkCommits(pr), at, seg: segments({ ...at, gateMs: gate.get(ticket) ?? 0 }),
    });
  }
  tickets.sort((a, b) => b.mergedAt - a.mergedAt || a.ticket.localeCompare(b.ticket));
  return { tickets, weeks: rollup(tickets), at: Date.now() };
}
