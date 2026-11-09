import { test } from 'node:test';
import assert from 'node:assert/strict';
import { radialLayout, placeLabels, sectorBounds, circularMean, projectKey, GEOM, TAU } from '../public/radial-layout.mjs';

// Trees shaped like /api/knowledge's (lib/knowledge.mjs), built here: root → category → project → group → item, with
// belts. Every name is an ACME- one.
const DAY = 864e5, T0 = Date.UTC(2026, 8, 1);
const GROUPS = ['docs', 'comms', 'outputs', 'memory'];
// A project with `count` documents dealt round the four groups, their ages shuffled (7919 is prime, so i → i·7919 mod
// count visits every age once).
function project(cat, name, count) {
  const path = `/acme/${cat}/${name}`;
  const kids = GROUPS.map(g => ({ id: `g:${path}#${g}`, kind: 'group', group: g, name: g, count: 0, children: [] }));
  for (let i = 0; i < count; i++) {
    const g = kids[i % 4];
    g.children.push({ id: `t-${name}-${i}`, kind: 'item', name: `ACME-${name}-${i}.md`, file: `f-${name}-${i}`, rel: `docs/ACME-${i}.md`,
      ext: 'md', mtime: T0 - ((i * 7919) % count) * DAY, ...(i % 9 === 4 && g.group === 'docs' ? { status: 'Accepted' } : {}) });
    g.count++;
  }
  return { id: `p:${path}`, kind: 'proj', name, category: cat, path, count, children: kids };
}
const tree = (cats, belt) => ({
  id: 'root', kind: 'root', name: 'dev', count: Object.values(cats).flat().length,
  children: Object.entries(cats).map(([c, ps]) => ({ id: `c:${c}`, kind: 'cat', name: c, count: ps.length, children: ps })),
  ...(belt?.length ? { belt } : {}),
});
// A belt item orbiting `projects`, placed in each one's belt as the index does (one node per belt, the same file).
function orbit(name, projects, topic = 'vault · wiki') {
  const orbits = projects.map(p => ({ project: projectKey(p), name: p.name, how: 'mention', why: `names ${p.name}` }));
  for (const p of projects) (p.belt ??= []).push({ id: `b-${p.name}-${name}`, kind: 'belt', name: `ACME-${name}.md`, file: `fb-${name}`,
    rel: `vault/ACME-${name}.md`, ext: 'md', mtime: T0, src: 'vault', topic, orbits, why: `names ${p.name}` });
}
const stray = name => ({ id: `b-${name}`, kind: 'belt', name: `ACME-${name}.md`, file: `fs-${name}`, rel: `mem/ACME-${name}.md`, ext: 'md',
  mtime: T0, src: 'memory', topic: 'memory · project', orbits: [], why: null });
const angDist = (a, b) => { const d = Math.abs(((a - b) % TAU + TAU) % TAU); return Math.min(d, TAU - d); };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('sectors: each angle is proportional to its items, with a minimum, and with the gaps they fill the circle', () => {
  const t = tree({ tools: [project('tools', 'acme-a', 200), project('tools', 'acme-b', 100)], work: [project('work', 'acme-c', 100)],
    misc: [project('misc', 'acme-d', 1)], empty: [] });
  const { sectors } = radialLayout(t);
  assert.deepEqual(sectors.map(s => s.name), ['tools', 'work', 'misc']); // a category with no projects has no sector
  const [tools, work, misc] = sectors;
  near(tools.span / work.span, 3);
  // misc holds 1 of 401 items, below the minimum share, so it gets the minimum.
  near(misc.span / tools.span, GEOM.MIN_SHARE / (300 / 401));
  assert.ok(misc.span > work.span / 100 * 1.5);
  near(sectors.reduce((a, s) => a + s.span, 0) + GEOM.GAP * sectors.length, TAU);
  for (let i = 1; i < sectors.length; i++) near(sectors[i].a0, sectors[i - 1].a1 + GEOM.GAP);
  // With items that orbit nothing, the uncharted slot takes its share first.
  const u = radialLayout(tree({ tools: [project('tools', 'acme-a', 3)], work: [project('work', 'acme-c', 1)] }, [stray('x'), stray('y')]));
  near(u.sectors.reduce((a, s) => a + s.span, 0) + GEOM.GAP * 2 + (u.uncharted.a1 - u.uncharted.a0), TAU);
  near(u.sectors[0].span / u.sectors[1].span, 3);
});

