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

test('herdrFocus targets the owning session, disambiguates by label, and rejects dead targets', async () => {
  const calls = [];
  const ws = (id, label) => ({ workspace_id: id, label });
  const fake = async args => {
    calls.push(args.join(' '));
    if (args[0] === 'session') return { sessions: [{ name: 'a', running: true }, { name: 'b', running: true }] };
    if (args[2] === 'api') return { result: { snapshot: args[1] === 'a'
      ? { workspaces: [ws('w2', 'Alpha')], agents: [{ pane_id: 'w2:p6', workspace_id: 'w2', agent: 'x' }] }
      : { workspaces: [ws('w2', 'Formats engine')], agents: [{ pane_id: 'w2:p6', workspace_id: 'w2', agent: 'claude' }] } } };
    return { result: {} };
  };
  // Same pane id in two sessions: refused without a label, resolved with one.
  assert.deepEqual(await herdrFocus({ pane: 'w2:p6' }, fake), { ok: false, reason: 'matches more than one herdr session' });
  assert.deepEqual(await herdrFocus({ pane: 'w2:p6', label: 'Formats engine' }, fake), { ok: true, session: 'b', pane: 'w2:p6', workspace: 'w2' });
  assert.equal(calls.at(-1), '--session b agent focus w2:p6');
  assert.equal((await herdrFocus({ workspace: 'w2', label: 'Alpha' }, fake)).session, 'a');
  assert.equal(calls.at(-1), '--session a workspace focus w2');
  calls.length = 0;
  assert.deepEqual(await herdrFocus({ pane: 'wD:p2' }, fake), { ok: false, reason: 'pane not live' });
  assert.deepEqual(await herdrFocus({ workspace: 'w9' }, fake), { ok: false, reason: 'workspace not live' });
  assert.ok(!calls.some(c => c.includes('focus')));
});
