import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLayout, focusNow, nextBoundary, splitNotices, seenAfter, unplaced, hiddenBy, hhmm, MIN_LEN, minuteAt, deltaMinutes } from '../public/today-layout.mjs';

const DAY = '2026-03-04';
const at = (h, m = 0) => new Date(2026, 2, 4, h, m).getTime();
const HOURS = { start: 8 * 60, end: 17 * 60 };
const item = (id, kind, title = id) => ({ id, source: kind === 'opportunity' ? 'rule:x' : 'linear', kind, title });
const plan = (over = {}) => ({
  v: 1, day: DAY, hours: { start: '08:00', end: '17:00' }, generatedAt: new Date(at(7, 30)).toISOString(),
  meetings: [], boxes: [], items: [item('linear:ACME-1', 'due'), item('linear:ACME-2', 'ready')], opportunities: [item('rule:x:1', 'opportunity')],
  dropped: [], ...over,
});
const box = (id, from, to, itemId, kind = 'work') => ({ id, kind, itemId, start: from, end: to, source: 'linear', why: 'because' });
const L = (p, o = {}) => dayLayout({ plan: p, hours: HOURS, axis: 'across', size: 900, now: at(11), ...o });

test('a plan lays out across: nine hours over 900 px is 100 px an hour, ticks on the hour', () => {
  const l = L(plan({ meetings: [{ subject: 'Standup', start: at(9), end: at(9, 30), tentative: false }] }));
  assert.equal(l.ticks.length, 10);
  assert.deepEqual(l.ticks.slice(0, 2).map(t => [t.hour, t.pos, t.label]), [[8, 0, true], [9, 100, true]]);
  const m = l.items[0];
  assert.deepEqual([m.tone, m.pos, m.len, m.lane, m.lanes, m.title], ['meeting', 100, 50, 0, 1, 'Standup']);
  assert.deepEqual(l.now, { at: at(11), pos: 300 });
  assert.equal(l.empty, false);
});

test('across and down give the same positions: only the pixel axis differs', () => {
  const p = plan({ boxes: [box('b1', at(10), at(11), 'linear:ACME-1')] });
  assert.deepEqual(L(p, { axis: 'across' }).items, L(p, { axis: 'down' }).items);
  assert.equal(L(p, { axis: 'down' }).axis, 'down');
});

test('a box takes its tone from its item: due, ready, opportunity; no item is empty', () => {
  const l = L(plan({ boxes: [box('b1', at(8), at(9), 'linear:ACME-1'), box('b2', at(9), at(10), 'linear:ACME-2'),
    box('b3', at(10), at(11), 'rule:x:1', 'opportunity'), box('b4', at(12), at(13), null)] }));
  assert.deepEqual(l.items.map(i => i.tone), ['due', 'ready', 'opportunity', 'empty']);
  assert.equal(l.items[0].title, 'linear:ACME-1');
  assert.equal(l.items[3].title, null);
});

test('overlapping meetings share the cross axis in lanes', () => {
  const l = L(plan({ meetings: [
    { subject: 'A', start: at(9), end: at(10), tentative: false },
    { subject: 'B', start: at(9, 30), end: at(10, 30), tentative: true },
    { subject: 'C', start: at(9, 45), end: at(10, 15), tentative: false },
    { subject: 'D', start: at(14), end: at(15), tentative: false }] }));
  const by = Object.fromEntries(l.items.map(i => [i.title, i]));
  assert.deepEqual([by.A.lane, by.B.lane, by.C.lane], [0, 1, 2]);
  assert.deepEqual([by.A.lanes, by.B.lanes, by.C.lanes], [3, 3, 3]);
  assert.deepEqual([by.D.lane, by.D.lanes], [0, 1], 'a later, separate meeting is not squeezed by the cluster');
  assert.equal(by.B.tentative, true);
});

test('a chain of overlaps is one cluster; a lane is reused once its block has ended', () => {
  const l = L(plan({ meetings: [
    { subject: 'A', start: at(9), end: at(10), tentative: false },
    { subject: 'B', start: at(9, 30), end: at(11), tentative: false },
    { subject: 'C', start: at(10), end: at(10, 30), tentative: false }] }));
  const by = Object.fromEntries(l.items.map(i => [i.title, i]));
  assert.deepEqual([by.A.lane, by.B.lane, by.C.lane], [0, 1, 0]);
  assert.deepEqual([by.A.lanes, by.B.lanes, by.C.lanes], [2, 2, 2]);
});

