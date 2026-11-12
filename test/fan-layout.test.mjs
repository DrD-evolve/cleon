import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fanLayout, fanRoom, fanSeq, fitName, FAN } from '../public/fan-layout.mjs';

// Documents in the side panel's order: four groups, each newest first. Every name is an ACME- one.
const GROUPS = ['docs', 'comms', 'outputs', 'memory'];
const DAY = 864e5, T0 = Date.UTC(2026, 8, 1);
function docs(count, { wide = false } = {}) {
  const per = GROUPS.map(() => []);
  for (let i = 0; i < count; i++) per[i % 4].push({ id: `ACME-${i}`, group: GROUPS[i % 4], mtime: T0 - ((i * 7919) % Math.max(count, 1)) * DAY, w: wide ? 150 : 40 + (i * 37) % 90 });
  return per.flatMap(g => g.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1)));
}
const overlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const boxesOf = r => [...r.nodes.filter(n => n.label).map(n => n.label), ...(r.moreBox ? [r.moreBox] : [])];

test('no documents: nothing to draw and no box to make room for', () => {
  const r = fanLayout([], { dir: 1 });
  assert.deepEqual(r, { nodes: [], more: 0, moreBox: null, box: null });
  assert.deepEqual(fanRoom(r.box, 100, 100, 800, 600), [0, 0]);
});

test('one document: a named node straight out along the direction, and no "+N more"', () => {
  for (const dir of [0, 1, Math.PI / 2, 3, -2]) {
    const r = fanLayout([{ id: 'ACME-0', mtime: T0, w: 80 }], { dir });
    assert.equal(r.nodes.length, 1);
    const [n] = r.nodes;
    assert.ok(n.named && n.label);
    assert.ok(Math.abs(Math.atan2(n.y, n.x) - Math.atan2(Math.sin(dir), Math.cos(dir))) < 1e-9);
    assert.ok(Math.abs(Math.hypot(n.x, n.y) - FAN.RADIUS) < 1e-9);
    assert.equal(r.more, 0);
    assert.equal(r.moreBox, null);
  }
});

test('the name limit holds, the newest are the ones named, and the rest are counted', () => {
  const items = docs(60);
  const r = fanLayout(items, { dir: 0.4 });
  assert.equal(r.nodes.filter(n => n.named).length, FAN.LIMIT);
  assert.equal(r.more, 60 - FAN.LIMIT);
  const newest = [...items].sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1)).slice(0, FAN.LIMIT).map(i => i.id).sort();
  assert.deepEqual(r.nodes.filter(n => n.named).map(n => n.id).sort(), newest);
  assert.ok(r.moreBox);
  assert.equal(fanLayout(items, { dir: 0, limit: 5 }).nodes.filter(n => n.named).length, 5);
  assert.equal(fanLayout(items, { dir: 0, limit: 0 }).nodes.filter(n => n.named).length, 0);
  // Fewer documents than the limit: all named, nothing more.
  const few = fanLayout(docs(7), { dir: 0 });
  assert.equal(few.nodes.filter(n => n.named).length, 7);
  assert.equal(few.more, 0);
  assert.equal(few.moreBox, null);
});

test('no two name boxes overlap, for every count and direction (and "+N more" is one of the boxes)', () => {
  for (const count of [0, 1, 2, 3, 5, 11, 12, 13, 30, 100, 200]) {
    for (const wide of [false, true]) for (let d = 0; d < 16; d++) {
      const dir = (d / 16) * 2 * Math.PI - Math.PI;
      const r = fanLayout(docs(count, { wide }), { dir });
      const boxes = boxesOf(r);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
        assert.ok(!overlap(boxes[i], boxes[j]), `count ${count}, dir ${dir.toFixed(2)}: boxes ${i} and ${j} overlap`);
      for (const b of boxes) assert.ok(b.x1 > b.x0 && b.y1 - b.y0 >= FAN.H - 1e-9);
    }
  }
});

test('a name sits on the outer side of its node: a node right of the axis names to its right, else to its left', () => {
  const r = fanLayout(docs(12), { dir: 0 });
  for (const n of r.nodes.filter(x => x.label)) {
    if (n.x >= 0) { assert.equal(n.label.align, 'left'); assert.ok(n.label.x0 > n.x); }
    else { assert.equal(n.label.align, 'right'); assert.ok(n.label.x1 < n.x); }
  }
});

