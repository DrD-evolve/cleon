import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlacement, clampRect, clampRects, dragRect, resizeRect, readFloatState, writeFloatState, narrowScreen, FLOAT_V, WIN } from '../public/window-layout.mjs';

const W = 1440, H = 900;
const inside = (r, w = W, h = H) => r.x >= 0 && r.y >= WIN.TOP && r.x + r.w <= w && r.y + r.h <= h;
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test('Dev: sessions and herdr in a left column, side on the right, flows along the bottom', () => {
  const p = defaultPlacement('dev', ['sessions', 'herdr', 'side', 'flows'], W, H);
  assert.deepEqual(Object.keys(p).sort(), ['flows', 'herdr', 'sessions', 'side']);
  assert.ok(p.sessions.x < 20 && p.herdr.x === p.sessions.x && p.herdr.y > p.sessions.y);
  assert.ok(p.side.x + p.side.w <= W && p.side.x > W / 2);
  assert.ok(p.flows.y > p.sessions.y && p.flows.y + p.flows.h <= H);
  for (const r of Object.values(p)) assert.ok(inside(r), JSON.stringify(r));
});

test('the centre of the map stays clear of the placed windows', () => {
  for (const [view, ids] of [['dev', ['sessions', 'herdr', 'side', 'flows']], ['groom', ['groom', 'waiting', 'side']], ['exec', ['exec', 'usage', 'process']]]) {
    const p = defaultPlacement(view, ids, W, H), centre = { x: W * 0.4, y: H * 0.3, w: W * 0.2, h: H * 0.3 };
    for (const [id, r] of Object.entries(p)) assert.ok(!overlap(r, centre), `${view}/${id}`);
  }
});

test('windows of one column do not overlap each other', () => {
  for (const [view, ids] of [['dev', ['sessions', 'herdr', 'side', 'flows']], ['groom', ['groom', 'waiting', 'side']], ['exec', ['exec', 'usage', 'process']]]) {
    const rs = Object.values(defaultPlacement(view, ids, W, H));
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) assert.ok(!overlap(rs[i], rs[j]), view);
  }
});

test('only the ids asked for are placed; panels the table does not know cascade, staying on screen', () => {
  const p = defaultPlacement('dev', ['sessions', 'acme-a', 'acme-b'], W, H);
  assert.deepEqual(Object.keys(p).sort(), ['acme-a', 'acme-b', 'sessions']);
  assert.notDeepEqual([p['acme-a'].x, p['acme-a'].y], [p['acme-b'].x, p['acme-b'].y]);
  for (const r of Object.values(p)) assert.ok(inside(r));
  // They cascade beside the columns, not over a window the view already placed.
  const q = defaultPlacement('dev', ['sessions', 'herdr', 'side', 'acme-a', 'acme-b'], W, H);
  for (const id of ['acme-a', 'acme-b']) for (const placed of ['sessions', 'herdr', 'side']) assert.ok(!overlap(q[id], q[placed]), `${id}/${placed}`);
});

test('a small screen shrinks the windows but keeps them on screen', () => {
  const p = defaultPlacement('dev', ['sessions', 'herdr', 'side', 'flows', 'acme-a'], 900, 600);
  for (const r of Object.values(p)) { assert.ok(inside(r, 900, 600), JSON.stringify(r)); assert.ok(r.w >= WIN.MIN_W && r.h >= WIN.MIN_H); }
});

test('clampRect leaves a window that is on screen as it is', () => {
  const r = { x: 100, y: 100, w: 300, h: 200 };
  assert.deepEqual(clampRect(r, W, H), r);
});

test('clampRect keeps at least 80 px of the window on screen on every side, and its title bar below the header', () => {
  const r = { x: 0, y: 0, w: 300, h: 200 };
  assert.equal(clampRect({ ...r, x: -1000 }, W, H).x, WIN.KEEP - r.w);
  assert.equal(clampRect({ ...r, x: 5000 }, W, H).x, W - WIN.KEEP);
  assert.equal(clampRect({ ...r, y: -50 }, W, H).y, WIN.TOP);
  assert.equal(clampRect({ ...r, y: 5000 }, W, H).y, H - WIN.BAR);
});

test('dragRect moves by the delta from where the drag began and stops with 80 px showing', () => {
  const o = { x: 100, y: 100, w: 300, h: 200 };
  assert.deepEqual(dragRect(o, 50, -20, W, H), { ...o, x: 150, y: 80 });
  assert.equal(dragRect(o, -9999, 0, W, H).x + o.w, WIN.KEEP);
  assert.equal(dragRect(o, 9999, 0, W, H).x, W - WIN.KEEP);
});

test('resizeRect grows from the bottom-right corner, never below the minimum or past the screen edge', () => {
  const o = { x: 100, y: 100, w: 300, h: 200 };
  assert.deepEqual(resizeRect(o, 40, 30, W, H), { ...o, w: 340, h: 230 });
  const s = resizeRect(o, -9999, -9999, W, H);
  assert.deepEqual([s.w, s.h], [WIN.MIN_W, WIN.MIN_H]);
  const b = resizeRect(o, 9999, 9999, W, H);
  assert.equal(b.x + b.w, W); assert.equal(b.y + b.h, H);
});

