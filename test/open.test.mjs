import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPane, sessionName, openInHerdr, startInHerdr, openInVscode, openInBash, cleanEnv } from '../lib/open.mjs';

const project = { name: 'Acme Web', path: String.raw`C:\dev\Development\Acme Web` };
// Git Bash's taskbar identity, as git-bash.exe gives its own mintty.
const taskbar = ['-o', 'AppID=GitForWindows.Bash', '-o', 'AppName=Git Bash', '-o', 'AppLaunchCmd=G:/Git/git-bash.exe', '--store-taskbar-properties'];
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
// `windows`: classes of the Git Bash windows already open (one launched here appears once launched).
// `shown`: workspace labels that some other herdr window's title shows.
const deps = (calls, s = snap, { windows = [], shown = [], serverUp = true } = {}) => ({
  snapshot: async () => s,
  raise: async sess => `window of ${sess}`,
  raiseClient: async label => (shown.includes(label) ? label : null),
  raiseClass: async prefix => ([...windows, ...calls.filter(c => c.exe).map(c => c.args[1])].some(w => w.startsWith(prefix)) ? prefix : null),
  serve: async (session, cwd) => { calls.push(`SERVE ${session} ${slash(cwd)}`); return { ok: true }; },
  gitDir: 'G:/Git', id: 7,
  wait: async () => {},
  launch: async (exe, args, env) => { calls.push({ exe: slash(exe), args: args.map(slash), env }); return { ok: true }; },
  run: async args => {
    calls.push(args.join(' '));
    if (args.includes('snapshot')) return serverUp ? { result: { snapshot: {} } } : { error: { message: 'no server' } };
    if (args.includes('create')) return { result: { root_pane: { pane_id: 'w3:p1' } } };
    return { result: { type: 'ok' } };
  },
});
const launches = calls => calls.filter(c => c.exe);
const strings = calls => calls.filter(c => typeof c === 'string');

test('openInHerdr focuses an agent pane directly and a shell pane by its tab, raising the window that shows it', async () => {
  let calls = [];
  const r = await openInHerdr(project, deps(calls, snap, { windows: ['cleon-herdr-acme-web-1'] }));
  assert.deepEqual(calls, ['--session acme-web agent focus w1:p2']);
  assert.deepEqual(r, { ok: true, session: 'acme-web', raised: 'Acme Web' }, 'the Git Bash window opened earlier for this session');
  calls = [];
  const viaTitle = await openInHerdr(project, deps(calls, snap, { shown: ['Acme Web'] }));
  assert.equal(viaTitle.raised, 'Acme Web', 'another herdr window titled with the pane\'s workspace');
  calls = [];
  const shell = await openInHerdr(project, deps(calls, { ...snap, panes: snap.panes.slice(0, 1) }));
  assert.deepEqual(calls, ['--session main tab focus w1:t1']);
  assert.equal(shell.raised, 'window of main', 'nothing else shows "main", so the VS Code window hosting it is raised');
});

test('when no window shows the pane\'s session (its window was closed), openInHerdr attaches a Git Bash window', async () => {
  const calls = [];
  const d = deps(calls);
  d.raise = async () => null;
  const r = await openInHerdr(project, d);
  assert.equal(calls[0], '--session acme-web agent focus w1:p2');
  const [w] = launches(calls);
  assert.equal(w.exe, 'G:/Git/usr/bin/mintty.exe');
  assert.deepEqual(w.args, ['--class', 'cleon-herdr-acme-web-7', '--icon', 'G:/Git/mingw64/share/git/git-for-windows.ico', ...taskbar,
    '--dir', slash(project.path), '-o', 'ConPTY=true', '/usr/bin/bash', '--login', '-i', '-c', 'herdr session attach acme-web || true && exec bash --login -i']);
  assert.ok(!strings(calls).some(c => c.includes('pane run') || c.includes('create')), 'the session already has its Claude');
  assert.deepEqual(r, { ok: true, attached: true, session: 'acme-web', raised: 'Acme Web' });
});

test('with no pane in the folder, the project\'s running session gets a workspace there with Claude, and a window', async () => {
  const calls = [];
  const r = await openInHerdr(project, deps(calls, { ...snap, panes: [] }));
  assert.ok(!strings(calls).some(c => c.startsWith('SERVE')), 'the session\'s server is already running');
  assert.deepEqual(strings(calls), [`--session acme-web workspace create --cwd ${project.path} --label Acme Web --focus`, '--session acme-web pane run w3:p1 claude']);
  assert.equal(launches(calls).length, 1);
  assert.deepEqual(r, { ok: true, attached: false, created: true, claude: true, session: 'acme-web', raised: 'Acme Web' });
});