test('the fan faces away: its centre of mass lies along the direction, and every node is on that side of the project', () => {
  for (const dir of [0, 0.7, 2.2, -1.4, Math.PI]) {
    const r = fanLayout(docs(40), { dir });
    const cx = r.nodes.reduce((s, n) => s + n.x, 0) / r.nodes.length, cy = r.nodes.reduce((s, n) => s + n.y, 0) / r.nodes.length;
    assert.ok(Math.cos(dir) * cx + Math.sin(dir) * cy > 0);
    for (const n of r.nodes) assert.ok(Math.cos(dir) * n.x + Math.sin(dir) * n.y > 0, `node ${n.id} behind the project`);
    assert.ok(Math.abs(Math.sin(dir) * cx - Math.cos(dir) * cy) < 25, 'the fan is not off to one side');
  }
});

test("groups stay together along the arc, in the side panel's order", () => {
  const items = docs(48);
  const r = fanLayout(items, { dir: 0 });
  // Along the arc (by angle), the dots' groups come in the order given and each group is one run.
  const group = new Map(items.map(i => [i.id, i.group]));
  const dots = r.nodes.filter(n => !n.named && !n.hidden);
  const ang = n => Math.atan2(n.y, n.x), seq = [...dots].sort((a, b) => ang(a) - ang(b) || Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y)).map(n => group.get(n.id));
  const runs = seq.filter((g, i) => g !== seq[i - 1]);
  assert.deepEqual(runs, [...new Set(runs)], 'a group split into two runs');
  assert.deepEqual(runs, GROUPS.filter(g => runs.includes(g)), 'groups out of order');
  // The named ones too.
  const named = r.nodes.filter(n => n.named).sort((a, b) => ang(a) - ang(b)).map(n => group.get(n.id));
  assert.deepEqual(named.filter((g, i) => g !== named[i - 1]), [...new Set(named)]);
});

test('past the dot cap the rest are counted but have no mark; nodes keep their input order and ids', () => {
  const items = docs(400);
  const r = fanLayout(items, { dir: 1 });
  assert.equal(r.nodes.length, 400);
  assert.deepEqual(r.nodes.map(n => n.id), items.map(i => i.id));
  assert.equal(r.more, 400 - FAN.LIMIT);
  assert.equal(r.nodes.filter(n => !n.named && !n.hidden).length, FAN.DOT_CAP);
  for (const n of r.nodes.filter(x => !x.named && !x.hidden)) assert.ok(Math.hypot(n.x, n.y) < FAN.RADIUS);
});

test('box holds every node and name, and the project', () => {
  const r = fanLayout(docs(30, { wide: true }), { dir: 2 });
  const { box } = r;
  assert.ok(box.x0 <= 0 && box.y0 <= 0 && box.x1 >= 0 && box.y1 >= 0);
  for (const n of r.nodes.filter(x => !x.hidden)) assert.ok(n.x >= box.x0 && n.x <= box.x1 && n.y >= box.y0 && n.y <= box.y1);
  for (const b of boxesOf(r)) assert.ok(b.x0 >= box.x0 && b.x1 <= box.x1 && b.y0 >= box.y0 && b.y1 <= box.y1);
});

// A width per character, so a cut can be checked by hand: 6 px a character, the ellipsis one character.
const measure = t => [...t].length * 6;
const textOf = ps => ps.map(p => p.t).join('');

test('a name that fits is drawn as given: "(excluded)" stays "(excluded)", with its marks', () => {
  const parts = [{ t: '(excluded) retro.md', c: 'a' }, { t: ' · draft', c: 'b' }];
  assert.equal(fitName(parts, measure, 170), parts);
  assert.equal(textOf(fitName([{ t: '(excluded)', c: 'a' }], measure, 170)), '(excluded)');
});

test('a long name is cut to fit with an ellipsis, its marks kept, and never past the limit', () => {
  const name = 'ACME-design-note-with-a-much-longer-name-than-the-fan-can-hold.md', status = ' · Accepted';
  const out = fitName([{ t: name, c: 'a' }, { t: status, c: 'b' }], measure, 170);
  assert.equal(out[1].t, status);
  assert.ok(out[0].t.endsWith('…') && name.startsWith(out[0].t.slice(0, -1)));
  assert.ok(out.reduce((a, p) => a + measure(p.t), 0) <= 170);
  // The most that fits: one more character would not.
  assert.ok(measure(`${[...name].slice(0, [...out[0].t].length).join('')}…`) + measure(status) > 170);
});

