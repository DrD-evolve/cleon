import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshed } from '../lib/refresh.mjs';

// A refresh whose results the test scripts: each call takes the next entry (a value, or an Error to reject with).
const scripted = (...steps) => {
  const calls = [];
  const fn = async () => { calls.push(1); const s = steps[Math.min(calls.length, steps.length) - 1]; if (s instanceof Error) throw s; return s; };
  return { fn, calls };
};
const tick = () => new Promise(r => setImmediate(r));
// Every unhandled rejection the process sees while `body` runs.
async function watching(body) {
  const seen = [];
  const on = e => seen.push(e);
  process.on('unhandledRejection', on);
  try { await body(); await tick(); await tick(); } finally { process.off('unhandledRejection', on); }
  return seen;
}

test('a refresh that rejects while a last value exists: the last value is served, nothing is unhandled, the next call tries again', async () => {
  const { fn, calls } = scripted({ at: 1, n: 'first' }, new Error('boom'), { at: 3, n: 'third' });
  const logs = [];
  const get = refreshed('Sample', fn, { ttl: 0, log: m => logs.push(m) });
  const seen = await watching(async () => {
    assert.equal((await get()).n, 'first');
    assert.equal((await get()).n, 'first', 'the caller gets the last value while the failing refresh runs');
    await tick();
    assert.equal((await get()).n, 'first', 'still the last value after the failure');
    await tick();
    assert.equal((await get()).n, 'third', 'the next call tried again and recovered');
  });
  assert.deepEqual(seen, []);
  assert.equal(calls.length, 4, 'every call after the failure started a refresh');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^Sample: .*boom/);
});

test('with no last value yet, a failing refresh rejects for the caller (the route answers with the reason), and the next call tries again', async () => {
  const { fn, calls } = scripted(new Error('no luck'), { n: 'ok' });
  const get = refreshed('Sample', fn, { ttl: 1000, log: () => {} });
  const seen = await watching(async () => {
    await assert.rejects(get(), /no luck/);
    assert.deepEqual(await get(), { n: 'ok' });
  });
  assert.deepEqual(seen, []);
  assert.equal(calls.length, 2);
});

test('a source that keeps failing is logged once, with its name; a success then a new failure logs again', async () => {
  const { fn } = scripted({ n: 1 }, new Error('a'), new Error('b'), new Error('c'), { n: 2 }, new Error('d'));
  const logs = [];
  const get = refreshed('Docker', fn, { ttl: 0, log: m => logs.push(m) });
  const steps = [];
  for (let i = 0; i < 6; i++) { steps.push((await get())?.n); await tick(); await tick(); }
  assert.equal(logs.length, 2, logs.join('\n'));
  assert.match(logs[0], /^Docker: .*a/);
  assert.match(logs[1], /^Docker: .*d/);
});

test('a refresh within its ttl is not started again, and two callers share one running refresh', async () => {
  let n = 0, release;
  const gate = new Promise(r => { release = r; });
  const get = refreshed('Sample', async () => { n++; await gate; return { n }; }, { ttl: 60_000, log: () => {} });
  const a = get(), b = get();
  release();
  assert.deepEqual(await a, await b);
  assert.equal(n, 1);
  await get();
  assert.equal(n, 1, 'fresh enough');
});

test('fresh waits for a refresh that is running, and for a new one when the last value is stale', async () => {
  let n = 0;
  const get = refreshed('Sample', async () => { n++; await tick(); return { n }; }, { ttl: 60_000, log: () => {} });
  assert.equal((await get()).n, 1);
  assert.equal((await get()).n, 1, 'the cached value');
  assert.equal((await get(true)).n, 2, 'an action asks for a fresh one');
});

test('the last value is kept while the refresh behind it is slow', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let n = 0;
  const get = refreshed('Sample', async () => { n++; if (n > 1) await gate; return { n }; }, { ttl: 0, log: () => {} });
  assert.equal((await get()).n, 1);
  assert.equal((await get()).n, 1, 'served at once, not held up by the refresh');
  release();
  await tick();
  assert.equal((await get()).n, 2);
});
