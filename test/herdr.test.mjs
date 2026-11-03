import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrSnapshot, herdrFocus, agentForSession, sessionForAgent, panePids } from '../lib/herdr.mjs';

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

test('herdrSnapshot asks every session at once, and merges in session order whatever answers first', async () => {
  const pending = [];
  const fake = args => args[0] === 'session'
    ? Promise.resolve({ sessions: [{ name: 'acme', running: true }, { name: 'other', running: true }] })
    : new Promise(resolve => pending.push({ session: args[1], resolve }));
  const result = herdrSnapshot(fake);
  for (let i = 0; i < 10 && pending.length < 2; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(pending.map(p => p.session), ['acme', 'other'], 'the second session is asked before the first answers');
  pending[1].resolve(snap('Other', 'ACME-70'));
  pending[0].resolve(snap('Project Acme', 'claude'));
  assert.deepEqual((await result).workspaces.map(w => w.session), ['acme', 'other']);
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

test('herdrFocus opens a window on the session, in the pane\'s folder, only when no window shows it', async () => {
  const fake = async args => {
    if (args[0] === 'session') return { sessions: [{ name: 'acme', running: true }] };
    if (args[2] === 'api') return { result: { snapshot: { workspaces: [{ workspace_id: 'w2', label: 'ACME-1' }],
      agents: [{ pane_id: 'w2:p3', workspace_id: 'w2', agent: 'claude' }],
      panes: [{ pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', cwd: 'C:\\other\\' }, { pane_id: 'w2:p3', workspace_id: 'w2', tab_id: 'w2:t2', cwd: 'C:\\dev\\acme\\' }] } } };
    return { result: {} };
  };
  const attached = [];
  const attach = async (session, cwd) => { attached.push([session, cwd]); return { ok: true, raised: session }; };
  const shown = await herdrFocus({ pane: 'w2:p3' }, fake, async () => 'acme window', attach);
  assert.deepEqual(attached, [], 'a window already shows it');
  assert.equal(shown.raised, 'acme window');
  const none = await herdrFocus({ pane: 'w2:p3' }, fake, async () => null, attach);
  assert.deepEqual(attached, [['acme', 'C:\\dev\\acme\\']]);
  assert.deepEqual(none, { ok: true, session: 'acme', pane: 'w2:p3', workspace: 'w2', raised: 'acme', attached: true });
  assert.equal((await herdrFocus({ workspace: 'w2' }, fake, async () => null, attach)).attached, true);
  assert.deepEqual(attached.at(-1), ['acme', 'C:\\other\\'], 'a workspace: its first pane\'s folder');
  const failed = await herdrFocus({ pane: 'w2:p3' }, fake, async () => null, async () => ({ ok: false, reason: 'mintty.exe not found' }));
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /no window shows that session and opening one failed: mintty.exe not found/);
  assert.equal((await herdrFocus({ pane: 'w2:p3' }, fake, async () => null)).attached, undefined, 'no attach given: focus only, as before');
});

test('agentForSession: recorded id first, then pid among stale panes only', async () => {
  const live = [{ id: 'new', pid: 7 }, { id: 'b', pid: 9 }];
  const snap = { online: true, agents: [
    { session: 's', pane_id: 'w1:p1', agent_session: { value: 'old' } }, // stale since /clear
    { session: 's', pane_id: 'w1:p2', agent_session: { value: 'b' } },
  ] };
  const asked = [];
  const pidsOf = async a => { asked.push(a.pane_id); return a.pane_id === 'w1:p1' ? [7] : [9]; };
  assert.equal((await agentForSession(live[1], snap, live, pidsOf)).pane_id, 'w1:p2');
  assert.deepEqual(asked, []); // a current id costs no process-info call
  assert.equal((await agentForSession(live[0], snap, live, pidsOf)).pane_id, 'w1:p1');
  assert.deepEqual(asked, ['w1:p1']); // only the stale pane was asked
  assert.equal(await agentForSession({ id: 'x', pid: 1 }, snap, live, pidsOf), null);
  assert.equal(await agentForSession(live[0], { online: false }, live, pidsOf), null);
});

test('sessionForAgent: a stale pane resolves to the live session running in it', async () => {
  const live = [{ id: 'new', pid: 7 }];
  const pidsOf = async () => [7];
  assert.equal((await sessionForAgent({ agent_session: { value: 'new' } }, live, pidsOf)).id, 'new');
  assert.equal((await sessionForAgent({ agent_session: { value: 'old' } }, live, pidsOf)).id, 'new');
  assert.equal(await sessionForAgent({ agent_session: { value: 'old' } }, live, async () => [3]), null);
});

test('panePids asks herdr once per pane and reads both pid fields', async () => {
  let calls = 0;
  const run = async () => { calls++; return { result: { process_info: { foreground_process_group_id: 5, foreground_processes: [{ pid: 6 }] } } }; };
  const pidsOf = panePids(run), a = { session: 's', pane_id: 'w1:p1' };
  assert.deepEqual(await pidsOf(a), [5, 6]);
  await pidsOf(a);
  assert.equal(calls, 1);
});