test('a ray runs newest first, outward from its hub', () => {
  const p = project('tools', 'acme-ray', 37);
  const { hubs, items } = radialLayout(tree({ tools: [p] }));
  const ray = hubs[0].items.map(i => items[i]);
  assert.equal(ray.length, 37);
  const byAge = [...ray].sort((a, b) => b.t.mtime - a.t.mtime);
  for (let i = 1; i < byAge.length; i++) assert.ok(byAge[i].R >= byAge[i - 1].R, `${byAge[i].t.name} is nearer the hub than a newer one`);
  assert.ok(byAge[0].R > hubs[0].R + hubs[0].r && byAge.at(-1).R > byAge[0].R);
  assert.equal(hubs[0].newest, byAge[0].t.mtime);
  // Each item's mark says its group; a decision record is a diamond whatever its group.
  const shapes = new Set(ray.map(i => i.shape));
  for (const s of ['circle', 'square', 'ring', 'triangle', 'diamond']) assert.ok(shapes.has(s), s);
  assert.ok(ray.filter(i => i.shape === 'diamond').every(i => i.t.status));
});

test('a rim item sits at the circular mean angle of the projects it orbits, across 0° too, and moves no hub', () => {
  const cats = () => ({ tools: Array.from({ length: 12 }, (_, i) => project('tools', `acme-p${String(i).padStart(2, '0')}`, 4)) });
  const bare = radialLayout(tree(cats()));
  // The hubs either side of 0°: the one with the largest angle and the one with the smallest.
  const hi = bare.hubs.reduce((a, h) => (h.ang > a.ang ? h : a)), lo = bare.hubs.reduce((a, h) => (h.ang < a.ang ? h : a));
  assert.ok(hi.ang > 1.5 * Math.PI && lo.ang < Math.PI / 2, 'the fixture has hubs either side of 0°');
  const c = cats(), byName = name => c.tools.find(p => p.name === name);
  orbit('straddle', [byName(hi.t.name), byName(lo.t.name)]);
  const three = bare.hubs.filter(h => h.ang > 2 && h.ang < 4).slice(0, 3);
  orbit('three', three.map(h => byName(h.t.name)));
  const lay = radialLayout(tree(c));
  assert.deepEqual(lay.hubs.map(h => [h.x, h.y]), bare.hubs.map(h => [h.x, h.y]));
  const at = name => lay.rim.find(r => r.t.name === `ACME-${name}.md`);
  assert.equal(lay.rim.length, 2); // one per file, not one per belt it's in
  const m = circularMean([hi.ang, lo.ang]);
  assert.ok(angDist(m, 0) < 0.3, `the mean of ${hi.ang} and ${lo.ang} is near 0°, not ${m}`);
  near(angDist(at('straddle').ang, m), 0);
  assert.ok(angDist(at('straddle').ang, Math.PI) > 2.5); // not the arithmetic mean, which would point the other way
  near(angDist(at('three').ang, circularMean(three.map(h => h.ang))), 0);
  assert.deepEqual(at('straddle').hubs.map(i => lay.hubs[i].t.name).sort(), [hi.t.name, lo.t.name].sort());
  assert.ok(lay.rim.every(r => r.R >= lay.rings.rim));
  // Projects whose unit vectors cancel out have no mean.
  assert.equal(circularMean([0, Math.PI]), null);
  assert.equal(circularMean([]), null);
});

test('what orbits nothing fills the uncharted arc, and nothing that orbits a project lands in it', () => {
  const ps = [project('tools', 'acme-a', 6), project('tools', 'acme-b', 2), project('work', 'acme-c', 5), project('work', 'acme-d', 1)];
  const bare = radialLayout(tree({ tools: ps.slice(0, 2), work: ps.slice(2) }, [stray('s0')]));
  // The hubs nearest the slot on each side: their mean falls in it, so that item goes to the slot's edge instead.
  const rel = a => ((a - bare.uncharted.a1) % TAU + TAU) % TAU;
  const sorted = [...bare.hubs].sort((a, b) => rel(a.ang) - rel(b.ang));
  const first = ps.find(p => p.id === sorted[0].id), last = ps.find(p => p.id === sorted.at(-1).id);
  orbit('edge', [first, last]);
  orbit('one', [ps[2]]);
  const lost = Array.from({ length: 7 }, (_, i) => stray(`lost-${i}`));
  const lay = radialLayout(tree({ tools: ps.slice(0, 2), work: ps.slice(2) }, lost));
  const { a0, a1 } = lay.uncharted, inSlot = a => { const x = ((a - a0) % TAU + TAU) % TAU; return x <= a1 - a0 + 1e-9; };
  const un = lay.rim.filter(r => r.uncharted), on = lay.rim.filter(r => !r.uncharted);
  assert.equal(lay.uncharted.n, 7);
  assert.deepEqual(un.map(r => r.t.name).sort(), lost.map(s => s.name).sort());
  for (const r of un) assert.ok(inSlot(r.ang), `${r.t.name} at ${r.ang} is outside [${a0}, ${a1}]`);
  assert.equal(on.length, 2);
  for (const r of on) assert.ok(!inSlot(r.ang), `${r.t.name} at ${r.ang} is in the uncharted arc`);
  assert.ok(inSlot(circularMean([sorted[0].ang, sorted.at(-1).ang])), 'the fixture puts that mean in the slot');
  for (const h of lay.hubs) assert.ok(!inSlot(h.ang), `hub ${h.t.name} is in the uncharted arc`);
});