test('a box the model put on a meeting sits beside it, never hides it', () => {
  const l = L(plan({ meetings: [{ subject: 'Review', start: at(10), end: at(11), tentative: false }], boxes: [box('b1', at(10, 30), at(11, 30), 'linear:ACME-1')] }));
  assert.deepEqual(l.items.map(i => [i.tone, i.lane, i.lanes]), [['meeting', 0, 2], ['due', 1, 2]]);
});

test('a box past its end is late only while its work item is still open', () => {
  const p = plan({ boxes: [box('b1', at(9), at(10), 'linear:ACME-1'), box('b2', at(9), at(10), 'linear:ACME-2'), box('b3', at(10, 30), at(10, 45), 'rule:x:1', 'opportunity')] });
  const open = new Set(['linear:ACME-1']);
  const l = L(p, { now: at(10, 15), open });
  const b = Object.fromEntries(l.items.map(i => [i.boxId, i]));
  assert.equal(b.b1.late, 15 * 60e3);
  assert.equal(b.b2.late, null, 'closed (not in the open set): finished, not late');
  assert.equal(b.b3.late, null, 'not ended yet');
  assert.equal(b.b1.past, true);
  assert.equal(b.b3.past, false);
  assert.equal(L(p, { now: at(10, 15), open: null }).items[0].late, null, 'with no item data nothing is flagged');
  assert.equal(L(p, { now: at(9, 30), open }).items[0].late, null, 'still inside its box');
});

test('opportunities are never flagged late', () => {
  const l = L(plan({ boxes: [box('b1', at(9), at(10), 'rule:x:1', 'opportunity')] }), { now: at(12), open: new Set(['rule:x:1']) });
  assert.equal(l.items[0].late, null);
});

test('a day with no plan still draws the hours and the now line', () => {
  const l = L(null);
  assert.deepEqual([l.empty, l.stale, l.items.length, l.bands.length], [true, false, 0, 0]);
  assert.equal(l.ticks.length, 10);
  assert.equal(l.now.pos, 300);
});

test("yesterday's plan is not today's: it lays out empty and says stale", () => {
  const old = plan({ day: '2026-03-03', boxes: [box('b1', at(9), at(10), 'linear:ACME-1')] });
  const l = L(old);
  assert.deepEqual([l.empty, l.stale, l.items.length], [true, true, 0]);
});

test('now outside the working hours has no line', () => {
  assert.equal(L(plan(), { now: at(7) }).now, null);
  assert.equal(L(plan(), { now: at(17) }).now, null);
});

test('an all-day or multi-day meeting becomes a band, not a lane that squeezes the day', () => {
  const l = L(plan({ meetings: [
    { subject: 'Offsite', start: at(0), end: at(24), tentative: false },
    { subject: 'Trip', start: at(-30), end: at(48), tentative: false },
    { subject: 'Standup', start: at(9), end: at(9, 30), tentative: false }] }));
  assert.deepEqual(l.bands.map(b => b.title), ['Offsite', 'Trip']);
  assert.deepEqual(l.items.map(i => [i.title, i.lane, i.lanes]), [['Standup', 0, 1]]);
});

test('a meeting that runs past the edges of the day is clipped and says so', () => {
  const l = L(plan({ meetings: [
    { subject: 'Early', start: at(6), end: at(9), tentative: false },
    { subject: 'Late', start: at(16), end: at(19), tentative: false },
    { subject: 'Gone', start: at(18), end: at(19), tentative: false }] }));
  const by = Object.fromEntries(l.items.map(i => [i.title, i]));
  assert.deepEqual([by.Early.pos, by.Early.len, by.Early.clipStart, by.Early.clipEnd], [0, 100, true, false]);
  assert.deepEqual([by.Late.pos, by.Late.len, by.Late.clipEnd], [800, 100, true]);
  assert.equal(by.Gone, undefined);
});

test('a short block keeps a clickable length and stays inside the axis', () => {
  const l = L(plan({ boxes: [box('b1', at(16, 55), at(17), 'linear:ACME-1')] }), { size: 450 });
  const b = l.items[0];
  assert.equal(b.len, MIN_LEN);
  assert.ok(b.pos + b.len <= 450);
});

