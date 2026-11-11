// "Waiting on": things you're waiting for from someone (credentials from IT, a vendor's answer), each with who
// it's from, an optional project and an optional due date. The Inbox scan (lib/scan.mjs) looks for the answer
// in mail and Teams; a likely one marks the item "maybe answered", with a link to the message. Only you close
// an item. Kept in data/waiting-<port>.json, per Cleon port, so a test Cleon never touches the real list.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from './atomic.mjs';
import { oneLine, localDate } from './scan.mjs';

const D = 864e5;
export const blankWaiting = () => ({ v: 1, items: {} });
export async function readWaiting(file) {
  try { const s = JSON.parse(await readFile(file, 'utf8')); return { ...blankWaiting(), ...s, items: s.items ?? {} }; } catch { return blankWaiting(); }
}
export async function writeWaiting(file, state) {
  await writeFileAtomic(file, JSON.stringify(state, null, 1));
}

const DUE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = s => DUE.test(s) && localDate(new Date(`${s}T12:00:00`).getTime()) === s;
// Pure: what the panel sent, checked. `projects`: the ids it may name ("<category>/<folder>"). Returns the
// fields to keep, or why not.
export function cleanItem(input, projects) {
  const what = oneLine(input?.what, 200), who = oneLine(input?.who, 120);
  if (!what) return { ok: false, reason: 'say what you are waiting for' };
  if (!who) return { ok: false, reason: 'say who it is from' };
  const project = input?.project ? String(input.project) : null;
  if (project && !projects.includes(project)) return { ok: false, reason: 'not a known project' };
  const due = input?.due ? String(input.due) : null;
  if (due && !validDay(due)) return { ok: false, reason: 'the due date must be YYYY-MM-DD' };
  return { ok: true, fields: { what, who, project, due } };
}

// Pure: add a new item, or edit an open one. `id`: an existing item's, or none for a new one.
export function saveItem(state, id, fields, now = Date.now(), newId = () => randomBytes(6).toString('hex')) {
  const items = { ...state.items };
  if (id) {
    const had = items[id];
    if (!had || had.closed) return { ok: false, reason: 'no such open item' };
    items[id] = { ...had, ...fields };
    return { ok: true, id, state: { ...state, items } };
  }
  const nid = newId();
  items[nid] = { id: nid, ...fields, added: now, closed: null, maybe: null, checked: null, after: null };
  return { ok: true, id: nid, state: { ...state, items } };
}
// Pure: close an item (kept 90 days, then dropped), or say a "maybe answered" message wasn't the answer: it's
// cleared, and the next scans look only after it, so it isn't found again.
export function closeItem(state, id, now = Date.now()) {
  const had = state.items[id];
  if (!had || had.closed) return { ok: false, reason: 'no such open item' };
  return { ok: true, state: { ...state, items: { ...state.items, [id]: { ...had, closed: now } } } };
}
export function notYet(state, id) {
  const had = state.items[id];
  if (!had?.maybe) return { ok: false, reason: 'nothing to clear' };
  return { ok: true, state: { ...state, items: { ...state.items, [id]: { ...had, maybe: null, after: Math.max(had.after ?? 0, (had.maybe.at ?? had.maybe.found) + 1000) } } } };
}

// Pure: past its due date (the whole due day has gone by).
export const overdue = (item, now) => Boolean(item.due && localDate(now) > item.due);

// Pure: what the scan is asked about: open items not already marked maybe answered, each from when to look.
// A message from the hours before the last check is looked at again (it may not have been indexed yet), but
// never one from before the item was added or before a "not yet".
export function toCheck(state, now) {
  return Object.values(state.items).filter(i => !i.closed && !i.maybe).map(i => ({
    id: i.id, what: i.what, who: i.who,
    since: Math.max(i.added, i.after ?? 0, i.checked ? i.checked - 6 * 36e5 : 0, now - 30 * D),
  }));
}
// Pure: the scan's answers folded in. `asked`: the ids it was asked about; `answers`: checked by checkScan.
export function applyAnswers(state, asked, answers, now) {
  const items = { ...state.items };
  for (const id of asked) if (items[id] && !items[id].closed) items[id] = { ...items[id], checked: now };
  for (const a of answers) {
    const i = items[a.id];
    if (!i || i.closed || i.maybe || !a.resolved) continue;
    if (a.at != null && a.at < (i.after ?? 0)) continue; // a message already said not to be the answer
    items[a.id] = { ...i, maybe: { at: a.at, found: now, link: a.link, from: a.from, why: a.why } };
  }
  return { ...state, items };
}

// Pure: the panel's list: open items, overdue first, then maybe answered, then the longest waiting. Closed items
// over 90 days old are left out (and dropped when next saved, by `prune`).
export function waitingView(state, now) {
  const rank = i => (overdue(i, now) ? 0 : i.maybe ? 1 : 2);
  return Object.values(state.items).filter(i => !i.closed)
    .map(i => ({ ...i, overdue: overdue(i, now), days: Math.floor((now - i.added) / D) }))
    .sort((a, b) => rank(a) - rank(b) || a.added - b.added);
}
export const prune = (state, now) => ({ ...state, items: Object.fromEntries(Object.entries(state.items).filter(([, i]) => !i.closed || now - i.closed < 90 * D)) });
