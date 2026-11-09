import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { beltShares, relatedProjects, relatedPage, liveRecents, orbitingOrder, linkShares, linkReasons, linkWhy } from '../public/knowledge-panel.mjs';
import { projectKey } from '../public/radial-layout.mjs';
import { buildIndex, parseFolders } from '../lib/knowledge.mjs';
import { excludePattern } from '../lib/config.mjs';

// Trees shaped like /api/knowledge's (lib/knowledge.mjs): root → category → project, with belts. Every name is an
// ACME- one.
const T0 = Date.UTC(2026, 8, 1), DAY = 864e5;
const project = (cat, name) => ({ id: `p:/acme/${cat}/${name}`, kind: 'proj', name, category: cat, path: `/acme/${cat}/${name}`, count: 0, children: [] });
const tree = cats => ({ id: 'root', kind: 'root', name: 'dev', count: 0,
  children: Object.entries(cats).map(([c, ps]) => ({ id: `c:${c}`, kind: 'cat', name: c, count: ps.length, children: ps })) });
// A belt item orbiting `projects` (and `extra` keys, projects the tree doesn't hold), placed in each one's belt as the
// index does: one node per belt, the same file.
function orbit(file, projects, { extra = [], topic = 'vault · wiki', mtime = T0 } = {}) {
  const orbits = [...projects.map(p => ({ project: projectKey(p), name: p.name, how: 'mention', why: `names ${p.name}` })),
    ...extra.map(k => ({ project: k, name: k, how: 'link', why: 'links to it' }))];
  for (const p of projects) (p.belt ??= []).push({ id: `b-${p.name}-${file}`, kind: 'belt', name: `ACME-${file}.md`, file: `fb-${file}`,
    rel: `vault/ACME-${file}.md`, ext: 'md', mtime, src: 'vault', topic, orbits, why: `names ${p.name}` });
}

test('related projects: weighted by shared belt items, each item once per pair however many belts list it', () => {
  const [a, b, c] = ['ACME-a', 'ACME-b', 'ACME-c'].map(n => project('tools', n)), d = project('work', 'ACME-d');
  orbit('x', [a, b]);
  orbit('y', [a, b, c]);
  orbit('z', [a, d], { extra: ['tools/ACME-gone'] }); // a project no longer in the tree doesn't count
  orbit('solo', [c]);
  const s = beltShares(tree({ tools: [a, b, c], work: [d] }));
  const w = (p, q) => s.get(projectKey(p))?.get(projectKey(q)) ?? 0;
  assert.equal(w(a, b), 2);
  assert.equal(w(b, a), 2); // both ways
  assert.equal(w(a, c), 1);
  assert.equal(w(b, c), 1);
  assert.equal(w(a, d), 1);
  assert.equal(w(c, d), 0);
  assert.equal(s.get(projectKey(a)).has('tools/ACME-gone'), false);
  assert.equal(s.has('tools/ACME-gone'), false);
  assert.deepEqual(relatedProjects(projectKey(a), [s]).map(r => [r.name, r.n]), [['ACME-b', 2], ['ACME-c', 1], ['ACME-d', 1]]);
  assert.deepEqual(relatedProjects(projectKey(c), [s]).map(r => r.key), ['tools/ACME-a', 'tools/ACME-b']);
  assert.deepEqual(relatedProjects('tools/ACME-nothing', [s]), []);
});

test('related projects: the top 5, ties by name A–Z then key, the same whatever order the belts come in', () => {
  const hub = project('tools', 'ACME-hub');
  // Weights 3, 2, 2, 2, 1, 1, 1 (ACME-m twice, in two categories: a tie on name too), so the cut falls inside the 1s.
  const others = { 'ACME-k': 3, 'ACME-c': 2, 'ACME-m': 2, 'ACME-z': 1, 'ACME-b': 1, 'ACME-y': 1 };
  const build = order => {
    const ps = Object.keys(others).map(n => (n === 'ACME-m' ? project('work', n) : project('tools', n)));
    const twin = project('misc', 'ACME-m');
    const jobs = [];
    ps.forEach(p => { for (let i = 0; i < others[p.name]; i++) jobs.push([`${p.name}-${i}`, [hub, p]]); });
    jobs.push(['twin-0', [hub, twin]], ['twin-1', [hub, twin]]);
    for (const [f, on] of order(jobs)) orbit(f, on);
    const t = tree({ tools: [hub, ...ps.filter(p => p.category === 'tools')], work: ps.filter(p => p.category === 'work'), misc: [twin] });
    for (const p of [hub, ...ps, twin]) p.belt?.reverse(); // the index's own belt order (by topic) mustn't matter either
    return relatedProjects(projectKey(hub), [beltShares(t)]);
  };
  const want = [['tools/ACME-k', 3], ['tools/ACME-c', 2], ['misc/ACME-m', 2], ['work/ACME-m', 2], ['tools/ACME-b', 1]];
  for (const order of [j => j, j => [...j].reverse(), j => [...j].sort((x, y) => (x[0] < y[0] ? 1 : -1))])
    assert.deepEqual(build(order).map(r => [r.key, r.n]), want);
  assert.equal(build(j => j).length, 5);
});

