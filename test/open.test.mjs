import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPane, sessionName, openInHerdr, openInVscode, openInBash } from '../lib/open.mjs';

const project = { name: 'Acme Web', path: String.raw`C:\dev\Development\Acme Web` };
const snap = {
  online: true, sessions: ['main', 'acme-web'],
  agents: [{ session: 'acme-web', pane_id: 'w1:p2' }],
  workspaces: [{ session: 'main', workspace_id: 'w1', label: 'scratch' }, { session: 'acme-web', workspace_id: 'w1', label: 'Acme Web' }],
  panes: [
    { session: 'main', workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', cwd: 'C:\\dev\\Development\\Acme Web\\src\\' },
    { session: 'acme-web', workspace_id: 'w1', tab_id: 'w1:t2', pane_id: 'w1:p2', cwd: 'C:/dev/Development/Acme Web/' },
    { session: 'main', workspace_id: 'w2', tab_id: 'w2:t1', pane_id: 'w2:p1', cwd: 'C:\\dev\\Development\\Acme Web-other' },
  ],
};

test('findPane prefers a pane in the folder itself, then one in a subfolder, never a sibling with the same prefix', () => {
  assert.equal(findPane(project, snap).pane_id, 'w1:p2');
  assert.equal(findPane(project, { ...snap, panes: snap.panes.slice(0, 1) }).pane_id, 'w1:p1');
  assert.equal(findPane({ name: 'Acme W', path: String.raw`C:\dev\Development\Acme W` }, snap), null);
  assert.equal(findPane(project, { online: false }), null);
});

test('sessionName lowercases the folder name and dashes anything else', () => {
  assert.equal(sessionName('Acme Web'), 'acme-web');
  assert.equal(sessionName('orchestration-plugin'), 'orchestration-plugin');
  assert.equal(sessionName('Café & Co.'), 'caf-co');
  assert.equal(sessionName('!!!'), 'project');
});

const deps = (calls, s = snap, { sessions = ['main', 'acme-web'], snapAfter = { panes: [{ pane_id: 'w1:p1' }], workspaces: [{ label: 'Acme Web' }] }, clients = ['Acme Web'] } = {}) => ({
  snapshot: async () => s,
  raise: async sess => `window of ${sess}`,
  raiseClient: async label => (clients.includes(label) ? `herdr window ${label}` : null),
  wait: async () => {},
  launch: async (exe, args) => { calls.push(`LAUNCH ${exe} ${args.join(' ')}`); return { ok: true }; },
  run: async args => {
    calls.push(args.join(' '));
    if (args[0] === 'session') return { sessions: sessions.map(name => ({ name })) };
    if (args.includes('snapshot')) return { result: { snapshot: snapAfter } };
    return { result: { type: 'ok' } };
  },
});

test('openInHerdr focuses an agent pane directly, and a shell pane by its tab', async () => {
  let calls = [];
  const r = await openInHerdr(project, deps(calls));
  assert.deepEqual(calls, ['--session acme-web agent focus w1:p2']);
  assert.equal(r.raised, 'herdr window Acme Web');
  calls = [];
  const shell = await openInHerdr(project, deps(calls, { ...snap, panes: snap.panes.slice(0, 1) }));
  assert.deepEqual(calls, ['--session main tab focus w1:t1']);
  assert.equal(shell.raised, 'window of main', 'no herdr window shows "scratch", so the VS Code window hosting the session is raised');
});

test('with no pane in the folder, openInHerdr attaches the project session in Windows Terminal there', async () => {
  const calls = [];
  const r = await openInHerdr(project, deps(calls, { ...snap, panes: [] }));
  assert.deepEqual(calls, ['session list --json', `LAUNCH wt.exe -d ${project.path} herdr session attach acme-web`]);
  assert.deepEqual(r, { ok: true, created: false, attached: true, session: 'acme-web' });
});

test('a brand-new session gets Claude started in its first pane; herdr being offline is no obstacle', async () => {
  const calls = [];
  const r = await openInHerdr(project, deps(calls, { online: false, reason: 'no herdr session running' }, { sessions: ['main'] }));
  assert.deepEqual(calls.slice(-2), ['--session acme-web api snapshot', '--session acme-web pane run w1:p1 claude']);
  assert.deepEqual(r, { ok: true, created: true, session: 'acme-web', claude: true, raised: 'herdr window Acme Web' });
});

test('openInHerdr reports a Windows Terminal launch failure', async () => {
  const d = deps([], { ...snap, panes: [] });
  d.launch = async () => ({ ok: false, reason: 'wt.exe not found' });
  assert.deepEqual(await openInHerdr(project, d), { ok: false, reason: 'wt.exe not found' });
});

test('openInVscode reports a missing code command, and raises the window once it appears', async () => {
  assert.equal((await openInVscode(project, async () => null, async () => null)).ok, false);
  let tries = 0;
  const r = await openInVscode(project, async name => (++tries === 3 ? name : null), async () => 'Code.exe', async () => {}, async () => ({ ok: true }));
  assert.deepEqual(r, { ok: true, raised: 'Acme Web' });
});

test('openInBash runs Git\'s mintty with a login bash in the folder, in the MINGW64 environment', async () => {
  let got;
  await openInBash(project, 'C:/Program Files/Git', async (...a) => { got = a; return { ok: true }; });
  assert.match(got[0].replace(/\\/g, '/'), /^C:\/Program Files\/Git\/usr\/bin\/mintty\.exe$/);
  assert.deepEqual(got[1], ['--dir', project.path, '/usr/bin/bash', '--login', '-i']);
  assert.equal(got[2].MSYSTEM, 'MINGW64');
  assert.equal(got[2].CHERE_INVOKING, '1');
});
