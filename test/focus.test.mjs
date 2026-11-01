import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusSession } from '../lib/focus.mjs';

const sessions = async () => [
  { id: 'in-herdr', alive: true, cwd: 'C:\\dev\\Development\\Project Acme' },
  { id: 'in-vscode', alive: true, cwd: 'C:\\dev\\Development\\Mission Control' },
  { id: 'dead', alive: false, cwd: 'C:\\x' },
];
const snapshot = async () => ({
  online: true,
  workspaces: [{ session: 'acme', workspace_id: 'w2', label: 'Formats engine' }],
  agents: [{ session: 'acme', workspace_id: 'w2', pane_id: 'w2:p7', agent_session: { value: 'in-herdr' } }],
});
const deps = calls => ({
  sessions, snapshot,
  focusPane: async t => { calls.push(['pane', t]); return { ok: true, session: 'acme', pane: t.pane, raised: 'Project Acme' }; },
  raiseCwd: async cwd => { calls.push(['cwd', cwd]); return cwd.endsWith('Mission Control') ? 'Mission Control' : null; },
});

test('a session herdr hosts focuses its pane, disambiguated by workspace label', async () => {
  const calls = [];
  const r = await focusSession('in-herdr', deps(calls));
  assert.equal(r.via, 'herdr');
  assert.deepEqual(calls, [['pane', { pane: 'w2:p7', label: 'Formats engine' }]]);
});

test('any other session raises the VS Code window for its cwd', async () => {
  const calls = [];
  assert.deepEqual(await focusSession('in-vscode', deps(calls)), { ok: true, raised: 'Mission Control', via: 'vscode' });
  assert.deepEqual(calls, [['cwd', 'C:\\dev\\Development\\Mission Control']]);
});

test('dead or unknown sessions never reach herdr or Windows', async () => {
  for (const id of ['dead', 'made-up']) {
    const calls = [];
    assert.deepEqual(await focusSession(id, deps(calls)), { ok: false, reason: 'session not running' });
    assert.equal(calls.length, 0);
  }
});