test('related projects: several sources of weight are summed, each kept in `by`', () => {
  const s1 = new Map([['tools/ACME-a', new Map([['tools/ACME-b', 1], ['tools/ACME-c', 3]])]]);
  const s2 = new Map([['tools/ACME-a', new Map([['tools/ACME-b', 4], ['work/ACME-d', 1]])]]);
  assert.deepEqual(relatedProjects('tools/ACME-a', [s1, s2]), [
    { key: 'tools/ACME-b', name: 'ACME-b', n: 5, by: [1, 4] },
    { key: 'tools/ACME-c', name: 'ACME-c', n: 3, by: [3, 0] },
    { key: 'work/ACME-d', name: 'ACME-d', n: 1, by: [0, 1] },
  ]);
  assert.equal(relatedProjects('tools/ACME-a', [s1, s2], 2).length, 2);
});

test('related projects: with 6 shared by belt items and 1 only by a link, all 7 are reachable, the linked one with its file', () => {
  const hub = project('tools', 'ACME-hub'), linked = project('work', 'ACME-linked');
  const belted = ['ACME-a', 'ACME-b', 'ACME-c', 'ACME-d', 'ACME-e', 'ACME-f'].map(n => project('tools', n));
  belted.forEach((p, i) => { for (let j = 0; j < 6 - i; j++) orbit(`${p.name}-${j}`, [hub, p]); }); // weights 6 down to 1
  const t = tree({ tools: [hub, ...belted], work: [linked] });
  t.links = [{ from: 'tools/ACME-hub', to: 'work/ACME-linked', file: 'README.md', target: 'docs/plan.md', n: 1 }];
  const related = relatedProjects('tools/ACME-hub', [beltShares(t), linkShares(t)], Infinity);
  assert.equal(related.length, 7); // what the header counts
  const top = relatedPage(related, false);
  assert.deepEqual(top.rows.map(r => r.name), ['ACME-a', 'ACME-b', 'ACME-c', 'ACME-d', 'ACME-e']);
  assert.equal(top.hidden, 2);
  assert.equal(top.rows.some(r => r.key === 'work/ACME-linked'), false); // the top 5 alone would lose it
  const all = relatedPage(related, true);
  assert.equal(all.hidden, 0);
  assert.deepEqual(all.rows.map(r => r.key).sort(), [...belted.map(projectKey), 'work/ACME-linked'].sort());
  const row = all.rows.find(r => r.key === 'work/ACME-linked');
  assert.deepEqual(row.by, [0, 1]); // 0 shared, 1 link
  assert.equal(linkWhy(linkReasons(t, 'tools/ACME-hub').get(row.key), row.name), 'README.md → ACME-linked/docs/plan.md');
  assert.deepEqual(all.rows.find(r => r.name === 'ACME-f').by, [1, 0]);
  assert.deepEqual(relatedPage(related.slice(0, 3), false), { rows: related.slice(0, 3), hidden: 0 });
});

test('links between projects count both ways beside shared belt items, each with the linking file; links to projects not in the tree do not', () => {
  const [portal, ops] = [project('tools', 'acme-portal'), project('tools', 'acme-ops')], billing = project('work', 'acme-billing');
  orbit('x', [portal, ops]);
  const t = tree({ tools: [portal, ops], work: [billing] });
  t.links = [
    { from: 'tools/acme-portal', to: 'work/acme-billing', file: 'README.md', target: 'docs/plan.md', n: 2 },
    { from: 'work/acme-billing', to: 'tools/acme-portal', file: 'README.md', target: 'docs/guide.md', n: 1 },
    { from: 'tools/acme-portal', to: 'tools/acme-gone', file: 'README.md', target: 'x.md', n: 5 }, // no longer in the tree
    { from: 'tools/acme-ops', to: 'tools/acme-ops', file: 'a.md', target: 'b.md', n: 1 }, // not between two projects
  ];
  const links = linkShares(t);
  assert.deepEqual([...links.get('tools/acme-portal')], [['work/acme-billing', 3]]);
  assert.deepEqual([...links.get('work/acme-billing')], [['tools/acme-portal', 3]]);
  assert.equal(links.has('tools/acme-ops'), false);
  assert.deepEqual(relatedProjects('tools/acme-portal', [beltShares(t), links], Infinity), [
    { key: 'work/acme-billing', name: 'acme-billing', n: 3, by: [0, 3] },
    { key: 'tools/acme-ops', name: 'acme-ops', n: 1, by: [1, 0] },
  ]);
  const why = linkReasons(t, 'tools/acme-portal');
  assert.deepEqual([...why.keys()], ['work/acme-billing']);
  assert.equal(linkWhy(why.get('work/acme-billing'), 'acme-billing'), 'README.md → acme-billing/docs/plan.md · +2 more');
  assert.equal(linkWhy(linkReasons(t, 'work/acme-billing').get('tools/acme-portal'), 'acme-portal'), 'README.md → acme-portal/docs/guide.md · +2 more');
  t.links = [t.links[1]];
  assert.equal(linkWhy(linkReasons(t, 'tools/acme-portal').get('work/acme-billing'), 'acme-billing'), 'acme-billing/README.md → docs/guide.md');
  assert.equal(linkWhy(undefined, 'x'), '');
  assert.equal(linkShares({ children: [] }).size, 0);
});