test('few pixels per hour thin the hour labels to every second hour', () => {
  const l = L(plan(), { size: 270 });
  assert.deepEqual(l.ticks.filter(t => t.label).map(t => t.hour), [8, 10, 12, 14, 16]);
});

test('a degenerate size or inverted box does not throw or leak NaN', () => {
  const l = L(plan({ boxes: [box('b1', at(10), at(9), 'linear:ACME-1')] }), { size: 0 });
  assert.equal(l.items.length, 0);
  assert.ok(l.ticks.every(t => Number.isFinite(t.pos)));
});

test('hhmm is local 24-hour', () => assert.equal(hhmm(at(9, 5)), '09:05'));

test('unplaced: items and opportunities not in any box, in plan order', () => {
  const p = plan({ boxes: [box('b1', at(9), at(10), 'linear:ACME-1'), box('b2', at(10), at(11), null)] });
  const u = unplaced(p);
  assert.deepEqual(u.work.map(i => i.id), ['linear:ACME-2']);
  assert.deepEqual(u.opportunities.map(i => i.id), ['rule:x:1']);
  assert.deepEqual(unplaced(null), { work: [], opportunities: [], hidden: 0, why: { project: 0, state: 0, age: 0 } });
  assert.equal(u.hidden, 0, 'no focus hides nothing');
});

test('unplaced honours focus: the rail keeps only chosen projects, counts the rest, and never touches a box', () => {
  const p = plan({ items: [{ ...item('linear:ACME-1', 'due'), project: 'Acme Web' }, { ...item('linear:ACME-2', 'ready'), project: 'Other' }, { ...item('linear:ACME-3', 'ready'), project: null }],
    opportunities: [{ ...item('rule:x:1', 'opportunity'), project: 'acme-web' }, { ...item('rule:x:2', 'opportunity'), project: 'other' }],
    boxes: [box('b1', at(9), at(10), 'linear:ACME-2')] });
  const u = unplaced(p, { projects: ['acme web'] });
  assert.deepEqual(u.work.map(i => i.id), ['linear:ACME-1']);
  assert.deepEqual(u.opportunities.map(i => i.id), ['rule:x:1'], 'near-miss names match (norm)');
  assert.equal(u.hidden, 2, 'an item with no project and an opportunity of another one; the boxed item is not counted');
  assert.equal(L(p).items.filter(i => i.boxId).length, 1, 'the box stays on the timeline');
  assert.equal(unplaced(p, { projects: [] }).work.length, 2, 'empty focus filters nothing');
});

test('focus is a running work box with an item, in today\'s plan', () => {
  const p = plan({ boxes: [box('b1', at(9), at(10), 'linear:ACME-1'), box('b2', at(10), at(11), 'rule:x:1', 'opportunity'), box('b3', at(11), at(12), null)] });
  assert.equal(focusNow(p, at(9, 30)).until, at(10));
  assert.equal(focusNow(p, at(9)).until, at(10), 'inclusive of the start');
  assert.equal(focusNow(p, at(10)), null, 'ends at the end');
  assert.equal(focusNow(p, at(10, 30)), null, 'an opportunity is not a work box');
  assert.equal(focusNow(p, at(11, 30)), null, 'an empty box is not work');
  assert.equal(focusNow(null, at(9, 30)), null);
  assert.equal(focusNow({ ...p, day: '2026-03-03' }, at(9, 30)), null, 'yesterday');
});

test('the next boundary is the soonest start or end of a work box, so a timer can wake exactly then', () => {
  const p = plan({ boxes: [box('b1', at(9), at(10), 'linear:ACME-1'), box('b2', at(13), at(14), 'linear:ACME-2'), box('b3', at(11), at(12), 'rule:x:1', 'opportunity')] });
  assert.equal(nextBoundary(p, at(8)), at(9));
  assert.equal(nextBoundary(p, at(9, 30)), at(10));
  assert.equal(nextBoundary(p, at(10)), at(13));
  assert.equal(nextBoundary(p, at(15)), null);
  assert.equal(nextBoundary(null, at(8)), null);
});

