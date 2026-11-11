import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer } from '../public/pace.mjs';

// A fake clock: timers fire in order as `advance` moves time.
function world() {
  let now = 0, id = 0, hidden = false;
  const timers = new Map();
  const env = { hidden: () => hidden,
    set: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clear: t => { timers.delete(t); } };
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; await next[1].fn();
    }
    now = end;
  };
  return { env, advance, hide: v => { hidden = v; }, timers };
}
const counter = () => { const c = { n: 0, fn: async () => { c.n++; } }; return c; };

test('visible: a poll runs at its visible rate', async () => {
  const w = world(), { paced } = createPacer(w.env), c = counter();
  paced(c.fn, 5000, 60000);
  await w.advance(30_000);
  assert.equal(c.n, 6);
});

test('hidden: a poll with a hidden rate runs once a minute, one with 0 stops', async () => {
  const w = world(), p = createPacer(w.env), slow = counter(), off = counter();
  p.paced(slow.fn, 5000, 60000);
  p.paced(off.fn, 10000, 0);
  w.hide(true); p.visibilityChanged();
  await w.advance(5 * 60_000);
  assert.equal(slow.n, 5);
  assert.equal(off.n, 0);
  assert.equal(w.timers.size, 1); // nothing is kept waiting for the stopped one
});

test('showing again runs every poll at once, and each goes back to its visible rate', async () => {
  const w = world(), p = createPacer(w.env), a = counter(), b = counter();
  p.paced(a.fn, 5000, 60000);
  p.paced(b.fn, 10000, 0);
  w.hide(true); p.visibilityChanged();
  await w.advance(120_000);
  const [a0, b0] = [a.n, b.n];
  w.hide(false); p.visibilityChanged();
  await w.advance(0);
  assert.deepEqual([a.n - a0, b.n - b0], [1, 1]);
  await w.advance(20_000);
  assert.deepEqual([a.n - a0, b.n - b0], [5, 3]);
});

test('a poll that throws still gets its next turn', async () => {
  const w = world(), { paced } = createPacer(w.env);
  let n = 0;
  paced(async () => { n++; throw new Error('ACME down'); }, 1000, 0);
  await assert.rejects(w.advance(1000), /ACME down/);
  await assert.rejects(w.advance(1000), /ACME down/);
  assert.equal(n, 2);
});