test('after the screen shrinks, clampRects brings every window back into view and leaves the others', () => {
  const wins = { a: { x: 1100, y: 700, w: 300, h: 200 }, b: { x: 20, y: 80, w: 300, h: 200 } };
  const out = clampRects(wins, 800, 500);
  assert.deepEqual(out.b, wins.b);
  assert.equal(out.a.x, 800 - WIN.KEEP);
  assert.equal(out.a.y, 500 - WIN.BAR);
  assert.deepEqual(wins.a, { x: 1100, y: 700, w: 300, h: 200 }); // the input is not changed
});

// ---- saved window state (mc.float.<view>) ----
const IDS = ['sessions', 'herdr', 'side', 'flows'];
const win = (id, o = {}) => ({ id, x: 20, y: 20, w: 300, h: 200, min: false, ...o });
const raw = (wins, v = FLOAT_V) => JSON.stringify({ v, wins });
const visible = (r, w = W, h = H) => r.x + r.w >= WIN.KEEP && r.x <= w - WIN.KEEP && r.y >= WIN.TOP && r.y <= h - WIN.BAR;

test('a saved state reads back as written, in stacking order', () => {
  const saved = [win('flows', { x: 40 }), win('sessions', { min: true }), win('side')];
  const got = readFloatState(writeFloatState(saved), IDS, W, H);
  assert.deepEqual(got, saved);
});
test('missing, empty and corrupt values are ignored, never thrown', () => {
  for (const bad of [null, undefined, '', 'not json', '{', '[]', '"x"', '42', 'null', '{"v":1}', '{"v":1,"wins":{}}', '{"v":1,"wins":"x"}'])
    assert.equal(readFloatState(bad, IDS, W, H), null, String(bad));
});
test('an older, newer or unversioned value is ignored', () => {
  for (const v of [0, 2, '1', null]) assert.equal(readFloatState(raw([win('side')], v), IDS, W, H), null, String(v));
  assert.equal(readFloatState(JSON.stringify({ wins: [win('side')] }), IDS, W, H), null);
});
test('an entry with a missing or non-numeric field voids the whole value', () => {
  for (const k of ['x', 'y', 'w', 'h']) {
    const e = win('side'); delete e[k];
    assert.equal(readFloatState(raw([win('flows'), e]), IDS, W, H), null, k);
    assert.equal(readFloatState(raw([win('flows'), win('side', { [k]: 'ten' })]), IDS, W, H), null, `${k} string`);
    assert.equal(readFloatState(raw([win('flows'), win('side', { [k]: null })]), IDS, W, H), null, `${k} null`);
  }
  assert.equal(readFloatState(raw([win('side'), null]), IDS, W, H), null);
  assert.equal(readFloatState(raw([win('side'), win(7)]), IDS, W, H), null);
});
test('unknown panel ids and the map itself are dropped, the rest kept', () => {
  const got = readFloatState(raw([win('gone'), win('side'), win('knowledge'), win('flows')]), [...IDS, 'knowledge'], W, H); // the map is a real panel id
  assert.deepEqual(got.map(w => w.id), ['side', 'flows']);
});
test('a value whose entries are all unknown falls back to the default; a real empty list stays empty', () => {
  assert.equal(readFloatState(raw([win('gone'), win('knowledge')]), IDS, W, H), null);
  assert.deepEqual(readFloatState(raw([]), IDS, W, H), []);
});
test('a duplicated id keeps its last entry, in that entry\'s place', () => {
  const got = readFloatState(raw([win('side', { x: 1 }), win('flows'), win('side', { x: 99 })]), IDS, W, H);
  assert.deepEqual(got.map(w => [w.id, w.x]), [['flows', 20], ['side', 99]]);
});
test('minimized is a boolean: anything but true reads as not minimized', () => {
  const got = readFloatState(raw([win('side', { min: 'yes' }), win('flows', { min: true })]), IDS, W, H);
  assert.deepEqual(got.map(w => w.min), [false, true]);
});
test('a window saved on a bigger screen comes back in view on a smaller one', () => {
  const saved = [win('side', { x: 2300, y: 1300 }), win('flows', { x: -900, y: -50 }), win('sessions', { x: 1800, y: 40, w: 600, h: 1500 })];
  const got = readFloatState(raw(saved), IDS, 1280, 720);
  assert.equal(got.length, 3);
  for (const r of got) assert.ok(visible(r, 1280, 720), JSON.stringify(r));
  for (const r of got) assert.ok(r.h <= Math.max(WIN.MIN_H, 720 - r.y), `bottom on the board: ${JSON.stringify(r)}`);
  assert.ok(got[2].h <= 720 && got[2].w <= 1280);
});
test('a tiny or negative size is raised to the minimum', () => {
  const [r] = readFloatState(raw([win('side', { w: 5, h: -3 })]), IDS, W, H);
  assert.ok(r.w >= WIN.MIN_W && r.h >= WIN.MIN_H);
});
test('writeFloatState keeps whole numbers and only the known fields', () => {
  const v = JSON.parse(writeFloatState([{ id: 'side', x: 10.6, y: 3.2, w: 300.4, h: 200.5, min: 1, extra: 'x' }]));
  assert.deepEqual(v, { v: FLOAT_V, wins: [{ id: 'side', x: 11, y: 3, w: 300, h: 201, min: true }] });
});
test('the narrow-screen fallback starts below 800 px', () => {
  assert.equal(narrowScreen(799), true);
  assert.equal(narrowScreen(800), false);
  assert.equal(narrowScreen(1440), false);
});
