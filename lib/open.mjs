// Open a project folder in herdr, Git Bash or VS Code (the project map's buttons). Callers pass a
// project from findProject(), never a path from the browser. Dependencies are injectable for tests.
import { spawn, execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { ENV_FILE_KEYS } from './config.mjs';

const norm = p => (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (cwd, dir) => norm(cwd) === norm(dir) || norm(cwd).startsWith(`${norm(dir)}/`);

// Pure: the herdr pane working in a project's folder, or null. A pane in the folder itself wins over
// one in a subfolder; among equals, the first in the snapshot.
export function findPane(project, snap) {
  const panes = snap.online ? snap.panes ?? [] : [];
  return panes.find(p => norm(p.cwd) === norm(project.path)) ?? panes.find(p => inside(p.cwd, project.path)) ?? null;
}

// Pure: the herdr session name for a project — its folder name, lowercased, with anything but
// letters, digits, - and _ turned into dashes.
export const sessionName = name => name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pure: the environment without the markers of the Claude session this server may have been started
// from, and without what Cleon's .env added (`drop`: its tokens would reach every shell and Claude in
// the window, or in a herdr server's panes). Inherited, the markers make a Claude started in the new
// window think it's a child session (it then saves no transcript) and point it at the parent's
// messaging socket. User settings such as CLAUDE_CONFIG_DIR or CLAUDE_CODE_GIT_BASH_PATH are kept.
const SESSION_MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PLUGIN_(DATA|ROOT)|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|BRIDGE_SESSION_ID|ENTRYPOINT|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED)|CODEX_COMPANION_\w+)$/i;
export const cleanEnv = (env, drop = ENV_FILE_KEYS) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_MARKERS.test(k) && !drop.includes(k)));

const detached = (exe, args, env = cleanEnv(process.env)) => new Promise(resolve => {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
  child.once('error', e => resolve({ ok: false, reason: e.code === 'ENOENT' ? `${exe} not found` : e.message }));
  child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
});

// A window opened from the background server appears behind the current one, so keep trying to raise it
// while it comes up. Resolves to what was raised, or null.
async function raiseWhenUp(raise, wait) {
  for (let i = 0; i < 8; i++) {
    await wait(i ? 750 : 400);
    const raised = await raise();
    if (raised) return raised;
  }
  return null;
}

