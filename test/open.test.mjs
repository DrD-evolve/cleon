import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPane, sessionName, openInHerdr, openInVscode, openInBash, cleanEnv } from '../lib/open.mjs';

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

const slash = s => s.replace(/\\/g, '/');
// `shown`: workspace labels a herdr window already shows. A window launched for acme-web shows 'Acme Web'.
const deps = (calls, s = snap, { sessions = ['main', 'acme-web'], snapAfter = { panes: [{ pane_id: 'w1:p1' }], workspaces: [{ label: 'Acme Web', focused: true }] }, shown = [] } = {}) => ({
  snapshot: async () => s,
  raise: async sess => `window of ${sess}`,
  raiseClient: async label => ([...shown, ...calls.some(c => c.exe) ? ['Acme Web'] : []].includes(label) ? label : null),
  id: 7,
  wait: async () => {},
  launch: async (exe, args, env) => { calls.push({ exe: slash(exe), args: args.map(slash), env }); return { ok: true }; },
  run: async args => {
    calls.push(args.join(' '));
    if (args[0] === 'session') return { sessions: sessions.map(name => ({ name })) };
    if (args.includes('snapshot')) return { result: { snapshot: snapAfter } };
    return { result: { type: 'ok' } };
  },
});
const launches = calls => calls.filter(c => c.exe);

test('openInHerdr focuses an agent pane directly, and a shell pane by its tab, raising the window that shows it', async () => {
  let calls = [];
  const r = await openInHerdr(project, deps(calls, snap, { shown: ['Acme Web'] }));
  assert.deepEqual(calls, ['--session acme-web agent focus w1:p2']);
  assert.equal(r.raised, 'Acme Web', 'the herdr window titled with the pane\'s workspace');
  calls = [];
  const shell = await openInHerdr(project, deps(calls, { ...snap, panes: snap.panes.slice(0, 1) }));
  assert.deepEqual(calls, ['--session main tab focus w1:t1']);
  assert.equal(shell.raised, 'window of main', 'no herdr window shows "scratch", so the VS Code window hosting the session is raised');
});

test('when no window shows the pane\'s session (its window was closed), openInHerdr attaches one in Windows Terminal', async () => {
  const calls = [];
  const d = deps(calls);
  d.raise = async () => null;
  const r = await openInHerdr(project, d);
  assert.equal(calls[0], '--session acme-web agent focus w1:p2');
  assert.deepEqual(launches(calls).map(c => [c.exe, ...c.args]), [['wt.exe', '-d', slash(project.path), 'herdr', 'session', 'attach', 'acme-web']]);
  assert.ok(!calls.some(c => typeof c === 'string' && c.includes('pane run')), 'the session already has its Claude');
  assert.deepEqual(r, { ok: true, created: false, attached: true, session: 'acme-web', raised: 'Acme Web' });
});

test('with no pane in the folder, openInHerdr attaches the project\'s existing session in Windows Terminal there', async () => {
  const calls = [];
  const r = await openInHerdr(project, deps(calls, { ...snap, panes: [] }));
  assert.deepEqual(launches(calls).map(c => c.args.at(-1)), ['acme-web']);
  assert.ok(!calls.some(c => typeof c === 'string' && c.includes('pane run')));
  assert.deepEqual(r, { ok: true, created: false, attached: true, session: 'acme-web', raised: 'Acme Web' });
});

test('a brand-new session gets Claude started in its first pane; herdr being offline is no obstacle', async () => {
  const calls = [];
  const r = await openInHerdr(project, deps(calls, { online: false, reason: 'no herdr session running' }, { sessions: ['main'] }));
  assert.ok(calls.includes('--session acme-web pane run w1:p1 claude'));
  assert.deepEqual(r, { ok: true, created: true, session: 'acme-web', claude: true, raised: 'Acme Web' });
});

test('openInHerdr opens Windows Terminal with the configured profile, so the tab keeps that profile\'s icon', async () => {
  const calls = [];
  await openInHerdr(project, { ...deps(calls, { ...snap, panes: [] }), profile: 'Git Bash' });
  assert.deepEqual(launches(calls)[0].args.slice(0, 4), ['-p', 'Git Bash', '-d', slash(project.path)]);
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

test('openInBash runs Claude in Git\'s terminal in the folder (MINGW64, Git icon), then raises the window by its own class', async () => {
  const calls = [];
  let tries = 0;
  const d = deps(calls);
  const r = await openInBash(project, 'G:/Git', { ...d, raiseClass: async cls => (++tries === 2 && cls === 'cleon-bash-acme-web-7' ? cls : null) });
  assert.equal(calls[0].exe, 'G:/Git/usr/bin/mintty.exe');
  assert.deepEqual(calls[0].args, ['--class', 'cleon-bash-acme-web-7', '--icon', 'G:/Git/mingw64/share/git/git-for-windows.ico',
    '--dir', slash(project.path), '/usr/bin/bash', '--login', '-i', '-c', 'claude; exec bash --login -i']);
  assert.equal(calls[0].env.MSYSTEM, 'MINGW64');
  assert.equal(calls[0].env.CHERE_INVOKING, '1');
  assert.equal(calls[0].env.CLAUDECODE, undefined, 'a Claude session marker from the server never reaches the new window');
  assert.deepEqual(r, { ok: true, raised: 'Acme Web' });
});

test('cleanEnv drops the parent Claude session\'s markers but keeps user settings', () => {
  const env = cleanEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PID: '9',
    CODEX_COMPANION_SESSION_ID: 'c', CLAUDE_CONFIG_DIR: 'd', CLAUDE_CODE_GIT_BASH_PATH: 'g', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(env, { PATH: 'p', CLAUDE_CONFIG_DIR: 'd', CLAUDE_CODE_GIT_BASH_PATH: 'g', ANTHROPIC_API_KEY: 'k' });
});
