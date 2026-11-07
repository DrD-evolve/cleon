// Exec cards: the high-level look, one card per decision. Each card shows a number, last week's, the change, one
// line naming what to do about it, and where the number comes from. Built only from what Cleon already reads: Usage
// (lib/usage.mjs) and Process (lib/metrics.mjs), both with peers merged in; the orchestration runs; Linear; each
// repo's last commit; and the Groom queue (lib/groom.mjs). No card ranks people.
//
// Cards whose last-week number can't be rebuilt from today's data (stalled work, portfolio, grooming) take it
// from a weekly snapshot, data/exec-<port>.jsonl: one line per week, written the first time the cards are built
// that week.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { weekOf } from './metrics.mjs';

const H = 36e5, D = 24 * H;
export const money = x => (x == null ? '—' : x < 10 ? `$${x.toFixed(2)}` : `$${Math.round(x).toLocaleString('en-US')}`);
export const span = ms => (ms == null ? '—' : ms < H ? `${Math.round(ms / 6e4)}m` : ms < 2 * D ? `${(ms / H).toFixed(1)}h` : `${(ms / D).toFixed(1)}d`);
const days = ms => Math.floor(ms / D);
const short = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// Pure: the change from last week, as text: a percentage for money and time, a difference for counts.
export function change(n, prev, kind) {
  if (n == null || prev == null) return null;
  if (kind === 'count') return n === prev ? 'same' : `${n > prev ? '+' : ''}${n - prev}`;
  if (!prev) return n ? 'new' : 'same';
  const p = Math.round((n - prev) / prev * 100);
  return p === 0 ? 'same' : `${p > 0 ? '+' : ''}${p}%`;
}
const inWeek = (t, now, back) => t >= now - (back + 1) * 7 * D && t < now - back * 7 * D;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const label = (name, machine) => (machine ? `${name} on ${machine}` : name);

// 1. Spend vs output: Claude spend over the last 7 days against the 7 before, next to tickets merged in the same
// windows, and the cost per merged ticket. Names the project that spent the most.
export function spendCard({ usage, tickets = [], now }) {
  const n = usage?.tiles?.week ?? null, prev = usage?.tiles?.prior ?? null;
  const merged = tickets.filter(t => inWeek(t.mergedAt, now, 0)).length, mergedBefore = tickets.filter(t => inWeek(t.mergedAt, now, 1)).length;
  const per = merged && n != null ? n / merged : null, perBefore = mergedBefore && prev != null ? prev / mergedBefore : null;
  const top = (usage?.projects ?? []).filter(p => p.week > 0).sort((a, b) => b.week - a.week)[0];
  const most = top ? `most went to ${label(top.project, top.machine)} (${money(top.week)})` : null;
  return { id: 'spend', title: 'Spend vs output', n, value: money(n), prev: prev == null ? null : money(prev), change: change(n, prev, 'money'), good: 'down',
    sub: `${merged} merged (was ${mergedBefore})${per != null ? ` · ${money(per)} per merged ticket${perBefore != null ? ` (was ${money(perBefore)})` : ''}` : ''}`,
    action: n == null ? 'Usage is still reading transcripts.' : !merged ? `Nothing merged in 7 days${most ? `; ${most}` : ''}.` : `${most ? `${most[0].toUpperCase()}${most.slice(1)}` : 'No spend by project'}.`,
    source: 'Usage (Claude transcripts at list prices) · Process (merged pull requests)' };
}

// 2. Where cycle time goes: time tickets waited on you against time agents worked, for tickets merged in the last
// 7 days, with the median lead time. Names the longest plan-gate wait.
export function cycleCard({ tickets = [], now }) {
  const sum = (ts, k) => ts.reduce((a, t) => a + (t.seg?.[k] ?? 0), 0);
  const week = tickets.filter(t => inWeek(t.mergedAt, now, 0)), before = tickets.filter(t => inWeek(t.mergedAt, now, 1));
  const n = week.length ? sum(week, 'you') : null, prev = before.length ? sum(before, 'you') : null;
  const gate = week.filter(t => t.seg?.gate > 0).sort((a, b) => b.seg.gate - a.seg.gate)[0];
  // A ticket with no kickoff time (run by hand, or its file rewritten) has no lead: leave it out, don't count it as 0.
  const leads = week.map(t => t.seg?.lead).filter(x => x != null);
  const lead = !leads.length ? 'median lead unknown' : `median lead ${span(median(leads))}${leads.length < week.length ? ` (${leads.length} of ${week.length})` : ''}`;
  return { id: 'cycle', title: 'Where cycle time goes', n, value: n == null ? '—' : `${span(n)} on you`, prev: prev == null ? 'nothing merged' : span(prev),
    change: change(n, prev, 'time'), good: 'down',
    sub: week.length ? `agents ${span(sum(week, 'agent'))} · ${lead} · ${week.length} merged` : 'nothing merged in 7 days',
    action: !week.length ? 'Nothing merged in 7 days.' : gate ? `Longest plan-gate wait: ${label(gate.ticket, gate.machine)} (${span(gate.seg.gate)}).` : 'No plan-gate waits this week.',
    source: 'Process (run files, worker transcripts, pull requests)' };
}

