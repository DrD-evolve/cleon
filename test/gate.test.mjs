import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerGate } from '../lib/gate.mjs';

// A simulated dialog: ↑/↓ move ❯, Enter closes it. `ignoreKeys` models a UI that drops input.
function fakePane({ title = 'Plan gate', question = 'Plan written. Approve?', options = ['Approve', 'Revise', 'Abort'], cursor = 0, ignoreKeys = false, stuck = false, multi = false } = {}) {
  const st = { cursor, open: true, keys: [] };
  const screen = () => !st.open ? 'SELECTED' : [multi ? '← ☐ A  ☐ B  ✔ Submit →' : ` ☐ ${title}`, '', `│ ${question}`, '',
    ...options.map((o, i) => `${i === st.cursor ? '❯' : ' '} ${i + 1}. ${o}`), `  ${options.length + 1}. Type something.`, '', 'Enter to select · ↑/↓ to navigate'].join('\n');
  return { st, deps: {
    read: async () => screen(),
    key: async k => {
      st.keys.push(k);
      if (!ignoreKeys) {
        if (k === 'down') st.cursor = Math.min(options.length - 1, st.cursor + 1);
        if (k === 'up') st.cursor = Math.max(0, st.cursor - 1);
        if (k === 'enter' && !stuck) st.open = false;
      }
      return { ok: true };
    },
    sleep: async () => {},
  } };
}
const expect = { question: 'Plan written. Approve?', options: ['Approve', 'Revise', 'Abort'] };

test('answerGate moves one key at a time, then presses Enter on the chosen option', async () => {
  const { st, deps } = fakePane();
  assert.deepEqual(await answerGate(expect, 2, deps), { ok: true, chose: 'Abort' });
  assert.deepEqual(st.keys, ['down', 'down', 'enter']);
  const up = fakePane({ cursor: 2 });
  assert.equal((await answerGate(expect, 0, up.deps)).ok, true);
  assert.deepEqual(up.st.keys, ['up', 'up', 'enter']);
});

test('answerGate sends nothing unless the pane shows exactly the displayed plan gate', async () => {
  for (const [pane, why] of [
    [fakePane({ question: 'Something else?' }), /changed/],
    [fakePane({ options: ['Approve', 'Revise'] }), /changed/],
    [fakePane({ title: 'Permission' }), /isn't a plan gate/],
    [fakePane({ multi: true }), /several questions/],
  ]) {
    const r = await answerGate(expect, 1, pane.deps);
    assert.equal(r.ok, false); assert.match(r.reason, why);
    assert.deepEqual(pane.st.keys, []);
  }
  const closed = fakePane();
  closed.st.open = false;
  assert.match((await answerGate(expect, 1, closed.deps)).reason, /no question is open/);
  assert.match((await answerGate(expect, 7, fakePane().deps)).reason, /no such option/);
});

test('answerGate never presses Enter when the selection does not move', async () => {
  const { st, deps } = fakePane({ ignoreKeys: true });
  const r = await answerGate(expect, 2, deps);
  assert.equal(r.ok, false); assert.match(r.reason, /couldn't move/);
  assert.ok(!st.keys.includes('enter'));
});

test('answerGate reports a dialog still showing after Enter', async () => {
  const r = await answerGate(expect, 1, fakePane({ stuck: true }).deps);
  assert.equal(r.ok, false); assert.match(r.reason, /still showing/);
});
