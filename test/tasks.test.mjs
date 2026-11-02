import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailLines, outputPath } from '../lib/tasks.mjs';

test('tailLines keeps the last lines as displayed: no colour codes, a redrawn line at its final state', () => {
  assert.deepEqual(tailLines('one\n\x1b[32mtwo\x1b[0m\n  10%\r  50%\r 100% \n\n', 5), ['one', 'two', ' 100%']);
  assert.deepEqual(tailLines('a\nb\nc', 2), ['b', 'c']);
  assert.deepEqual(tailLines('', 3), []);
});

test('outputPath accepts only plain task ids', async () => {
  for (const id of ['../x', 'a/b', '..', 'x'.repeat(41), '']) assert.equal(await outputPath(id), null, id);
});
