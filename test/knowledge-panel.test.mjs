import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { beltShares, relatedProjects, liveRecents, orbitingOrder } from '../public/knowledge-panel.mjs';
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
