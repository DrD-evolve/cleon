// Open a project folder in herdr, Git Bash or VS Code (the project map's buttons). Callers pass a
// project from listProjects(), never a path from the browser. Dependencies are injectable for tests.
import { spawn, execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

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
// from. Inherited, they make a Claude started in the new window think it's a child session (it then
// saves no transcript) and point it at the parent's messaging socket. User settings such as
// CLAUDE_CONFIG_DIR or CLAUDE_CODE_GIT_BASH_PATH are kept.
const SESSION_MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PLUGIN_(DATA|ROOT)|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|BRIDGE_SESSION_ID|ENTRYPOINT|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED)|CODEX_COMPANION_\w+)$/i;
export const cleanEnv = env => Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_MARKERS.test(k)));

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
// MSYSTEM for Git's MINGW64 environment, CHERE_INVOKING so a login profile doesn't cd to ~. (Launched
// from a background server, git-bash.exe itself exits without opening a window, so mintty is run
// directly.) The window gets its own class, `<base><id>`, so it can be found and raised whatever title
// it shows.
async function openTerminal(project, gitDir, base, args, { launch = detached, raiseClass, wait = sleep, id = Date.now() }) {
  const cls = `${base}${id}`;
  const r = await launch(join(gitDir, 'usr', 'bin', 'mintty.exe'),
    ['--class', cls, '--icon', join(gitDir, 'mingw64', 'share', 'git', 'git-for-windows.ico'), '--dir', project.path, ...args],
    { ...cleanEnv(process.env), MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' });
  if (!r.ok) return r;
  return { ok: true, raised: await raiseWhenUp(() => raiseClass(cls), wait) ? project.name : null };
}

// Focus the herdr pane already in the project's folder (an agent pane directly; a shell pane by its
// tab), then raise the window that shows it: `raiseClient(label)` finds a herdr window by the workspace in
// its title ("<host>: <label>"), `raise(session, agents)` the VS Code window when herdr runs in its
// terminal. A session keeps running after its window is closed, so when no window shows it, attach one,
// which shows the pane just focused.
// With no pane in the folder, open Windows Terminal there running `herdr session attach <name>`, which
// creates the session if it doesn't exist; a brand-new session gets Claude Code started in it.
// `profile` names the Windows Terminal profile to open with: given a command, Windows Terminal drops the
// default profile's icon (the tab shows a plain console icon), but keeps a named one's.
// Windows Terminal, not Git's mintty: herdr is a Windows console program, and a session started inside
// mintty (with ConPTY) loses all its panes when that window is closed.
export async function openInHerdr(project, { snapshot, run, raise, raiseClient, profile, launch = detached, wait = sleep }) {
  const openWindow = session => launch('wt.exe', [...(profile ? ['-p', profile] : []), '-d', project.path, 'herdr', 'session', 'attach', session]);
  // Raise the session's window once herdr has titled it with the focused workspace.
  const raiseSession = session => raiseWhenUp(async () => {
    const ws = (await run(['--session', session, 'api', 'snapshot'])).result?.snapshot?.workspaces ?? [];
    const label = (ws.find(w => w.focused) ?? ws[0])?.label;
    return label ? raiseClient(label) : null;
  }, wait);
  const attach = async session => {
    const r = await openWindow(session);
    return r.ok ? { ok: true, created: false, attached: true, session, raised: await raiseSession(session) } : r;
  };
  const snap = await snapshot();
  const pane = findPane(project, snap);
  if (pane) {
    const agent = snap.agents.some(a => a.session === pane.session && a.pane_id === pane.pane_id);
    const r = await run(['--session', pane.session, ...(agent ? ['agent', 'focus', pane.pane_id] : ['tab', 'focus', pane.tab_id])]);
    if (r.error) return { ok: false, reason: r.error.message };
    const label = snap.workspaces.find(w => w.session === pane.session && w.workspace_id === pane.workspace_id)?.label;
    const shown = (label && await raiseClient(label)) || await raise(pane.session, snap.agents);
    return shown ? { ok: true, created: false, session: pane.session, raised: shown } : attach(pane.session);
  }
  const name = sessionName(project.name);
  if (((await run(['session', 'list', '--json'])).sessions ?? []).some(s => s.name === name)) return attach(name);
  const r = await openWindow(name);
  if (!r.ok) return r;
  // Wait for the new session's first pane, then start Claude in it.
  let claude = false;
  for (let i = 0; i < 20; i++) {
    const first = (await run(['--session', name, 'api', 'snapshot'])).result?.snapshot?.panes?.[0];
    if (first) { claude = !(await run(['--session', name, 'pane', 'run', first.pane_id, 'claude'])).error; break; }
    await wait(500);
  }
  return { ok: true, created: true, session: name, claude, raised: await raiseSession(name) };
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
