import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findWorkspace, openInHerdr, openInVscode, openInBash } from '../lib/open.mjs';

const project = { name: 'Acme', path: String.raw`C:\dev\Development\Acme` };
const snap = {
  online: true, sessions: ['main', 'side'], agents: [],
  workspaces: [
    { session: 'main', workspace_id: 'w1', label: 'scratch' },
    { session: 'side', workspace_id: 'w1', label: 'Acme' },
    { session: 'main', workspace_id: 'w2', label: 'Acme-other' },
  ],
  panes: [
    { session: 'main', workspace_id: 'w1', pane_id: 'w1:p1', cwd: 'C:\\dev\\Development\\Acme\\src\\' },
    { session: 'side', workspace_id: 'w1', pane_id: 'w1:p1', cwd: 'C:/dev/Development/Acme' },
    { session: 'main', workspace_id: 'w2', pane_id: 'w2:p1', cwd: String.raw`C:\dev\Development\Acme-other` },
  ],
};

test('findWorkspace matches panes in or below the folder (not a sibling with the same prefix), preferring the project label', () => {
  assert.deepEqual(findWorkspace(project, snap), snap.workspaces[1]);
  assert.deepEqual(findWorkspace(project, { ...snap, panes: snap.panes.slice(0, 1) }), snap.workspaces[0]);
  assert.equal(findWorkspace({ name: 'Nope', path: String.raw`C:\dev\Nope` }, snap), null);
  assert.equal(findWorkspace({ name: 'Acme-o', path: String.raw`C:\dev\Development\Acme-o` }, snap), null);
});

const deps = (calls, s = snap, session = null) => ({
  snapshot: async () => s, session,
  raise: async sess => `window of ${sess}`,
  run: async args => {
    calls.push(args.join(' '));
    return args.includes('create') ? { result: { root_pane: { pane_id: 'w9:p1' } } } : { result: { type: 'ok' } };
  },
});

test('openInHerdr focuses an existing workspace instead of creating one', async () => {
  const calls = [];
  const r = await openInHerdr(project, deps(calls));
  assert.deepEqual(calls, ['--session side workspace focus w1']);
  assert.equal(r.created, false);
  assert.equal(r.raised, 'window of side');
});

test('openInHerdr creates a labelled workspace in the configured session, else the first running one, and starts claude', async () => {
  const fresh = { ...snap, panes: [] };
  let calls = [];
  const r = await openInHerdr(project, deps(calls, fresh, 'side'));
  assert.deepEqual(calls, [
    `--session side workspace create --cwd ${project.path} --label Acme --focus`,
    '--session side pane run w9:p1 claude',
  ]);
  assert.equal(r.created, true);
  calls = [];
  await openInHerdr(project, deps(calls, fresh));
  assert.match(calls[0], /^--session main workspace create/);
});

test('openInHerdr refuses when herdr or the configured session is not running', async () => {
  assert.equal((await openInHerdr(project, deps([], { online: false, reason: 'no herdr session running' }))).reason, 'no herdr session running');
  const r = await openInHerdr(project, deps([], { ...snap, panes: [] }, 'gone'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /"gone" isn't running/);
});

test('openInVscode reports a missing code command, and raises the window once it appears', async () => {
  assert.equal((await openInVscode(project, async () => null, async () => null)).ok, false);
  let tries = 0;
  const r = await openInVscode(project, async name => (++tries === 3 ? name : null), async () => 'Code.exe', async () => {}, async () => ({ ok: true }));
  assert.deepEqual(r, { ok: true, raised: 'Acme' });
});

test('openInBash runs Git\'s mintty with a login bash in the folder, in the MINGW64 environment', async () => {
  let got;
  await openInBash(project, 'C:/Program Files/Git', async (...a) => { got = a; return { ok: true }; });
  assert.match(got[0].replace(/\\/g, '/'), /^C:\/Program Files\/Git\/usr\/bin\/mintty\.exe$/);
  assert.deepEqual(got[1], ['--dir', project.path, '/usr/bin/bash', '--login', '-i']);
  assert.equal(got[2].MSYSTEM, 'MINGW64');
  assert.equal(got[2].CHERE_INVOKING, '1');
});