test('splitNotices: outside focus everything goes through; in focus only plan gates do', () => {
  const list = [{ key: 'gate:T-1:plan-gate', gate: true }, { key: 'gate:T-2:human-review' }, { key: 'review:u' }, { key: 'ask:s:q' }];
  assert.deepEqual(splitNotices(list, null), { through: list, held: [] });
  const s = splitNotices(list, { until: 1 });
  assert.deepEqual(s.through.map(a => a.key), ['gate:T-1:plan-gate']);
  assert.deepEqual(s.held.map(a => a.key), ['gate:T-2:human-review', 'review:u', 'ask:s:q']);
});

test('seenAfter: a held notice is left out so it is new when focus ends; one delivered before focus is not delivered again', () => {
  const keys = new Set(['ask:a', 'ask:b', 'gate:g']);
  const held = new Set(['ask:a', 'ask:b']);
  assert.deepEqual([...seenAfter(keys, held, new Set(['ask:a']))].sort(), ['ask:a', 'gate:g']);
  assert.deepEqual([...seenAfter(keys, new Set(), null)].sort(), ['ask:a', 'ask:b', 'gate:g']);
  assert.deepEqual([...seenAfter(keys, held, null)], ['gate:g']);
});

test('a block that starts exactly where an overlapping pair ended is a new cluster, full width', () => {
  const l = L(plan({ meetings: [
    { subject: 'A', start: at(9), end: at(10), tentative: false },
    { subject: 'B', start: at(9, 30), end: at(10, 30), tentative: false }], boxes: [box('b1', at(10, 30), at(11), 'linear:ACME-1')] }));
  const b = l.items.find(i => i.boxId === 'b1');
  assert.deepEqual([b.lane, b.lanes], [0, 1]);
});

test('a block ending exactly now is past', () => {
  const l = L(plan({ boxes: [box('b1', at(10), at(11), 'linear:ACME-1')] }), { now: at(11) });
  assert.equal(l.items[0].past, true);
});

test('a meeting exactly covering the working hours is an all-day band', () => {
  const l = L(plan({ meetings: [{ subject: 'Offsite', start: at(8), end: at(17), tentative: false }] }));
  assert.deepEqual([l.bands.map(b => b.title), l.items.length], [['Offsite'], 0]);
});

test('a meeting and a box at the same time: the meeting takes the first lane', () => {
  const l = L(plan({ meetings: [{ subject: 'Sync', start: at(10), end: at(11), tentative: false }], boxes: [box('b1', at(10), at(11), 'linear:ACME-1')] }));
  const m = l.items.find(i => i.tone === 'meeting'), b = l.items.find(i => i.boxId === 'b1');
  assert.deepEqual([m.lane, b.lane], [0, 1]);
});

test('minuteAt: a pixel offset along either axis is minutes after midnight, snapped to 15 and held inside the hours', () => {
  const o = { size: 900, hours: HOURS };
  assert.equal(minuteAt(0, o), 8 * 60);
  assert.equal(minuteAt(100, o), 9 * 60);
  assert.equal(minuteAt(120, o), 9 * 60 + 15, '120 px is 9:12, snapped to 9:15');
  assert.equal(minuteAt(-50, o), 8 * 60, 'before the start');
  assert.equal(minuteAt(5000, o), 17 * 60, 'past the end');
  assert.equal(minuteAt(150, { ...o, snap: 5 }), 9 * 60 + 30);
  assert.equal(minuteAt(450, { size: 450, hours: { start: 0, end: 1440 } }), 1440);
});

test('deltaMinutes: a pixel distance is a snapped number of minutes, negative going back, never -0', () => {
  const o = { size: 900, hours: HOURS };
  assert.equal(deltaMinutes(100, o), 60);
  assert.equal(deltaMinutes(-100, o), -60);
  assert.equal(deltaMinutes(20, o), 15);
  assert.equal(deltaMinutes(-20, o), -15);
  assert.ok(Object.is(deltaMinutes(-3, o), 0));
  assert.equal(deltaMinutes(0, o), 0);
});

test('a box with a title and no item is custom, titled by the owner; with neither it stays empty', () => {
  const l = L(plan({ boxes: [{ ...box('b1', at(9), at(10), null, 'task'), title: 'Dentist', source: 'you' }, box('b2', at(12), at(13), null)] }));
  assert.deepEqual(l.items.map(i => [i.tone, i.title, i.itemId]), [['custom', 'Dentist', null], ['empty', null, null]]);
  assert.deepEqual([l.items[0].boxStart, l.items[0].boxEnd], [at(9), at(10)]);
});