test('the same tree always gives the same positions, and the tree is left as it was', () => {
  const ps = [project('tools', 'acme-a', 30), project('tools', 'acme-b', 7), project('work', 'acme-c', 12), project('work', 'acme-d', 0)];
  orbit('one', [ps[0], ps[2]]); orbit('two', [ps[1]]); orbit('three', [ps[0], ps[1], ps[3]]);
  const t = tree({ tools: ps.slice(0, 2), work: ps.slice(2) }, [stray('a'), stray('b')]);
  const before = JSON.stringify(t);
  const a = radialLayout(structuredClone(t)), b = radialLayout(structuredClone(t)), c = radialLayout(t);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(JSON.stringify(t), before);
  for (const list of [a.hubs, a.items, a.rim]) for (const n of list) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), n.id);
});

test('the rim clears the longest ray, and the frame clears the rim', () => {
  const big = project('tools', 'acme-big', 400);
  orbit('b', [big]);
  const lay = radialLayout(tree({ tools: [big, project('tools', 'acme-small', 2)] }, [stray('x')]));
  const longest = Math.max(...lay.hubs.map(h => h.rayEnd));
  assert.ok(longest > GEOM.RIM, 'the fixture has a ray past the least rim');
  assert.ok(lay.rings.rim >= longest + GEOM.RIM_GAP);
  assert.ok(lay.items.every(i => i.R < lay.rings.rim));
  assert.ok(lay.rim.every(r => r.R >= lay.rings.rim && r.R < lay.rings.frame));
  assert.ok(lay.extent > lay.rings.frame);
});

test('neighbouring hubs keep CLEAR apart, even in a crowded sector, the first ring growing to make room', () => {
  const sizes = [400, 120, 91, 89, 75, 60, 3, 2, 1, 0, 40, 8, 13, 27, 5, 0, 1, 2, 19, 33];
  const crowd = Array.from({ length: 60 }, (_, i) => project('tools', `acme-c${String(i).padStart(2, '0')}`, sizes[i % sizes.length]));
  const { hubs, rings } = radialLayout(tree({ tools: crowd, work: [project('work', 'acme-w', 300)] }));
  for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) {
    const a = hubs[i], b = hubs[j];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r >= GEOM.CLEAR - 1e-9, `${a.t.name} crowds ${b.t.name}`);
  }
  assert.ok(hubs.some(h => h.tier > 0), 'the fixture is crowded enough to step some hubs out');
  assert.ok(rings.hub > GEOM.HUB, 'and to push the first ring out');
  // A roomy tree keeps the least first ring.
  assert.equal(radialLayout(tree({ tools: [project('tools', 'acme-a', 5)], work: [project('work', 'acme-b', 5)] })).rings.hub, GEOM.HUB);
});

