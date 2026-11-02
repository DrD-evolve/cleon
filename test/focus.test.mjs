import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusSession } from '../lib/focus.mjs';

const sessions = async () => [
  { id: 'in-herdr', alive: true, cwd: 'C:\\dev\\Development\\Project Acme' },
  { id: 'in-vscode', alive: true, cwd: 'C:\\dev\\Development\\Mission Control' },
  { id: 'dead', alive: false, cwd: 'C:\\x' },
  // herdr's record of this pane's session id went stale (/clear, resume); its pid still matches.
  { id: 'stale-id', alive: true, pid: 175, cwd: 'C:\\dev\\Development\\Project Acme' },
  { id: 'nowhere', alive: true, pid: 9, cwd: 'C:\\elsewhere' },
  { id: 'in-bash', alive: true, pid: 42, cwd: 'C:\\dev\\Development\\Project Acme' },
];
const snapshot = async () => ({
  online: true,
  workspaces: [{ session: 'acme', workspace_id: 'w2', label: 'Formats engine' }],
  agents: [{ session: 'acme', workspace_id: 'w2', pane_id: 'w2:p7', agent_session: { value: 'in-herdr' } }],
});
const deps = calls => ({
  sessions, snapshot,
  focusPane: async t => { calls.push(['pane', t]); return { ok: true, session: 'acme', pane: t.pane, raised: 'Project Acme' }; },
  raisePid: async pid => { calls.push(['term', pid]); return pid === 42 ? 'MINGW64:/c/dev/Development/Project Acme' : null; },
  raiseCwd: async cwd => { calls.push(['cwd', cwd]); return cwd.endsWith('Mission Control') ? 'Mission Control' : null; },
  paneForPid: async pid => { calls.push(['pid', pid]); return pid === 175 ? { session: 'acme', pane: 'w4:p1', label: 'Project Acme' } : null; },
});

test('a session herdr hosts focuses its pane, disambiguated by workspace label', async () => {
  const calls = [];
  const r = await focusSession('in-herdr', deps(calls));
  assert.equal(r.via, 'herdr');
  assert.deepEqual(calls, [['pane', { pane: 'w2:p7', label: 'Formats engine' }]]);
});

test('a herdr pane is still found by pid when its session id is stale', async () => {
  const calls = [];
  const r = await focusSession('stale-id', deps(calls));
  assert.equal(r.via, 'herdr');
  assert.deepEqual(calls, [['pid', 175], ['pane', { pane: 'w4:p1', label: 'Project Acme' }]]);
});

test('a session outside herdr raises the VS Code window for its cwd', async () => {
  const calls = [];
  assert.deepEqual(await focusSession('in-vscode', deps(calls)), { ok: true, raised: 'Mission Control', via: 'vscode' });
  assert.deepEqual(calls, [['pid', undefined], ['term', undefined], ['cwd', 'C:\\dev\\Development\\Mission Control']]);
});

test('a session in a plain terminal (Git Bash) raises that window, before any VS Code match', async () => {
  const calls = [];
  assert.deepEqual(await focusSession('in-bash', deps(calls)), { ok: true, raised: 'MINGW64:/c/dev/Development/Project Acme', via: 'terminal' });
  assert.deepEqual(calls, [['pid', 42], ['term', 42]]);
});

test('when nothing matches, the reason says what was tried', async () => {
  const r = await focusSession('nowhere', deps([]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /checked session id and pid/);
});

test('dead or unknown sessions never reach herdr or Windows', async () => {
  for (const id of ['dead', 'made-up']) {
    const calls = [];
    assert.deepEqual(await focusSession(id, deps(calls)), { ok: false, reason: 'session not running' });
    assert.equal(calls.length, 0);
  }
});
