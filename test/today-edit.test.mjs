import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putItem, clearBox, addBox, moveBox, removeBox } from '../lib/today-edit.mjs';
import { unplaced } from '../public/today-layout.mjs';
import { atMinute, MAX_BOXES } from '../lib/today-plan.mjs';

const plan = () => ({
  v: 1, day: '2026-03-04',
  items: [{ id: 'linear:ACME-1', source: 'linear', kind: 'due', title: 'One' }, { id: 'linear:ACME-2', source: 'linear', kind: 'ready', title: 'Two' }],
  opportunities: [{ id: 'rule:x:1', source: 'rule:x', title: 'Opp' }],
  boxes: [{ id: 'b1', kind: 'work', itemId: 'linear:ACME-1', start: 1, end: 2, source: 'linear', why: 'due' },
    { id: 'b2', kind: 'opportunity', itemId: null, start: 3, end: 4, source: 'cleared', why: '' }],
});

test('put fills an empty box from the plan\'s own item, and marks the plan edited', () => {
  const r = putItem(plan(), 'b2', 'linear:ACME-2');
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.boxes[1], { id: 'b2', kind: 'work', itemId: 'linear:ACME-2', start: 3, end: 4, source: 'linear', why: 'Put here by you.', by: 'you' });
  assert.equal(r.plan.edited, true);
});

test('put into a full box swaps: the old item is simply no longer in a box', () => {
  const r = putItem(plan(), 'b1', 'rule:x:1');
  assert.deepEqual([r.plan.boxes[0].kind, r.plan.boxes[0].itemId, r.plan.boxes[0].source], ['opportunity', 'rule:x:1', 'rule:x']);
});

test('the input plan is not changed', () => {
  const p = plan();
  putItem(p, 'b2', 'linear:ACME-2');
  clearBox(p, 'b1');
  assert.deepEqual(p, plan());
});

test('an unknown box or item is refused, and so is anything that is not a string id', () => {
  for (const [b, i] of [['nope', 'linear:ACME-2'], ['b2', 'linear:NOPE'], [{ $ne: 1 }, 'linear:ACME-2'], ['b2', ['linear:ACME-2']], [undefined, undefined]]) {
    const r = putItem(plan(), b, i);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  }
});

test('an item already in another box is refused', () => {
  const r = putItem(plan(), 'b2', 'linear:ACME-1');
  assert.deepEqual([r.ok, r.status], [false, 409]);
});

test('no plan: refused', () => {
  assert.equal(putItem(null, 'b1', 'x').status, 409);
  assert.equal(clearBox(null, 'b1').status, 409);
});

