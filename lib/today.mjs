// Today view, part 1: the candidates the morning planner will read. Pure: every function here takes the data Cleon
// already has and returns plain JSON, so the shape is tested without a disk, git or network. lib/today-read.mjs reads
// the facts the rules need.
//
// Nothing from inside a file goes into a candidate. A title or detail carries only a project name, a file or thread
// name, an age or a count, and a path is relative to its project.
import { sep } from 'node:path';
import { excludesFolder, excludesPath } from './config.mjs';
import { threadOf } from './knowledge.mjs';
import { localDate, oneLine } from './scan.mjs';

const D = 864e5;
// Most opportunities one rule hands on, so a folder of old plans can't fill the list.
export const PER_RULE = 10;
const OPEN_STATES = new Set(['unstarted', 'started']);
const pri = p => (p === 0 || p == null ? 9 : p);

// Pure: due and ready work items from Linear issues and PRs. Due: due today or overdue, Urgent priority, a PR waiting
// on your review, or your own PR with changes requested or failing checks. Ready: the rest of the Linear issues in an
// unstarted or started state. Urgent counts only on those; a triage or backlog issue is in only when due today or
// overdue. Completed and canceled issues are left out. `why` lists the reasons.
export function workItems({ linear = [], reviews = [], myPrs = [], now = Date.now() }) {
  const day = localDate(now), items = [];
  for (const i of linear) {
    const type = i.state?.type, open = OPEN_STATES.has(type);
    if (type === 'completed' || type === 'canceled') continue;
    const why = [];
    if (i.dueDate && i.dueDate < day) why.push('overdue');
    else if (i.dueDate === day) why.push('due-today');
    if (open && i.priority === 1) why.push('urgent');
    if (!open && !why.length) continue;
    items.push({ id: `linear:${i.identifier}`, source: 'linear', kind: why.length ? 'due' : 'ready', ref: i.identifier,
      title: oneLine(i.title, 200), url: i.url ?? null, priority: i.priority ?? 0, state: i.state?.name ?? null,
      dueDate: i.dueDate ?? null, why, updatedAt: i.updatedAt ?? null });
  }
  const ref = p => `${p.repository?.name ?? '?'}#${p.number ?? '?'}`;
  const pr = (p, why) => ({ id: `pr:${p.url}`, source: 'pr', kind: 'due', ref: ref(p), title: oneLine(p.title, 200) || ref(p),
    url: p.url ?? null, priority: 0, state: 'open', dueDate: null, why, updatedAt: p.updatedAt ?? null });
  for (const p of reviews) items.push(pr(p, ['review-requested']));
  for (const p of myPrs) {
    const why = [p.reviewDecision === 'CHANGES_REQUESTED' && 'changes-requested', p.checks === 'failing' && 'checks-failing'].filter(Boolean);
    if (why.length) items.push(pr(p, why));
  }
  return items.sort((a, b) => (a.kind === 'due' ? 0 : 1) - (b.kind === 'due' ? 0 : 1)
    || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9') || pri(a.priority) - pri(b.priority)
    || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

// Whole days, for display; the rules compare the exact time (`older`), so "more than 7 days" means 7 days and a minute.
const age = (at, now) => Math.floor((now - at) / D);
const older = (at, now, days) => now - at > days * D;
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const opp = (source, project, key, title, detail, ageDays = null) =>
  ({ id: `${source}:${project ?? '-'}:${key}`, source, project, title, detail, ageDays });
const kept = (list, exclude) => (list ?? []).filter(x => !excludesFolder(x.path, exclude));

// Pure: the six rules over the facts.
//   projects: [{ name, path, repo, lastCommitAt }]        dirty: [{ name, path, newestChange (ms|null), ahead }]
//   drafts: [{ project, path, files: [{ name, mtime }] }]  adrs: [{ project, path, file, proposed, mtime }]
//   plans: [{ ticket, path, file, mtime }]                runTickets: Set of ticket ids that have a run
//   linearOpen: open Linear issues, or null when Linear couldn't be read (rule 3 then doesn't fire)
export function opportunities({ projects = [], dirty = [], drafts = [], adrs = [], plans = [], runTickets = new Set(), linearOpen = null, now = Date.now(), exclude }) {
  const out = [], push = (list, newestFirst = false) =>
    out.push(...list.sort((a, b) => (newestFirst ? a.ageDays - b.ageDays : b.ageDays - a.ageDays)).slice(0, PER_RULE));

  push(kept(dirty, exclude).filter(d => d.newestChange != null && older(d.newestChange, now, 7))
    .map(d => opp('rule:uncommitted-old', d.name, 'changes', `${d.name} has uncommitted changes untouched for ${age(d.newestChange, now)} days`,
      'uncommitted changes', age(d.newestChange, now))));

  const unsent = [];
  for (const d of kept(drafts, exclude)) {
    const threads = new Map();
    for (const f of d.files) {
      if (excludesPath(`${d.path}/communications/${f.name}`, exclude)) continue;
      const t = threadOf(f.name), cur = threads.get(t.key) ?? { all: true, newest: 0, name: f.name };
      threads.set(t.key, { all: cur.all && t.draft, newest: Math.max(cur.newest, f.mtime), name: f.mtime >= cur.newest ? f.name : cur.name });
    }
    for (const t of threads.values()) if (t.all && older(t.newest, now, 5)) unsent.push(opp('rule:unsent-draft', d.project, t.name,
      `Draft ${t.name} in ${d.project} was never sent (${age(t.newest, now)} days)`, `communications/${t.name}`, age(t.newest, now)));
  }
  push(unsent);

  if (linearOpen) {
    const named = new Set(linearOpen.map(i => norm(i.project?.name)).filter(Boolean));
    push(kept(projects, exclude).filter(p => p.repo && p.lastCommitAt && !older(p.lastCommitAt, now, 7) && !named.has(norm(p.name)))
      .map(p => opp('rule:active-no-issue', p.name, 'commits', `${p.name} has commits in the last 7 days and no open Linear issue`,
        'recent commits, no open issue', age(p.lastCommitAt, now))));
  }

  // Newest first: the oldest plans are mostly tickets whose run folders were cleaned away.
  push(plans.filter(p => !excludesPath(`${p.path}/${p.file}`, exclude) && !runTickets.has(p.ticket))
    .map(p => opp('rule:plan-no-run', null, p.ticket, `The plan for ${p.ticket} has no run`, p.file, age(p.mtime, now))), true);

  push(kept(adrs, exclude).filter(a => a.proposed)
    .map(a => opp('rule:adr-proposed', a.project, a.file, `${a.file} in ${a.project} is still Proposed`, a.file, age(a.mtime, now))));

  push(kept(dirty, exclude).filter(d => d.ahead > 0)
    .map(d => opp('rule:unpushed', d.name, 'ahead', `${d.name} has ${d.ahead} unpushed commit${d.ahead === 1 ? '' : 's'}`, `${d.ahead} ahead`, 0)));
  return out;
}

// Pure: whether MC_EXCLUDE keeps a bare folder-like name out, compared the way excludesFolder compares a folder: as
// written, with a trailing separator, and with a leading one (so a pattern written for `[\/]name[\/]` matches too).
export const nameExcluded = (name, exclude) => Boolean(name) && (excludesFolder(name, exclude) || excludesFolder(`${sep}${name}`, exclude));
// Pure: Linear issues and PRs left out when their project or repository name matches an excluded folder name. There's
// no repo-to-folder map, so the names are all there is to compare: a PR's repository name (and owner/name), an
// issue's Linear project name.
export const unexcluded = ({ linear = [], reviews = [], myPrs = [] }, exclude) => {
  const prOk = p => !nameExcluded(p.repository?.name, exclude) && !nameExcluded(p.repository?.nameWithOwner, exclude);
  return { linear: linear.filter(i => !nameExcluded(i.project?.name, exclude)), reviews: reviews.filter(prOk), myPrs: myPrs.filter(prOk) };
};

// Pure: the whole candidates payload, shape v1. `linear` and `scm` are the sources' own answers (online or not).
export function buildCandidates({ linear, scm, facts, runTickets, now = Date.now(), exclude }) {
  const say = s => (s?.online ? 'ok' : `offline: ${s?.reason ?? 'not read'}`);
  return {
    v: 1, day: localDate(now), generatedAt: new Date(now).toISOString(),
    sources: { linear: say(linear), scm: say(scm), git: facts?.gitFailed ? `offline: ${facts.gitFailed} repo${facts.gitFailed === 1 ? '' : 's'} unreadable` : 'ok' },
    items: workItems({ ...unexcluded({ linear: linear?.online ? linear.issues : [], reviews: scm?.online ? scm.reviewRequests : [], myPrs: scm?.online ? scm.myPrs : [] }, exclude), now }),
    opportunities: opportunities({ ...facts, runTickets, linearOpen: linear?.online ? linear.issues : null, now, exclude }),
  };
}
