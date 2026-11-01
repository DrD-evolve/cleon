import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrSnapshot, herdrFocus } from '../lib/herdr.mjs';

const snap = (wsLabel, agent) => ({ result: { snapshot: {
  workspaces: [{ workspace_id: 'w1', label: wsLabel, agent_status: 'idle' }],
  tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1' }],
  agents: [{ pane_id: 'w1:p1', workspace_id: 'w1', agent, agent_status: 'idle' }],
  focused_pane_id: 'w1:p1',
} } });

test('herdrSnapshot merges every running named session and tags records with it', async () => {
  const calls = [];
  const fake = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'session') return { sessions: [
      { name: 'default', running: false }, { name: 'acme', running: true }, { name: 'other', running: true },
    ] };
    return args[1] === 'acme' ? snap('Project Acme', 'claude') : snap('Other', 'ACME-70');
  };
  const r = await herdrSnapshot(fake);
  assert.deepEqual(calls.slice(1), ['--session acme api snapshot', '--session other api snapshot']);
  assert.deepEqual(r.sessions, ['acme', 'other']);
  assert.deepEqual(r.workspaces.map(w => [w.session, w.label]), [['acme', 'Project Acme'], ['other', 'Other']]);
  assert.deepEqual(r.agents.map(a => [a.session, a.agent]), [['acme', 'claude'], ['other', 'ACME-70']]);
  assert.equal(r.focused, 'w1:p1');
});

test('herdrSnapshot is offline when no session runs or the CLI errors', async () => {
  assert.deepEqual(await herdrSnapshot(async () => ({ sessions: [{ name: 'default', running: false }] })),
    { online: false, reason: 'no herdr session running' });
  assert.deepEqual(await herdrSnapshot(async () => ({ error: { message: 'herdr not installed' } })),
    { online: false, reason: 'herdr not installed' });
});

test('herdrFocus targets the session that owns the pane and rejects panes that are not live', async () => {
  const calls = [];
  const fake = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'session') return { sessions: [{ name: 'a', running: true }, { name: 'b', running: true }] };
    if (args[2] === 'api') return args[1] === 'a' ? snap('A', 'claude') : { result: { snapshot: {
      workspaces: [], tabs: [], agents: [{ pane_id: 'w2:p6', workspace_id: 'w2', agent: 'claude' }] } } };
    return { result: {} };
  };
  assert.deepEqual(await herdrFocus('w2:p6', fake), { ok: true, session: 'b', pane: 'w2:p6' });
  assert.equal(calls.at(-1), '--session b agent focus w2:p6');
  calls.length = 0;
  assert.deepEqual(await herdrFocus('wD:p2', fake), { ok: false, reason: 'pane not live' });
  assert.ok(!calls.some(c => c.includes('focus')));
});
