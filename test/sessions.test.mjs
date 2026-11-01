import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { listSessions } from '../lib/sessions.mjs';

const FIX = fileURLToPath(new URL('./fixtures/sessions', import.meta.url));

test('listSessions reads session files, skips torn ones, newest first', async () => {
  const s = await listSessions(FIX, pid => pid === 111);
  assert.deepEqual(s.map(x => [x.name, x.alive, x.ticket]), [['alpha', true, 'T-1'], ['beta', false, null]]);
});
