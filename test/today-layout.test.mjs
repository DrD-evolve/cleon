import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLayout, focusNow, nextBoundary, splitNotices, unplaced, hhmm, MIN_LEN } from '../public/today-layout.mjs';

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
  assert.deepEqual(unplaced(null), { work: [], opportunities: [] });
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