test('clear empties the box, keeps its time, and marks the plan edited', () => {
  const r = clearBox(plan(), 'b1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.boxes[0], { id: 'b1', kind: 'work', itemId: null, start: 1, end: 2, source: 'cleared', why: 'Cleared by you.', by: 'you' });
  assert.equal(r.plan.edited, true);
  assert.equal(clearBox(plan(), 'zzz').status, 404);
});

test("yesterday's plan is not edited: with today's date given, a stale plan is refused", () => {
  assert.deepEqual([putItem(plan(), 'b2', 'linear:ACME-2', '2026-03-05').status, clearBox(plan(), 'b1', '2026-03-05').status], [409, 409]);
  assert.equal(putItem(plan(), 'b2', 'linear:ACME-2', '2026-03-04').ok, true);
  assert.equal(clearBox(plan(), 'b1', '2026-03-04').ok, true);
});

// The edits that take minutes: the day is 2026-03-04, hours 08:00-17:00, and it is 09:00 unless a test says otherwise.
const DAY = '2026-03-04', H = h => h * 60, at = min => atMinute(DAY, min);
const ctx = (over = {}) => ({ day: DAY, now: at(H(9)), hours: { start: H(8), end: H(17) }, ...over });
const timed = () => ({
  ...plan(), meetings: [{ subject: 'Standup', start: at(H(10)), end: at(H(11)), tentative: false }, { subject: 'Maybe', start: at(H(14)), end: at(H(15)), tentative: true }],
  boxes: [{ id: 'b1', kind: 'work', itemId: 'linear:ACME-1', start: at(H(12)), end: at(H(13)), source: 'linear', why: 'due' },
    { id: 'b2', kind: 'opportunity', itemId: null, start: at(H(15)), end: at(H(16)), source: 'cleared', why: '' }],
});
const refused = (r, status, re) => { assert.equal(r.ok, false); assert.equal(r.status, status, r.reason); if (re) assert.match(r.reason, re); };

test('add: a box with a title is the owner\'s own, with the next id, sorted by start, and the plan is edited', () => {
  const r = addBox(timed(), { start: H(9), end: H(9) + 30, title: 'Dentist' }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.boxes[0], { id: 'b3', kind: 'task', itemId: null, title: 'Dentist', start: at(H(9)), end: at(H(9) + 30), source: 'you', why: 'Added by you.', by: 'you' });
  assert.equal(r.plan.edited, true);
  assert.equal(r.plan.nextBox, 4);
});

test('add with an item references the plan\'s own item or opportunity, like put', () => {
  const w = addBox(timed(), { start: H(9), end: H(10), item: 'linear:ACME-2' }, ctx());
  assert.deepEqual(w.plan.boxes[0], { id: 'b3', kind: 'work', itemId: 'linear:ACME-2', start: at(H(9)), end: at(H(10)), source: 'linear', why: 'Put here by you.', by: 'you' });
  const o = addBox(timed(), { start: H(9), end: H(10), item: 'rule:x:1' }, ctx());
  assert.deepEqual([o.plan.boxes[0].kind, o.plan.boxes[0].source], ['opportunity', 'rule:x']);
  refused(addBox(timed(), { start: H(9), end: H(10), item: 'linear:ACME-1' }, ctx()), 409, /already in another box/);
  refused(addBox(timed(), { start: H(9), end: H(10), item: 'linear:NOPE' }, ctx()), 404);
});

test('add with no title, or one that is empty once cleaned, makes an empty box with no title key', () => {
  for (const title of [undefined, '', '   ', '<b></b>', '\u0007‮']) {
    const r = addBox(timed(), { start: H(9), end: H(10), title }, ctx());
    assert.deepEqual(r.plan.boxes[0], { id: 'b3', kind: 'work', itemId: null, start: at(H(9)), end: at(H(10)), source: 'you', why: 'Added by you.', by: 'you' });
    assert.ok(!('title' in r.plan.boxes[0]));
  }
});

test('a title is saved as plain text: tags, control and bidi characters gone, at most 120 characters', () => {
  const evil = '<img src=x onerror=alert(1)>Review\u0007\u0000 ‮plan‬⁦x⁩‎‏؜' + 'y'.repeat(300);
  const t = addBox(timed(), { start: H(9), end: H(10), title: evil }, ctx()).plan.boxes[0].title;
  assert.ok(t.length <= 120);
  assert.match(t, /^Review plan/);
  assert.doesNotMatch(t, /[<>\u0000-\u001f؜​-‏‪-‮⁦-⁩]/);
  assert.equal(addBox(timed(), { start: H(9), end: H(10), title: '<img src=x onerror=alert(1)>' }, ctx()).plan.boxes[0].kind, 'work', 'a title that is only markup is empty');
});

test('add refusals: stale day, no plan, overlap, hours, length, past, too many boxes', () => {
  const add = (start, end, over, p = timed()) => addBox(p, { start, end }, ctx(over));
  refused(addBox(null, { start: H(9), end: H(10) }, ctx()), 409, /no plan/);
  refused(add(H(9), H(10), { day: '2026-03-05' }), 409, /not today/);
  refused(add(H(9), H(10) + 30), 409, /overlaps a meeting/);
  refused(add(H(14), H(14) + 30), 409, /overlaps a meeting/);
  refused(add(H(11) + 30, H(12) + 30), 409, /overlaps another box/);
  refused(add(H(7), H(8) + 30), 409, /hours/);
  refused(add(H(16) + 30, H(17) + 30), 409, /hours/);
  refused(add(H(9), H(9) + 10), 409, /at least 15/);
  refused(add(H(8), H(8) + 241), 409, /at most 240/);
  refused(add(H(8), H(9), { now: at(H(9)) }), 409, /passed/);
  const many = timed();
  many.boxes = Array.from({ length: MAX_BOXES }, (_, i) => ({ id: `b${i + 1}`, kind: 'work', itemId: null, start: at(H(8)) + i, end: at(H(8)) + i + 1, source: 'x', why: '' }));
  many.meetings = [];
  refused(addBox(many, { start: H(11), end: H(12) }, ctx({ now: 0 })), 409, /at most 40/);
});

test('touching a meeting or a box is not an overlap, and a box may start before now if it ends after', () => {
  assert.equal(addBox(timed(), { start: H(11), end: H(12) }, ctx()).ok, true, 'between the meeting and the box');
  assert.equal(addBox(timed(), { start: H(9), end: H(10) }, ctx()).ok, true);
  assert.equal(addBox(timed(), { start: H(8), end: H(9) + 15 }, ctx()).ok, true, 'started before now, ends after');
});

test('bad types and values are 400: ids, minutes and titles', () => {
  const add = o => addBox(timed(), { start: H(9), end: H(10), ...o }, ctx());
  for (const o of [{ start: '540' }, { end: '600' }, { start: 540.5 }, { end: NaN }, { start: Infinity }, { start: null }, { start: undefined }, { start: H(10), end: H(9) }, { start: H(9), end: H(9) },
    { title: ['x'] }, { title: { a: 1 } }, { title: 5 }, { item: ['linear:ACME-2'] }]) refused(add(o), 400);
  refused(moveBox(timed(), { $ne: 1 }, H(9), H(10), ctx()), 400);
  refused(moveBox(timed(), 'b1', '540', H(10), ctx()), 400);
  refused(moveBox(timed(), 'b1', H(9), 600.5, ctx()), 400);
  refused(moveBox(timed(), 'b1', H(9), NaN, ctx()), 400);
  refused(removeBox(timed(), ['b1'], DAY), 400);
});

test('move and resize are one call: the box keeps everything but its time, and ignores itself when it overlaps', () => {
  const m = moveBox(timed(), 'b1', H(12) + 15, H(13) + 15, ctx());
  assert.equal(m.ok, true);
  assert.deepEqual(m.plan.boxes[0], { id: 'b1', kind: 'work', itemId: 'linear:ACME-1', start: at(H(12) + 15), end: at(H(13) + 15), source: 'linear', why: 'due', by: 'you' });
  assert.equal(m.plan.edited, true);
  assert.equal(moveBox(timed(), 'b1', H(12), H(12) + 45, ctx()).ok, true, 'resize shorter, within its own span');
  const first = moveBox(timed(), 'b2', H(8) + 30, H(9) + 30, ctx());
  assert.deepEqual(first.plan.boxes.map(b => b.id), ['b2', 'b1'], 'sorted by start');
});

test('move refusals: unknown box 404, overlap, meeting, hours, length, past, stale, no plan', () => {
  const mv = (id, a, b, over) => moveBox(timed(), id, a, b, ctx(over));
  refused(mv('zzz', H(9), H(10)), 404);
  refused(mv('b1', H(9), H(10) + 30), 409, /overlaps a meeting/);
  refused(mv('b1', H(14) + 30, H(15) + 30), 409, /overlaps/);
  refused(mv('b1', H(15), H(16)), 409, /overlaps another box/);
  refused(mv('b1', H(16) + 30, H(17) + 30), 409, /hours/);
  refused(mv('b1', H(12), H(12) + 10), 409, /at least 15/);
  refused(mv('b1', H(12), H(17)), 409);
  refused(mv('b1', H(8), H(8) + 30, { now: at(H(9)) }), 409, /passed/);
  refused(mv('b1', H(12), H(13), { day: '2026-03-05' }), 409, /not today/);
  refused(moveBox(null, 'b1', H(12), H(13), ctx()), 409);
});

test('remove deletes any box and its item returns to the rail; stale and unknown are refused', () => {
  const p = timed();
  assert.equal(unplaced(p).work.length, 1);
  const r = removeBox(p, 'b1', DAY);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.boxes.map(b => b.id), ['b2']);
  assert.equal(r.plan.edited, true);
  assert.equal(unplaced(r.plan).work.length, 2, 'the item is back in Didn\'t fit');
  assert.equal(removeBox(p, 'b2', DAY).ok, true, 'an empty box too');
  refused(removeBox(p, 'zzz', DAY), 404);
  refused(removeBox(p, 'b1', '2026-03-05'), 409);
  refused(removeBox(null, 'b1', DAY), 409);
});

