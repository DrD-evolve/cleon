import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cached } from '../lib/shared.mjs';

const gate = () => { let go; const p = new Promise(r => { go = r; }); return { p, go }; };

test('callers that arrive at once cause one read', async () => {
  let reads = 0;
  const g = gate();
  const get = cached(async () => { reads++; await g.p; return 'ACME'; }, 2000);
  const all = Promise.all(Array.from({ length: 8 }, () => get()));
  g.go();
  assert.deepEqual(await all, Array(8).fill('ACME'));
  assert.equal(reads, 1);
});

test('a call inside the window reads nothing; one after it reads again', async () => {
  let reads = 0, t = 1_000_000;
  const get = cached(async () => ++reads, 2000, () => t);
  assert.equal(await get(), 1);
  t += 1999;
  assert.equal(await get(), 1);
  t += 2;
  assert.equal(await get(), 2);
});

test('invalidate: the next call reads afresh, even while an older read is running', async () => {
  let reads = 0;
  const g = gate();
  const get = cached(async () => { const n = ++reads; if (n === 1) await g.p; return n; }, 2000);
  const old = get();
  get.invalidate();
  assert.equal(await get(), 2); // not the read that began before the change
  g.go();
  assert.equal(await old, 1);
  assert.equal(await get(), 2); // and the old read did not overwrite the newer value
  assert.equal(reads, 2);
});

test('invalidate: the let-go read finishing first does not free a third caller to start another read', async () => {
  let reads = 0;
  const g1 = gate(), g2 = gate();
  const get = cached(async () => { const n = ++reads; await (n === 1 ? g1.p : g2.p); return n; }, 2000);
  const old = get();
  get.invalidate();
  const newer = get();
  g1.go(); await old;
  const third = get(); // the newer read still runs: joined, not a third read
  g2.go();
  assert.deepEqual([await newer, await third, reads], [2, 2, 2]);
});

test('reset: a read already running is still joined, so there is never more than one at a time', async () => {
  let reads = 0, running = 0, peak = 0;
  const g = gate();
  const get = cached(async () => { reads++; peak = Math.max(peak, ++running); await g.p; running--; return reads; }, 60_000);
  const a = get();
  get.reset();
  const b = get();
  g.go();
  assert.deepEqual([await a, await b, reads, peak], [1, 1, 1, 1]);
});

test('reset after a finished read: the next call reads afresh', async () => {
  let reads = 0;
  const get = cached(async () => ++reads, 60_000);
  assert.equal(await get(), 1);
  get.reset();
  assert.equal(await get(), 2);
});

test('a failed read is not kept: the next call tries again', async () => {
  let reads = 0;
  const get = cached(async () => { if (++reads === 1) throw new Error('ACME down'); return reads; }, 2000);
  await assert.rejects(get(), /ACME down/);
  assert.equal(await get(), 2);
});
