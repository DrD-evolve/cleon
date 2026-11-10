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

test('listSessions reads from MC_SESSIONS_DIR and passes on entrypoint and procStart', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'acme-sessions-'));
  try {
    await writeFile(join(dir, '7.json'), JSON.stringify({ pid: 7, sessionId: 'acme', entrypoint: 'cli', procStart: '134387216091319326' }));
    const [s] = await listSessions(dir, () => true);
    assert.deepEqual([s.entrypoint, s.procStart], ['cli', '134387216091319326']);
    const r = await import('node:child_process').then(cp => new Promise(ok => cp.execFile(process.execPath, ['--input-type=module', '-e',
      `import('${new URL('../lib/sessions.mjs', import.meta.url).href}').then(m => console.log(m.SESSIONS_DIR))`],
    { env: { ...process.env, MC_SESSIONS_DIR: dir } }, (e, out) => ok(out.trim()))));
    assert.equal(r, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
