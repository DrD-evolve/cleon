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

// Focus the herdr pane already in the project's folder (an agent pane directly; a shell pane by its
// tab). Otherwise open Windows Terminal in the folder running `herdr session attach <name>`, which
// creates the session if it doesn't exist; a brand-new session gets Claude Code started in it.
// `raiseClient(label)` raises the herdr window showing that workspace (its title ends ": <label>");
// `raise(session, agents)` is the fallback for herdr inside a VS Code terminal.
export async function openInHerdr(project, { snapshot, run, raise, raiseClient, launch = detached, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const snap = await snapshot();
  const pane = findPane(project, snap);
  if (pane) {
    const agent = snap.agents.some(a => a.session === pane.session && a.pane_id === pane.pane_id);
    const r = await run(['--session', pane.session, ...(agent ? ['agent', 'focus', pane.pane_id] : ['tab', 'focus', pane.tab_id])]);
    if (r.error) return { ok: false, reason: r.error.message };
    const label = snap.workspaces.find(w => w.session === pane.session && w.workspace_id === pane.workspace_id)?.label;
    return { ok: true, created: false, session: pane.session, raised: (label && await raiseClient(label)) || await raise(pane.session, snap.agents) };
  }
  const name = sessionName(project.name);
  const existed = ((await run(['session', 'list', '--json'])).sessions ?? []).some(s => s.name === name);
  const r = await launch('wt.exe', ['-d', project.path, 'herdr', 'session', 'attach', name]);
  if (!r.ok) return r;
  // The new window's title shows the session's focused workspace; raise it once it's up.
  const raiseNew = async () => {
    const ws = (await run(['--session', name, 'api', 'snapshot'])).result?.snapshot?.workspaces ?? [];
    const label = (ws.find(w => w.focused) ?? ws[0])?.label;
    return label ? raiseClient(label) : null;
  };
  if (existed) return { ok: true, created: false, attached: true, session: name, raised: await raiseWhenUp(raiseNew, wait) };
  // Wait for the new session's first pane, then start Claude in it.
  let claude = false;
  for (let i = 0; i < 20; i++) {
    await wait(500);
    const first = (await run(['--session', name, 'api', 'snapshot'])).result?.snapshot?.panes?.[0];
    if (!first) continue;
    claude = !(await run(['--session', name, 'pane', 'run', first.pane_id, 'claude'])).error;
    break;
  }
  return { ok: true, created: true, session: name, claude, raised: await raiseWhenUp(raiseNew, wait) };
}

const detached = (exe, args, env = process.env) => new Promise(resolve => {
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

// Git Bash in the project's folder, running Claude Code (a login shell stays open after it exits):
// Git's mintty running a login bash, as git-bash.exe does. (Launched from a background server,
// git-bash.exe itself exits without opening a window.) MSYSTEM picks Git's MINGW64 environment;
// CHERE_INVOKING stops the login profile from cd-ing to ~. The window gets its own class so it can be
// found and raised whatever title Claude gives it.
export async function openInBash(project, gitDir, { launch = detached, raiseClass, wait = ms => new Promise(r => setTimeout(r, ms)), id = Date.now() } = {}) {
  const cls = `cleon-bash-${sessionName(project.name)}-${id}`;
  const r = await launch(join(gitDir, 'usr', 'bin', 'mintty.exe'),
    ['--class', cls, '--dir', project.path, '/usr/bin/bash', '--login', '-i', '-c', 'claude; exec bash --login -i'],
    { ...process.env, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' });
  if (!r.ok) return r;
  return { ok: true, raised: await raiseWhenUp(() => raiseClass(cls), wait) ? project.name : null };
}

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