test('sectorBounds: the box holds a sector and its hubs and documents, and the wedge out to the rim', () => {
  const ps = [project('tools', 'acme-a', 60), project('tools', 'acme-b', 9), project('work', 'acme-c', 40), project('misc', 'acme-d', 25),
    project('misc', 'acme-e', 3), project('more', 'acme-f', 12)];
  orbit('o', [ps[0]]);
  const lay = radialLayout(tree({ tools: ps.slice(0, 2), work: [ps[2]], misc: ps.slice(3, 5), more: [ps[5]] }, [stray('z')]));
  for (const s of lay.sectors) {
    const b = sectorBounds(lay, s.index), inB = (p, eps = 1e-9) => p.x >= b.x0 - eps && p.x <= b.x1 + eps && p.y >= b.y0 - eps && p.y <= b.y1 + eps;
    assert.ok(inB(s), `${s.name}: its own hub`);
    for (const h of s.hubs) { assert.ok(inB(lay.hubs[h]), `${s.name}: a hub`); for (const k of lay.hubs[h].items) assert.ok(inB(lay.items[k]), `${s.name}: a document`); }
    // The wedge's outer arc, sampled.
    const outer = lay.rings.frame - GEOM.FRAME_GAP;
    for (let u = 0; u <= 1; u += 0.05) { const a = s.a0 + (s.a1 - s.a0) * u; assert.ok(inB({ x: Math.cos(a) * outer, y: Math.sin(a) * outer }, 1e-6), `${s.name}: the rim at ${u}`); }
    // And no bigger than the wedge needs: each side touches it.
    const pts = []; for (let u = 0; u <= 1; u += 0.001) { const a = s.a0 + (s.a1 - s.a0) * u; for (const r of [lay.rings.sector, outer]) pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
    near(b.x0, Math.min(...pts.map(p => p[0])), 0.5); near(b.x1, Math.max(...pts.map(p => p[0])), 0.5);
    near(b.y0, Math.min(...pts.map(p => p[1])), 0.5); near(b.y1, Math.max(...pts.map(p => p[1])), 0.5);
  }
});

test('placeLabels: no two placed labels overlap, none leaves the view, and the higher priority wins a spot', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const aligns = ['left', 'right', 'center'], bases = ['top', 'bottom', 'middle'];
  const reqs = Array.from({ length: 400 }, (_, i) => ({ id: i, pri: Math.floor(rnd() * 5), w: 20 + rnd() * 90, h: 13,
    anchors: Array.from({ length: 1 + (i % 4) }, () => ({ x: rnd() * 800, y: rnd() * 600, align: aligns[i % 3], base: bases[(i >> 2) % 3] })) }));
  const taken = [{ x0: 300, y0: 200, x1: 500, y1: 260 }];
  const out = placeLabels(reqs, { width: 800, height: 600, taken });
  assert.ok(out.length > 40 && out.length < reqs.length);
  for (const [i, p] of out.entries()) {
    assert.ok(p.box.x0 >= 0 && p.box.y0 >= 0 && p.box.x1 <= 800 && p.box.y1 <= 600, `label ${p.id} leaves the view`);
    for (const q of [...taken.map(b => ({ box: b, id: 'taken' })), ...out.slice(0, i)])
      assert.ok(!(p.box.x0 < q.box.x1 && p.box.x1 > q.box.x0 && p.box.y0 < q.box.y1 && p.box.y1 > q.box.y0), `${p.id} overlaps ${q.id}`);
  }
  const spot = { x: 100, y: 100, align: 'left', base: 'middle' };
  const won = placeLabels([{ id: 'low', pri: 5, w: 50, h: 12, anchors: [spot] }, { id: 'high', pri: 1, w: 50, h: 12, anchors: [spot, { ...spot, y: 140 }] }],
    { width: 800, height: 600 });
  assert.deepEqual(won.map(p => [p.id, p.y]), [['high', 94]]);
});

test('placeLabels: a label may touch its own mark but no other, and falls back to its shorter alts in turn', () => {
  const mark = (own, x, y) => ({ x0: x - 5, y0: y - 5, x1: x + 5, y1: y + 5, own });
  const taken = [mark('a', 100, 100), mark('b', 160, 100)];
  const at = (x, y) => [{ x, y, align: 'left', base: 'middle' }];
  // Over its own mark: placed. Over another's, or one with no owner: not.
  assert.equal(placeLabels([{ id: 1, pri: 1, w: 20, h: 12, own: 'a', anchors: at(96, 100) }], { width: 400, height: 400, taken }).length, 1);
  assert.equal(placeLabels([{ id: 2, pri: 1, w: 20, h: 12, own: 'a', anchors: at(150, 100) }], { width: 400, height: 400, taken }).length, 0);
  assert.equal(placeLabels([{ id: 3, pri: 1, w: 20, h: 12, anchors: at(96, 100) }], { width: 400, height: 400, taken }).length, 0);
  // Too long to fit between the marks: the first alt that fits, on the first anchor where it fits, with its fields.
  const req = { id: 4, pri: 1, w: 80, h: 12, own: 'a', text: 'long', anchors: at(108, 100), alts: [{ w: 60, text: 'mid' }, { w: 30, text: 'short' }, { w: 10, text: 'tiny' }] };
  const [p] = placeLabels([req], { width: 400, height: 400, taken });
  assert.deepEqual([p.text, p.w, p.x], ['short', 30, 108]);
  // Placed labels block alts too, and the same input places the same way every time.
  const two = [req, { ...req, id: 5, pri: 2 }];
  assert.deepEqual(placeLabels(two, { width: 400, height: 400, taken }).map(q => q.id), [4]);
  assert.deepEqual(placeLabels(two, { width: 400, height: 400, taken }), placeLabels(two, { width: 400, height: 400, taken }));
});
