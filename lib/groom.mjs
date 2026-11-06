// Groom queue: one list of everything waiting to be set up, from every source, with the same actions on each item
// (where they apply): Do it, Make a ticket, Wait on it, Snooze, Dismiss. Sources: Inbox transcript flags
// (lib/scan.mjs), Waiting on items overdue or maybe answered (lib/waiting.mjs), pull requests waiting on your
// review (lib/github.mjs, lib/bitbucket.mjs), and Linear issues that need filling out (lib/linear.mjs).
// Snoozes and the queue's own hides are kept in data/groom-<port>.json, per Cleon port.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { oneLine, localDate } from './scan.mjs';

const D = 864e5;
export const blankGroom = () => ({ v: 1, snoozed: {}, hidden: {} });
export async function readGroom(file) {
  try { const s = JSON.parse(await readFile(file, 'utf8')); return { ...blankGroom(), snoozed: s.snoozed ?? {}, hidden: s.hidden ?? {} }; } catch { return blankGroom(); }
}
export async function writeGroom(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 1));
  await rename(tmp, file);
}

// What each kind is called, in its order in the queue.
export const KINDS = { waiting: 'waiting on', review: 'review request', transcript: 'meeting', linear: 'Linear issue' };
const RANK = Object.keys(KINDS);
// A Linear issue needs filling out when it's in Triage or its description is (nearly) empty. Plain Backlog isn't
// enough: most assigned issues sit there, fully written.
const thin = s => oneLine(s, 400).replace(/[#*_`>\-\s]/g, '').length < 20;
const https = (url, hosts) => {
  try { const u = new URL(url); return u.protocol === 'https:' && hosts.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`)) ? url : null; } catch { return null; }
};

// Pure: the queue. `inbox`: { flags, transcripts } from the Inbox; `waiting`: the Waiting on view's items;
// `reviews`: pull requests waiting on your review; `linear`: your assigned Linear issues; `projects`: [{ id, name }]
// (a review's repo is matched to a project by folder name); `state`: snoozes and hides; `hosts`: the hosts links may
// point at for reviews and Linear. Each item: { key, kind, title, sub, at, link, project, date, who, actions, doLabel }.
export function groomQueue({ inbox, waiting = [], reviews = [], linear = [], projects = [], state = blankGroom(), now = Date.now(), hosts = ['github.com', 'linear.app'] }) {
  const byName = new Map(projects.map(p => [p.name.toLowerCase(), p.id]));
  const items = [];
  const add = i => { if (!(state.snoozed[i.key] > now) && !state.hidden[i.key]) items.push(i); };
  for (const w of waiting.filter(i => i.overdue || i.maybe)) add({
    key: `waiting:${w.id}`, kind: 'waiting', title: w.what,
    sub: `from ${w.who}${w.maybe ? ` · maybe answered${w.maybe.from ? ` by ${w.maybe.from}` : ''}` : ''}${w.overdue ? ` · overdue, due ${w.due}` : ''}`,
    at: w.added, link: w.maybe?.link ?? null, project: w.project ?? null, date: localDate(w.added), who: null,
    doLabel: w.maybe?.link ? 'Message' : null, actions: ['do', 'ticket', 'snooze', 'dismiss'],
  });
  for (const r of reviews) {
    const at = Date.parse(r.updatedAt) || now, repo = r.repository?.name ?? null;
    const link = https(r.url, hosts);
    add({ key: `review:${r.url}`, kind: 'review', title: oneLine(r.title, 200) || `#${r.number}`,
      sub: `${repo ?? '?'}#${r.number}${r.author?.login ? ` · by ${r.author.login}` : ''}`, at, link,
      project: repo ? byName.get(repo.toLowerCase()) ?? null : null, date: localDate(at), who: r.author?.login ?? null,
      doLabel: link ? 'Open PR' : null, actions: ['do', 'ticket', 'wait', 'snooze', 'dismiss'] });
  }
  for (const f of inbox?.flags ?? []) add({
    key: `transcript:${f.id}`, kind: 'transcript', title: f.subject, sub: `${f.project} · ${f.date} · file as ${f.folder}/${f.file}`,
    at: f.end, link: f.link, project: f.projectId, date: f.date, who: f.organizer ?? null,
    doLabel: inbox.transcripts === 'ok' ? 'Ingest' : f.link ? 'Outlook' : null, actions: ['do', 'ticket', 'wait', 'snooze', 'dismiss'],
  });
  for (const l of linear.filter(i => i.state?.type === 'triage' || thin(i.description))) {
    const at = Date.parse(l.updatedAt) || now, link = https(l.url, hosts);
    add({ key: `linear:${l.identifier}`, kind: 'linear', title: `${l.identifier} ${oneLine(l.title, 200)}`,
      sub: `${l.state?.name ?? '?'}${l.project?.name ? ` · ${l.project.name}` : ''}${thin(l.description) ? ' · no description yet' : ''}`,
      at, link, project: null, date: localDate(at), who: null, doLabel: link ? 'Open' : null, actions: ['do', 'snooze', 'dismiss'] });
  }
  // Only the actions an item can really take: Do it needs something to do, Make a ticket a project, Wait on it a person.
  for (const i of items) i.actions = i.actions.filter(a => (a !== 'do' || i.doLabel) && (a !== 'ticket' || i.project) && (a !== 'wait' || i.who));
  return items.sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind) || a.at - b.at);
}

// Pure: when a snooze ends: 8:00 tomorrow, or 8:00 next Monday (a week on, if today is Monday), local time.
export function snoozeUntil(option, now = Date.now()) {
  const d = new Date(now); d.setHours(8, 0, 0, 0);
  if (option === 'tomorrow') d.setDate(d.getDate() + 1);
  else if (option === 'monday') d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  else return null;
  return d.getTime();
}
// Pure: snoozes past their time and hides for items gone from every source over 30 days ago are dropped. `live`: the
// keys the sources have now (snoozed or hidden ones included).
export function pruneGroom(state, live, now = Date.now()) {
  return { ...state, snoozed: Object.fromEntries(Object.entries(state.snoozed).filter(([, until]) => until > now)),
    hidden: Object.fromEntries(Object.entries(state.hidden).filter(([k, at]) => live.has(k) || now - at < 30 * D)) };
}

// Pure: the command Make a ticket types into a new herdr pane in the item's project: an interactive Claude session
// running /new-task. Built from the item's kind and date only, never its title or text, and refused unless every
// piece is plain characters, since it's typed into a shell. You tell it what the ticket is for.
const TICKET_FROM = { waiting: 'a waiting-on item added', review: 'a review request from', transcript: 'the meeting on' };
export function ticketCommand(kind, date) {
  const from = TICKET_FROM[kind];
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  return `claude "/new-task A ticket about ${from} ${date} in this project. Ask me what it should cover."`;
}