test('a long status cannot squeeze the name to nothing: the name keeps half, the status is cut or left out', () => {
  const status = ` · ${'superseded by the decision taken later'.repeat(2)}`;
  const out = fitName([{ t: 'ACME-adr-0042-storage-engine.md', c: 'a' }, { t: status, c: 'b' }, { t: ' · draft', c: 'c' }], measure, 170);
  assert.ok(measure(out[0].t) >= 170 / 2 - 6, `name kept: ${out[0].t}`);
  assert.ok(out.reduce((a, p) => a + measure(p.t), 0) <= 170, textOf(out));
  // Too little room for even one character of a mark: it is left out, never drawn past the limit.
  const tight = fitName([{ t: 'ACME-x'.repeat(10), c: 'a' }, { t: ' · Accepted', c: 'b' }], measure, 60);
  assert.ok(tight.reduce((a, p) => a + measure(p.t), 0) <= 60, textOf(tight));
});

test("the side panel's order: known groups in order, then others as first met, each group's documents as given", () => {
  const items = ['m1', 'd1', 'x1', 'c1', 'd2', 'm2', 'y1', 'x2'], group = { m: 'memory', d: 'docs', c: 'comms', x: 'extra', y: 'other' };
  assert.deepEqual(fanSeq(items, i => group[i[0]], ['docs', 'comms', 'outputs', 'memory']), ['d1', 'd2', 'c1', 'm1', 'm2', 'x1', 'x2', 'y1']);
  assert.deepEqual(fanSeq([], i => i, ['docs']), []);
});

test("no name lies across another named document's mark, for every count and direction", () => {
  for (const count of [3, 6, 9, 12, 20]) for (let d = 0; d < 64; d++) {
    const dir = (d / 64) * 2 * Math.PI - Math.PI, r = fanLayout(docs(count), { dir });
    const named = r.nodes.filter(n => n.named);
    for (const b of boxesOf(r)) for (const n of named) {
      if (n.label === b) continue;
      assert.ok(!(n.x + 4 > b.x0 && n.x - 4 < b.x1 && n.y + 4 > b.y0 && n.y - 4 < b.y1), `count ${count}, dir ${dir.toFixed(2)}: a name covers ${n.id}`);
    }
  }
});

test('zoomed in, the fan starts past the lifted hub: its dots from `inner` out, its names on a ring past them', () => {
  const r = fanLayout(docs(60), { dir: 0.5, inner: 96, radius: 176 });
  for (const n of r.nodes.filter(x => !x.hidden)) assert.ok(Math.hypot(n.x, n.y) >= 96 - 1e-9, n.id);
  for (const n of r.nodes.filter(x => x.named)) assert.ok(Math.abs(Math.hypot(n.x, n.y) - 176) < 1e-9);
});

test('deterministic, and the input is not changed', () => {
  const items = docs(37), copy = JSON.parse(JSON.stringify(items));
  assert.deepEqual(fanLayout(items, { dir: 0.3 }), fanLayout(items, { dir: 0.3 }));
  assert.deepEqual(items, copy);
});

test('room: the project stays put when the fan fits, and the pan brings it in when it does not', () => {
  const box = { x0: -10, y0: -80, x1: 200, y1: 90 };
  assert.deepEqual(fanRoom(box, 300, 300, 800, 600), [0, 0]);
  const [dx] = fanRoom(box, 700, 300, 800, 600);
  assert.ok(dx < 0 && 700 + dx + box.x1 <= 800 - 12 + 1e-9);
  const [, dy] = fanRoom(box, 300, 40, 800, 600);
  assert.ok(dy > 0 && 40 + dy + box.y0 >= 12 - 1e-9);
  // Too big for the canvas: centred, not pushed off one edge.
  const [cx] = fanRoom({ x0: -500, y0: 0, x1: 500, y1: 10 }, 400, 300, 800, 600);
  assert.equal(400 + cx, 400);
});