test('orbiting: by topic A–Z, newest first within a topic', () => {
  const p = project('tools', 'ACME-p');
  orbit('old', [p], { topic: 'vault · wiki', mtime: T0 - 9 * DAY });
  orbit('new', [p], { topic: 'vault · wiki', mtime: T0 });
  orbit('note', [p], { topic: 'memory · project', mtime: T0 - 30 * DAY });
  orbit('raw', [p], { topic: 'vault · raw', mtime: T0 + DAY });
  assert.deepEqual(orbitingOrder(p.belt).map(b => b.name), ['ACME-note.md', 'ACME-raw.md', 'ACME-new.md', 'ACME-old.md']);
  assert.deepEqual(orbitingOrder(undefined), []);
  assert.equal(p.belt[0].name, 'ACME-old.md'); // not sorted in place
});

test('recently opened: an empty map drops nothing, a malformed entry always drops, another spelling of a path still counts', () => {
  const a = project('tools', 'ACME-a'), b = project('tools', 'ACME-b');
  const ra = { path: a.path, name: 'ACME-a', app: 'vscode', at: T0 };
  const rb = { path: b.path.toUpperCase().replace(/\//g, '\\'), name: 'ACME-b', app: 'bash', at: T0 - 1 };
  const gone = { path: '/acme/tools/ACME-gone', name: 'ACME-gone', app: 'herdr', at: T0 - 2 };
  const recent = [ra, null, rb, 'ACME-x', { name: 'no path' }, gone];
  const live = liveRecents(recent, tree({ tools: [a, b] }));
  assert.deepEqual(live.map(r => [r.name, r.path]), [['ACME-a', a.path], ['ACME-b', b.path]]); // b in the tree's spelling
  assert.equal(live[0], ra); // unchanged entries come back as they were, so the page can tell nothing changed
  // MC_ROOT unreadable for a moment gives a tree with no projects: that's no reason to forget them.
  for (const empty of [tree({}), tree({ tools: [] })]) assert.deepEqual(liveRecents(recent, empty), [ra, rb, gone]);
});

test('recently opened: a project removed since, or that MC_EXCLUDE now matches, drops out on the next load', async () => {
  const base = await mkdtemp(join(os.tmpdir(), 'cleon-kp-'));
  try {
    const root = join(base, 'dev'), mem = join(base, 'claude-projects');
    const dir = n => join(root, 'tools', n);
    for (const n of ['ACME-one', 'ACME-two', 'ACME-hidden']) {
      await mkdir(join(dir(n), 'docs'), { recursive: true });
      await writeFile(join(dir(n), 'docs', 'plan.md'), `# ${n}`);
    }
    await mkdir(mem, { recursive: true });
    const recent = ['ACME-two', 'ACME-gone', 'ACME-hidden', 'ACME-one'].map((n, i) => ({ path: dir(n), name: n, app: 'vscode', at: T0 - i }));
    const load = exclude => buildIndex({ root, categories: ['tools'], exclude, memoryRoot: mem, folders: parseFolders(null), vault: null });
    // Before: nothing excluded, so only the removed one (never on disk here) drops out.
    const before = await load(excludePattern(''));
    assert.deepEqual(liveRecents(recent, before.tree).map(r => r.name), ['ACME-two', 'ACME-hidden', 'ACME-one']);
    // After MC_EXCLUDE starts matching one: it drops out too, and the rest keep their order.
    const after = await load(excludePattern('acme-hidden'));
    assert.deepEqual(liveRecents(recent, after.tree).map(r => r.name), ['ACME-two', 'ACME-one']);
    assert.deepEqual(liveRecents([], after.tree), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
