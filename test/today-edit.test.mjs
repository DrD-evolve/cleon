import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putItem, clearBox } from '../lib/today-edit.mjs';

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