test('a session that isn\'t running is started headless first, so closing its window never takes the panes with it', async () => {
  const calls = [];
  const r = await openInHerdr(project, deps(calls, { online: false, reason: 'no herdr session running' }));
  assert.equal(calls[0], `SERVE acme-web ${slash(project.path)}`);
  assert.equal(calls[1], '--session acme-web api snapshot');
  assert.ok(calls.indexOf('--session acme-web pane run w3:p1 claude') < calls.indexOf(launches(calls)[0]), 'Claude starts before the window attaches');
  assert.equal(r.created, true);
});

test('startInHerdr runs its command in a new labelled workspace, and raises a window already showing the session instead of attaching another', async () => {
  const calls = [];
  const cmd = 'claude --permission-mode auto "/orchestration:orchestrate-work ACME-588"';
  const r = await startInHerdr(project, { command: cmd, label: 'ACME-588 orchestrator' }, deps(calls, snap, { windows: ['cleon-herdr-acme-web-3'] }));
  assert.deepEqual(strings(calls), [`--session acme-web workspace create --cwd ${project.path} --label ACME-588 orchestrator --focus`,
    `--session acme-web pane run w3:p1 ${cmd}`]);
  assert.deepEqual(launches(calls), []);
  assert.deepEqual(r, { ok: true, attached: false, ran: true, session: 'acme-web', space: 'ACME-588 orchestrator', raised: 'Acme Web' });
  const fresh = [];
  const t = await startInHerdr(project, { command: cmd }, deps(fresh, { online: false }));
  assert.equal(launches(fresh).length, 1, 'no window shows the session, so one is attached');
  assert.equal(t.attached, true);
});

test('startInHerdr puts the command in a new tab of a live workspace whose id and label both match, else in its own workspace', async () => {
  // The session as herdr restored it: the epic's workspace is back under its old id.
  const live = { workspaces: [{ workspace_id: 'wM', label: 'ACME-588' }, { workspace_id: 'w5', label: 'scratch' }] };
  const withLive = calls => ({ ...deps(calls), run: async args => {
    calls.push(args.join(' '));
    if (args.includes('snapshot')) return { result: { snapshot: live } };
    if (args.includes('create')) return { result: { root_pane: { pane_id: args.includes('tab') ? 'wM:p4' : 'w6:p1' } } };
    return { result: { type: 'ok' } };
  } });
  const how = id => ({ command: 'claude x', label: 'ACME-588 orchestrator', tab: { workspace: { id, label: 'ACME-588' }, label: 'orchestrator' } });
  const calls = [];
  const r = await startInHerdr(project, how('wM'), withLive(calls));
  assert.deepEqual(strings(calls), ['--session acme-web api snapshot',
    `--session acme-web tab create --workspace wM --cwd ${project.path} --label orchestrator --focus`, '--session acme-web pane run wM:p4 claude x']);
  assert.equal(r.space, 'ACME-588');
  const other = [];
  const o = await startInHerdr(project, how('w5'), withLive(other));
  assert.ok(strings(other).some(c => c.includes('workspace create') && c.includes('--label ACME-588 orchestrator')), 'w5 is now some other workspace');
  assert.equal(o.space, 'ACME-588 orchestrator');
});

test('openInHerdr reports a server that never comes up, and refuses a session name that isn\'t plain', async () => {
  const calls = [];
  const r = await openInHerdr(project, deps(calls, { online: false }, { serverUp: false }));
  assert.deepEqual(r, { ok: false, reason: 'herdr session acme-web didn\'t start' });
  assert.deepEqual(launches(calls), []);
  const odd = { ...snap, panes: [{ ...snap.panes[1], session: 'x && rm -rf ~' }], agents: [] };
  const d = deps([], odd);
  d.raise = async () => null;
  assert.match((await openInHerdr(project, d)).reason, /isn't a plain name/);
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
  assert.deepEqual(calls[0].args, ['--class', 'cleon-bash-acme-web-7', '--icon', 'G:/Git/mingw64/share/git/git-for-windows.ico', ...taskbar,
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

test('cleanEnv drops what Cleon\'s .env added, so its tokens never reach a window it opens', () => {
  assert.deepEqual(cleanEnv({ PATH: 'p', BITBUCKET_TOKEN: 't', LINEAR_API_KEY: 'l', MC_ROOT: 'r' }, ['BITBUCKET_TOKEN', 'LINEAR_API_KEY', 'MC_ROOT']),
    { PATH: 'p' });
});