test('focus counts a running custom box, but not an untitled one', () => {
  const p = plan({ boxes: [{ ...box('b1', at(9), at(10), null, 'task'), title: 'Dentist' }, box('b2', at(11), at(12), null, 'task')] });
  assert.equal(focusNow(p, at(9, 30)).until, at(10));
  assert.equal(focusNow(p, at(11, 30)), null);
  assert.equal(nextBoundary(p, at(8)), at(9));
  assert.equal(nextBoundary(p, at(10)), null);
});

test('unplaced: an item from a plan made before items carried a project is shown under focus, not hidden', () => {
  const p = plan({ items: [item('linear:ACME-1', 'due'), { ...item('linear:ACME-2', 'ready'), project: null }], opportunities: [] });
  const u = unplaced(p, { projects: ['Acme Web'] });
  assert.deepEqual(u.work.map(i => i.id), ['linear:ACME-1'], 'no project key: not judged');
  assert.equal(u.hidden, 1, 'a project of null is judged and hidden');
});

test('hiddenBy mirrors lib/today.mjs: project, state, age, in that order; due work is not cut by age', () => {
  const d = n => new Date(at(11) - n * 864e5).toISOString();
  const w = { kind: 'ready', project: 'Acme Web', state: 'Todo', updatedAt: d(30) };
  assert.equal(hiddenBy(w, undefined, at(11)), null);
  assert.equal(hiddenBy(w, { projects: ['Other'], age: 7, states: ['Todo'] }, at(11)), 'project');
  assert.equal(hiddenBy(w, { age: 7, states: ['todo'] }, at(11)), 'state');
  assert.equal(hiddenBy(w, { age: 7 }, at(11)), 'age');
  assert.equal(hiddenBy({ ...w, kind: 'due' }, { age: 7 }, at(11)), null);
  assert.equal(hiddenBy({ ...w, updatedAt: null, state: null }, { age: 1, states: ['Todo'] }, at(11)), null);
  assert.equal(hiddenBy({ id: 'o', project: null, ageDays: 8 }, { age: 7 }, at(11)), 'age');
  assert.equal(hiddenBy({ id: 'o', project: null, ageDays: 0 }, { age: 1 }, at(11)), null);
  assert.equal(hiddenBy({ id: 'o', project: null, ageDays: null }, { age: 1 }, at(11)), null);
});

test('unplaced: the rail drops what the limits hide at once, counts each reason once, and keeps hidden as the total', () => {
  const d = n => new Date(at(11) - n * 864e5).toISOString();
  const w = (id, o) => ({ ...item(id, 'ready'), project: 'Acme Web', state: 'Todo', updatedAt: d(1), ...o });
  const p = plan({ items: [w('linear:A-1', {}), w('linear:A-2', { updatedAt: d(30) }), w('linear:A-3', { state: 'Blocked' }), w('linear:A-4', { project: 'Other', state: 'Blocked' }),
      w('linear:A-5', { kind: 'due', updatedAt: d(90) }), w('linear:A-6', { updatedAt: d(30) })],
    opportunities: [{ id: 'rule:x:1', source: 'rule:x', project: 'Acme Web', ageDays: 20 }, { id: 'rule:x:2', source: 'rule:x', project: 'Acme Web', ageDays: 0 }],
    boxes: [box('b1', at(9), at(10), 'linear:A-6')] });
  const u = unplaced(p, { projects: ['Acme Web'], age: 7, states: ['Blocked'] }, at(11));
  assert.deepEqual(u.work.map(i => i.id), ['linear:A-1', 'linear:A-5']);
  assert.deepEqual(u.opportunities.map(i => i.id), ['rule:x:2']);
  assert.deepEqual(u.why, { project: 1, state: 1, age: 2 }, 'A-4 by project (once, though its state matches too); A-2 and the old opportunity by age; the boxed A-6 is not counted');
  assert.equal(u.hidden, 4, 'the total');
  assert.equal(unplaced(p, undefined, at(11)).hidden, 0);
});

test('unplaced: an old plan item with no updatedAt or state key is kept under age and state limits', () => {
  const p = plan({ items: [item('linear:ACME-1', 'ready')], opportunities: [] });
  assert.equal(unplaced(p, { age: 1, states: ['Todo'] }, at(11)).work.length, 1);
});
