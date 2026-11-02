import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { listSessions } from '../lib/sessions.mjs';

const FIX = fileURLToPath(new URL('./fixtures/sessions', import.meta.url));

test('listSessions reads session files, skips torn ones, running first', async () => {
  const s = await listSessions(FIX, pid => pid === 111);
  assert.deepEqual(s.map(x => [x.name, x.alive, x.ticket]), [['alpha', true, 'T-1'], ['beta', false, null]]);
});

test('sessionOrder: running first, then by start time, never by last activity', async () => {
  const { sessionOrder } = await import('../lib/sessions.mjs');
  const s = [
    { id: 'old-busy', alive: true, startedAt: 1, updatedAt: 999 },
    { id: 'new-quiet', alive: true, startedAt: 5, updatedAt: 10 },
    { id: 'dead', alive: false, startedAt: 9, updatedAt: 1000 },
  ];
  assert.deepEqual([...s].sort(sessionOrder).map(x => x.id), ['new-quiet', 'old-busy', 'dead']);
});