// 3. Stalled work: orchestrated tickets not done whose step hasn't changed in 5 days, and Linear issues In Progress
// with no update in 7. Names the three oldest.
export function stalledCard({ runs = [], linear, now, prev = null }) {
  const stuck = [];
  for (const r of runs) for (const t of r.tickets ?? []) {
    const at = t.since ?? t.updatedAt ?? r.updatedAt;
    if (t.step !== 'done' && !t.stale && at && now - at > 5 * D) stuck.push({ name: label(t.ticket, r.machine), age: now - at });
  }
  for (const l of linear ?? []) {
    const at = Date.parse(l.updatedAt);
    if (l.state?.type === 'started' && at && now - at > 7 * D) stuck.push({ name: l.identifier, age: now - at });
  }
  stuck.sort((a, b) => b.age - a.age);
  const n = stuck.length;
  return { id: 'stalled', title: 'Stalled work', n, value: String(n), prev: prev == null ? null : String(prev), change: change(n, prev, 'count'), good: 'down',
    sub: `tickets with no step change in 5+ days; your Linear In Progress untouched 7+ days${linear ? '' : ' (Linear not read)'}`,
    action: n ? `Oldest: ${stuck.slice(0, 3).map(s => `${s.name} (${days(s.age)}d)`).join(', ')}.` : 'Nothing stalled.',
    source: 'Orchestration runs · Linear (assigned to you)' };
}

// 4. Portfolio activity: projects with a commit in the last 7 days, against the last 30, and those quiet for 30+.
// Names the ones that went quiet this past month: close them out or pick them back up.
export function portfolioCard({ projects = [], now, prev = null }) {
  const repos = projects.filter(p => p.repo && p.lastCommitAt);
  const n = repos.filter(p => now - p.lastCommitAt <= 7 * D).length, month = repos.filter(p => now - p.lastCommitAt <= 30 * D).length;
  const quiet = repos.filter(p => now - p.lastCommitAt > 30 * D);
  const recent = quiet.filter(p => now - p.lastCommitAt <= 60 * D).sort((a, b) => b.lastCommitAt - a.lastCommitAt);
  return { id: 'portfolio', title: 'Portfolio activity', n, value: `${n} active`, prev: prev == null ? null : `${prev} active`, change: change(n, prev, 'count'), good: null,
    sub: `${month} active in 30 days · ${quiet.length} quiet 30+ days · of ${repos.length} repos`,
    action: recent.length ? `Went quiet this month: ${recent.slice(0, 3).map(p => `${p.name} (${days(now - p.lastCommitAt)}d)`).join(', ')}. Close out or pick back up.` : 'No project went quiet this month.',
    source: 'git (last commit in each repo)' };
}

// 5. Grooming backlog: how much is waiting to be set up, and how old the oldest item is.
export function groomCard({ items, now, prev = null }) {
  if (!items) return { id: 'groom', title: 'Grooming backlog', n: null, value: '—', prev: prev == null ? null : String(prev), change: null, good: 'down',
    sub: '', action: 'The Groom queue could not be read.', source: 'Groom queue' };
  const oldest = [...items].sort((a, b) => a.at - b.at)[0];
  const n = items.length;
  return { id: 'groom', title: 'Grooming backlog', n, value: String(n), prev: prev == null ? null : String(prev), change: change(n, prev, 'count'), good: 'down',
    sub: n ? `oldest ${days(now - oldest.at)}d` : 'all clear',
    action: n ? `Oldest: ${short(oldest.title)} (${days(now - oldest.at)}d).` : 'Nothing to groom.', source: 'Groom queue (Waiting on, reviews, meetings, Linear)' };
}

// Pure: all five cards. `snapshots`: the weekly lines, for the cards that can't rebuild last week from today's data.
export function execCards({ usage, metrics, runs, linear, projects, groom, snapshots = [], now = Date.now() }) {
  const last = snapshots.filter(s => weekOf(s.at) === weekOf(weekOf(now) - 1)).at(-1)?.values ?? {};
  const tickets = metrics?.tickets ?? [];
  return [spendCard({ usage, tickets, now }), cycleCard({ tickets, now }), stalledCard({ runs, linear, now, prev: last.stalled ?? null }),
    portfolioCard({ projects, now, prev: last.portfolio ?? null }), groomCard({ items: groom, now, prev: last.groom ?? null })];
}

// The weekly snapshot: one JSON line per week, { at, values: { card id: number } }.
export async function readSnapshots(file) {
  try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
// Writes this week's line if there isn't one yet (only numbers that were read). Returns the snapshots as they now are.
export async function snapshotIfDue(file, snapshots, cards, now = Date.now()) {
  if (snapshots.some(s => weekOf(s.at) === weekOf(now))) return snapshots;
  const values = Object.fromEntries(cards.filter(c => typeof c.n === 'number').map(c => [c.id, c.n]));
  if (!Object.keys(values).length) return snapshots;
  const line = { at: now, values };
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(line)}\n`);
  return [...snapshots, line];
}
