// Open a project folder in herdr, Git Bash or VS Code (the project map's buttons). Callers pass a
// project from listProjects(), never a path from the browser. Dependencies are injectable for tests.
import { spawn, execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

const norm = p => (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (cwd, dir) => norm(cwd) === norm(dir) || norm(cwd).startsWith(`${norm(dir)}/`);

// Pure: the herdr workspace already working in a project's folder, or null. A workspace labelled
// with the project's name wins; otherwise the first one with a pane in the folder.
export function findWorkspace(project, snap) {
  const hits = (snap.panes ?? []).filter(p => inside(p.cwd, project.path))
    .map(p => snap.workspaces.find(w => w.session === p.session && w.workspace_id === p.workspace_id)).filter(Boolean);
  return hits.find(w => w.label === project.name) ?? hits[0] ?? null;
}

// Focus the project's workspace, or create one (labelled with the project's name) in the configured
// session, or the first running one, and start Claude Code in it.
export async function openInHerdr(project, { snapshot, run, raise, session }) {
  const snap = await snapshot();
  if (!snap.online) return { ok: false, reason: snap.reason };
  const found = findWorkspace(project, snap);
  if (found) {
    const r = await run(['--session', found.session, 'workspace', 'focus', found.workspace_id]);
    if (r.error) return { ok: false, reason: r.error.message };
    return { ok: true, created: false, session: found.session, workspace: found.label ?? found.workspace_id, raised: await raise(found.session, snap.agents) };
  }
  if (session && !snap.sessions.includes(session)) return { ok: false, reason: `herdr session "${session}" isn't running` };
  const target = session ?? snap.sessions[0];
  const r = await run(['--session', target, 'workspace', 'create', '--cwd', project.path, '--label', project.name, '--focus']);
  const pane = r.result?.root_pane?.pane_id;
  if (!pane) return { ok: false, reason: r.error?.message ?? "herdr didn't create the workspace" };
  const started = await run(['--session', target, 'pane', 'run', pane, 'claude']);
  return { ok: true, created: true, session: target, workspace: project.name, claude: !started.error, raised: await raise(target, snap.agents) };
}

const detached = (exe, args, env = process.env) => new Promise(resolve => {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
  child.once('error', e => resolve({ ok: false, reason: e.code === 'ENOENT' ? `${exe} not found` : e.message }));
  child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
});

// Git Bash in the project's folder: Git's mintty running a login bash, as git-bash.exe does. (Launched
// from a background server, git-bash.exe itself exits without opening a window.) MSYSTEM picks Git's
// MINGW64 environment; CHERE_INVOKING stops the login profile from cd-ing to ~.
export const openInBash = (project, gitDir, launch = detached) => launch(join(gitDir, 'usr', 'bin', 'mintty.exe'),
  ['--dir', project.path, '/usr/bin/bash', '--login', '-i'], { ...process.env, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1' });

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
  for (let i = 0; i < 8; i++) {
    await wait(i ? 750 : 400);
    const raised = await raiseFolder(project.name);
    if (raised) return { ok: true, raised };
  }
  return { ok: true, raised: null };
}