test('the input plan is not changed by add, move or remove', () => {
  const p = timed();
  addBox(p, { start: H(9), end: H(10), title: 'x' }, ctx());
  moveBox(p, 'b1', H(12) + 15, H(13), ctx());
  removeBox(p, 'b1', DAY);
  assert.deepEqual(p, timed());
});

test('ids are never reused, after a removal or beside the planner\'s own numbering', () => {
  let p = timed();
  p = addBox(p, { start: H(9), end: H(10) }, ctx()).plan;          // b3
  p = removeBox(p, 'b3', DAY).plan;
  p = addBox(p, { start: H(9), end: H(10) }, ctx()).plan;          // b4, not b3 again
  assert.deepEqual(p.boxes.map(b => b.id).sort(), ['b1', 'b2', 'b4']);
  const odd = timed();
  odd.boxes[1].id = 'b7';
  const r = addBox(odd, { start: H(9), end: H(10) }, ctx());
  assert.equal(r.plan.boxes[0].id, 'b8', 'above the highest planner id');
  assert.equal(r.plan.nextBox, 9);
});

test('every edit marks the plan edited and the box by you', () => {
  const a = addBox(timed(), { start: H(9), end: H(10) }, ctx()).plan;
  assert.deepEqual([a.edited, a.boxes[0].by], [true, 'you']);
  const m = moveBox(timed(), 'b2', H(15) + 15, H(16), ctx()).plan;
  assert.deepEqual([m.edited, m.boxes.find(b => b.id === 'b2').by], [true, 'you']);
  assert.equal(removeBox(timed(), 'b2', DAY).plan.edited, true);
});

test('put into a custom box replaces its title with the item', () => {
  const p = addBox(timed(), { start: H(9), end: H(10), title: 'Dentist' }, ctx()).plan;
  const r = putItem(p, 'b3', 'linear:ACME-2', DAY);
  assert.equal(r.ok, true);
  const b = r.plan.boxes.find(x => x.id === 'b3');
  assert.ok(!('title' in b));
  assert.deepEqual([b.kind, b.itemId, b.source, b.why, b.by], ['work', 'linear:ACME-2', 'linear', 'Put here by you.', 'you']);
});
