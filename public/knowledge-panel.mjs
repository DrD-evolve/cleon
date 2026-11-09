// The Knowledge panel's side panel, apart from drawing so it can be tested: related projects, the recents that are
// still on the map, and the order of a project's belt. Pure: no DOM, no clock, and the tree isn't changed. The page
// (app.js) imports it, and so do the tests.
import { projectKey } from './radial-layout.mjs';

// Code-unit order, so ties fall the same way in every runtime (localeCompare depends on the ICU build).
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const projectsOf = tree => (tree?.children ?? []).flatMap(c => c.children ?? []);

// Pure: how many belt items each pair of projects in the tree shares, both ways: Map<key, Map<other key, n>>, keys as
// projectKey gives them (`category/name`, how a belt item's orbits name a project). An item counts once per pair,
// however many belts list it (the index repeats it in the belt of each project it orbits). Orbits of projects not in
// the tree don't count.
export function beltShares(tree) {
  const projects = projectsOf(tree), keys = new Set(projects.map(projectKey)), seen = new Set(), out = new Map();
  for (const p of projects) for (const b of p.belt ?? []) {
    if (seen.has(b.file)) continue;
    seen.add(b.file);
    const on = [...new Set((b.orbits ?? []).map(o => o.project).filter(k => keys.has(k)))];
    for (const a of on) for (const c of on) {
      if (a === c) continue;
      if (!out.has(a)) out.set(a, new Map());
      out.get(a).set(c, (out.get(a).get(c) ?? 0) + 1);
    }
  }
  return out;
}

// The links between projects' documents in the tree (the root's `links`, lib/belts.mjs linkEdges), leaving out any
// to or from a project the tree doesn't hold.
function liveLinks(tree) {
  const keys = new Set(projectsOf(tree).map(projectKey));
  return (Array.isArray(tree?.links) ? tree.links : []).filter(e => keys.has(e?.from) && keys.has(e?.to) && e.from !== e.to && e.n > 0);
}
// Pure: how many documents each pair of projects links, either way, in beltShares' shape: Map<key, Map<other key, n>>.
export function linkShares(tree) {
  const out = new Map(), add = (a, b, n) => { if (!out.has(a)) out.set(a, new Map()); out.get(a).set(b, (out.get(a).get(b) ?? 0) + n); };
  for (const e of liveLinks(tree)) { add(e.from, e.to, e.n); add(e.to, e.from, e.n); }
  return out;
}
// Pure: why a project and each other one are linked: Map<other key, [{ out, file, target, n }]>, the project's own
// links to the other first (`out`: `file` is the project's, `target` the other's), then the other's to it.
export function linkReasons(tree, key) {
  const out = new Map();
  for (const e of liveLinks(tree)) {
    const mine = e.from === key, other = mine ? e.to : e.to === key ? e.from : null;
    if (!other) continue;
    if (!out.has(other)) out.set(other, []);
    out.get(other)[mine ? 'unshift' : 'push']({ out: mine, file: e.file, target: e.target, n: e.n });
  }
  return out;
}
// Pure: one line saying why, plain text: the first link, the other project's name before whichever path is in it
// ("README.md → acme-billing/docs/plan.md", or "acme-billing/README.md → docs/guide.md"), and how many more.
export function linkWhy(reasons, otherName) {
  const r = reasons?.[0];
  if (!r) return '';
  const more = reasons.reduce((a, x) => a + x.n, 0) - 1;
  return `${r.out ? `${r.file} → ${otherName}/${r.target}` : `${otherName}/${r.file} → ${r.target}`}${more > 0 ? ` · +${more} more` : ''}`;
}

// Pure: a project's related projects. `sources` are maps of weights like beltShares' (shared belt items, and links
// between projects' documents from linkShares), summed per project. Heaviest first, ties by name A–Z, then by key, at
// most `limit`. Each: { key, name, n, by } (`by`: each source's own weight, in the order of `sources`).
export function relatedProjects(key, sources, limit = 5) {
  const by = new Map();
  sources.forEach((s, i) => {
    for (const [other, n] of s.get(key) ?? []) {
      if (!by.has(other)) by.set(other, sources.map(() => 0));
      by.get(other)[i] += n;
    }
  });
  const nameOf = k => k.slice(k.indexOf('/') + 1);
  return [...by].map(([k, ws]) => ({ key: k, name: nameOf(k), n: ws.reduce((a, b) => a + b, 0), by: ws }))
    .sort((a, b) => b.n - a.n || cmp(a.name, b.name) || cmp(a.key, b.key)).slice(0, limit);
}

// Pure: the recently opened projects ({ path, … }) that are still on the map, in their order. One removed since, or
// that MC_EXCLUDE now matches, isn't in the tree. A path matches whatever its slashes or case (Windows ignores both, so
// MC_ROOT spelled another way keeps them), and one kept takes the tree's spelling; the rest are returned as they came.
// A tree with no projects says nothing about what was removed (MC_ROOT unreadable for a moment), so nothing drops out
// of it, except what isn't an entry at all.
export function liveRecents(recent, tree) {
  const key = p => p.replace(/\\/g, '/').toLowerCase();
  const paths = new Map(projectsOf(tree).map(p => [key(p.path), p.path]));
  const ok = recent.filter(r => typeof r?.path === 'string');
  if (!paths.size) return ok;
  return ok.flatMap(r => {
    const at = paths.get(key(r.path));
    return at === undefined ? [] : [at === r.path ? r : { ...r, path: at }];
  });
}

// Pure: a project's belt as the panel lists it: by topic A–Z, newest first within a topic, then by name and id.
export const orbitingOrder = belt => [...(belt ?? [])].sort((a, b) => cmp(a.topic ?? '', b.topic ?? '') || (b.mtime ?? 0) - (a.mtime ?? 0)
  || cmp(a.name, b.name) || cmp(a.id, b.id));