// Git's terminal (mintty) in the project's folder, as Git Bash opens it: the Git for Windows icon,
// Git Bash's taskbar identity (git-bash.exe's AppID, name and relaunch command, so the window groups
// with other Git Bash windows rather than as a separate "mintty" app), MSYSTEM for Git's MINGW64
// environment, CHERE_INVOKING so a login profile doesn't cd to ~. (Launched from a background server,
// git-bash.exe itself exits without opening a window, so mintty is run directly.) The window gets its
// own class, `<base><id>`, so it can be found and raised whatever title it shows.
async function openTerminal(project, gitDir, base, args, { launch = detached, raiseClass, wait = sleep, id = Date.now() }) {
  const cls = `${base}${id}`;
  const r = await launch(join(gitDir, 'usr', 'bin', 'mintty.exe'),
    ['--class', cls, '--icon', join(gitDir, 'mingw64', 'share', 'git', 'git-for-windows.ico'),
      '-o', 'AppID=GitForWindows.Bash', '-o', 'AppName=Git Bash', '-o', `AppLaunchCmd=${join(gitDir, 'git-bash.exe')}`,
      '--store-taskbar-properties', '--dir', project.path, ...args],
    { ...cleanEnv(process.env), MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' });
  if (!r.ok) return r;
  return { ok: true, raised: await raiseWhenUp(() => raiseClass(cls), wait) ? project.name : null };
}

// Run a session's herdr server headless, on its own: a server started by a client inside a Git Bash
// (mintty, ConPTY) window loses all its panes when that window closes; one started like this doesn't.
export const serveHeadless = (session, cwd) => new Promise(resolve => {
  const child = spawn('herdr', ['--session', session, 'server'], { cwd, detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv(process.env) });
  child.once('error', e => resolve({ ok: false, reason: e.code === 'ENOENT' ? 'herdr not found' : e.message }));
  child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
});

export const herdrWindowClass = session => `cleon-herdr-${session}-`;

// A standalone Git Bash window attached to a herdr session (the window is a real Git Bash: a login bash
// in the folder runs `herdr session attach`, and stays as a shell when herdr exits). A session name goes
// into the bash command only when it's a plain name.
async function attachWindow(project, session, { gitDir, wait = sleep, ...term }) {
  if (!/^[\w.-]+$/.test(session)) return { ok: false, reason: `herdr session name "${session}" isn't a plain name` };
  const t = await openTerminal(project, gitDir, herdrWindowClass(session),
    ['-o', 'ConPTY=true', '/usr/bin/bash', '--login', '-i', '-c', `herdr session attach ${session} || true && exec bash --login -i`], { wait, ...term });
  return t.ok ? { ok: true, attached: true, session, raised: t.raised } : t;
}

// A window on a running herdr session that no window shows, opened in `cwd` (a pane's folder; home when unknown).
export const attachHerdrWindow = (session, cwd, deps) =>
  attachWindow({ name: session, path: (cwd ?? '').replace(/[\\/]+$/, '') || os.homedir() }, session, deps);

// Open the project in its herdr session, in a standalone Git Bash window.
// - A pane already in the project's folder (in any session) is focused, an agent pane directly and a
//   shell pane by its tab, and the window showing its session is raised: one opened here (found by its
//   class), another herdr window (`raiseClient(label)`: herdr titles it "<host>: <workspace label>"), or
//   the VS Code window when herdr runs in its terminal (`raise(session, agents)`). A session keeps running
//   after its window closes, so when no window shows it, one is attached.
// - Otherwise Claude Code is started in a new workspace of the project's own session (startInHerdr).
export async function openInHerdr(project, deps) {
  const { snapshot, run, raise, raiseClient, raiseClass } = deps;
  const snap = await snapshot();
  const pane = findPane(project, snap);
  if (pane) {
    const agent = snap.agents.some(a => a.session === pane.session && a.pane_id === pane.pane_id);
    const r = await run(['--session', pane.session, ...(agent ? ['agent', 'focus', pane.pane_id] : ['tab', 'focus', pane.tab_id])]);
    if (r.error) return { ok: false, reason: r.error.message };
    const label = snap.workspaces.find(w => w.session === pane.session && w.workspace_id === pane.workspace_id)?.label;
    const shown = (await raiseClass(herdrWindowClass(pane.session)) ? project.name : null)
      || (label && await raiseClient(label)) || await raise(pane.session, snap.agents);
    return shown ? { ok: true, session: pane.session, raised: shown } : attachWindow(project, pane.session, deps);
  }
  const r = await startInHerdr(project, { command: 'claude' }, { ...deps, snapshot: async () => snap });
  return r.ok ? { ok: true, attached: false, created: true, claude: r.ran, session: r.session, raised: r.raised } : r;
}

// Run `command` in a new workspace (labelled `label`) in the project's folder, in the project's own herdr
// session (named after its folder), and show that session. Its server is started headless if it isn't
// running (herdr then restores the session's earlier workspaces). `tab` ({ workspace: { id, label }, label }),
// when that workspace is live in the session, puts the command in a new tab of it instead; both the id and
// the label must match, since ids repeat once a server starts afresh. A window opened here for the session
// is raised (the new tab or workspace is focused in it), else one is attached. `ran` says whether herdr
// took the command; `space` is the label of the workspace it opened in.
export async function startInHerdr(project, { command, label = project.name, tab }, { snapshot, run, serve = serveHeadless, wait = sleep, ...term }) {
  const name = sessionName(project.name);
  const snap = await snapshot();
  if (!snap.online || !snap.sessions.includes(name)) {
    const s = await serve(name, project.path);
    if (!s.ok) return s;
    let up = false;
    for (let i = 0; i < 20 && !up; i++) { up = Boolean((await run(['--session', name, 'api', 'snapshot'])).result); if (!up) await wait(300); }
    if (!up) return { ok: false, reason: `herdr session ${name} didn't start` };
  }
  const into = tab && (await run(['--session', name, 'api', 'snapshot'])).result?.snapshot?.workspaces
    ?.find(w => w.workspace_id === tab.workspace.id && w.label === tab.workspace.label);
  const made = into
    ? await run(['--session', name, 'tab', 'create', '--workspace', into.workspace_id, '--cwd', project.path, '--label', tab.label, '--focus'])
    : await run(['--session', name, 'workspace', 'create', '--cwd', project.path, '--label', label, '--focus']);
  const first = made.result?.root_pane?.pane_id;
  if (!first) return { ok: false, reason: made.error?.message ?? `herdr didn't create the ${into ? 'tab' : 'workspace'}` };
  const ran = !(await run(['--session', name, 'pane', 'run', first, command])).error;
  const space = into?.label ?? label;
  // MC_HEADLESS: no one sits at this machine, so no window is raised or attached.
  if (term.headless) return { ok: true, attached: false, ran, session: name, space, raised: null, headless: true };
  if (await term.raiseClass(herdrWindowClass(name))) return { ok: true, attached: false, ran, session: name, space, raised: project.name };
  const t = await attachWindow(project, name, { wait, ...term });
  return t.ok ? { ...t, ran, space } : t;
}

// Git Bash in the project's folder, running Claude Code (a login shell stays open after it exits).
export const openInBash = (project, gitDir, term = {}) =>
  openTerminal(project, gitDir, `cleon-bash-${sessionName(project.name)}-`, ['/usr/bin/bash', '--login', '-i', '-c', 'claude; exec bash --login -i'], term);

// VS Code's executable, found from the `code` command on PATH (bin/code.cmd sits next to ../Code.exe).
// Run directly rather than through code.cmd, so no shell ever parses the folder path.
const codeExe = () => new Promise(resolve => execFile('where', ['code.cmd'], { windowsHide: true },
  (err, out) => resolve(err ? null : join(dirname(out.split(/\r?\n/)[0].trim()), '..', 'Code.exe'))));

// Open the folder in VS Code (an already-open window is reused), then bring its window forward.
// The server runs in the background, so Windows only flashes the taskbar unless the window is raised;
// a new window takes a moment to appear, so the raise is retried for a few seconds.
export async function openInVscode(project, raiseFolder, exe = codeExe, wait = ms => new Promise(r => setTimeout(r, ms)), launch = detached) {
  const code = await exe();
  if (!code) return { ok: false, reason: "VS Code's `code` command isn't on PATH" };
  const r = await launch(code, [project.path]);
  if (!r.ok) return r;
  return { ok: true, raised: await raiseWhenUp(() => raiseFolder(project.name), wait) };
}

// Open a file in the app its type is set to open with (the viewer's Open in default app). Callers pass a path from the
// knowledge index, never one from the browser. On Windows that's explorer.exe with the path as one quoted argument,
// passed verbatim: no cmd (`start`) ever parses it, so a name with & or ^ in it is just a name. `open` on macOS,
// `xdg-open` elsewhere. Nothing `.env` sets reaches the app. `drop` and `run` are for tests.
export function openFile(path, { platform = process.platform, run = spawn, drop = ENV_FILE_KEYS } = {}) {
  const win = platform === 'win32', exe = win ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise(resolve => {
    const child = run(exe, win ? [`"${path}"`] : [path],
      { detached: true, stdio: 'ignore', env: cleanEnv(process.env, drop), ...(win ? { windowsVerbatimArguments: true } : {}) });
    child.once('error', e => resolve({ ok: false, reason: e.code === 'ENOENT' ? `${exe} not found` : e.message }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}
