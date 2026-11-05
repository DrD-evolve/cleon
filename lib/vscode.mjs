// Bring the VS Code window a terminal process runs in to the front. VS Code can't say which window
// owns a terminal (`code --status` hangs every window's terminals off one shared pty-host), but a
// window's title names its folder and a terminal's cwd is that folder or inside it. So the cwd's
// folder names, nearest first, are matched against open window titles by raise-window.py, which
// also gets past Windows' foreground lock. It only raises existing windows, never opens one.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { herdrWindowClass } from './open.mjs';

const RAISE = fileURLToPath(new URL('./raise-window.py', import.meta.url));

// Resolves to the folder whose window was raised, or null.
const raiseFirst = folders => !folders.length ? Promise.resolve(null) : new Promise(resolve =>
  execFile('python', ['-I', RAISE, ...folders], { timeout: 5000, windowsHide: true },
    (err, out) => resolve(err ? null : out.trim() || null)));

// Pure: folder names to try for some working directories — every path's own folder first, then
// each one's parent, and so on (a terminal may have cd'd below the window's folder).
export function folderCandidates(paths) {
  const chains = paths.map(p => p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(s => s && !s.endsWith(':')).reverse());
  const out = [];
  for (let level = 0; chains.some(c => level < c.length); level++) {
    for (const c of chains) if (c[level] && !out.includes(c[level])) out.push(c[level]);
  }
  return out;
}

// herdr runs inside a VS Code terminal; its agents' cwds point at that window's folder.
export const raiseHerdrWindow = (session, agents, raise = raiseFirst) =>
  raise(folderCandidates(agents.filter(a => a.session === session && a.cwd).map(a => a.cwd)));
export const raiseCwdWindow = (cwd, raise = raiseFirst) => raise(folderCandidates([cwd]));
// The window whose title names exactly this folder (the project map's "open in VS Code").
export const raiseFolderWindow = (name, raise = raiseFirst) => raise([name]);
// A window by its class name, or the start of it (the Git Bash windows the project map opens get their own).
export const raiseClassWindow = (cls, raise = raiseFirst) => raise(['--class', cls]);
// The herdr window (any terminal) showing this workspace: herdr titles it "<host>: <label>".
export const raiseHerdrClient = (label, raise = raiseFirst) => raise(['--herdr', label]);
// Pure: the Windows pid of the mintty (Git Bash) window a process runs in, from Git Bash's `ps -W`, or null.
// Windows' own parent chain breaks inside Git Bash (each exec is a new Windows process whose parent has
// gone), but Git Bash's process table keeps the real parents. Columns: PID PPID PGID WINPID TTY UID STIME COMMAND.
export function minttyFor(psOut, winpid) {
  const rows = (psOut ?? '').split('\n').map(l => l.match(/^\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s+\S+\s+\d+\s+(?:[A-Z][a-z]{2}\s+\d+|\S+)\s+(.*?)\s*$/))
    .filter(Boolean).map(([, pid, ppid, win, cmd]) => ({ pid: +pid, ppid: +ppid, win: +win, cmd }));
  const byPid = new Map(rows.map(r => [r.pid, r]));
  let r = rows.find(r => r.win === winpid);
  for (let i = 0; r && i < 32; i++, r = r.ppid > 1 ? byPid.get(r.ppid) : null) if (/\/mintty(\.exe)?$/.test(r.cmd)) return r.win;
  return null;
}
const psW = gitDir => new Promise(resolve =>
  execFile(`${gitDir}/usr/bin/ps.exe`, ['-W'], { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? '' : out)));
// The terminal window a process runs in: through its Windows parents (Windows Terminal, or anything
// started outside Git Bash), else through Git Bash's process table to its mintty window.
export async function raisePidWindow(pid, { gitDir, raise = raiseFirst, ps = psW } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const direct = await raise(['--pid', String(pid)]);
  if (direct || !gitDir) return direct;
  const mintty = minttyFor(await ps(gitDir), pid);
  return mintty ? raise(['--pid', String(mintty)]) : null;
}
// Cleon's own windows of one class base (`<base><digits>`): close them all, resolving to where each sat
// ([show, left, top, right, bottom], [] when none); then put a new window (its exact class) in one of those places.
const helper = args => new Promise(resolve =>
  execFile('python', ['-I', RAISE, ...args], { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? null : out)));
export const closeClassWindows = async (base, run = helper) => { try { return JSON.parse(await run(['--close', base])) ?? []; } catch { return []; } };
export const placeClassWindow = async (cls, at, run = helper) => Array.isArray(at) && at.length === 5 && at.every(Number.isInteger)
  && (await run(['--place', cls, ...at.map(String)])) !== null;
// A herdr session's window wherever herdr runs: the Git Bash window Cleon opened for it (its class), any
// other herdr window showing this workspace, else the VS Code window its agents' folders point at.
export const raiseHerdrAnywhere = async (session, agents, label, raise = raiseFirst) =>
  await raiseClassWindow(herdrWindowClass(session), raise) || (label && await raiseHerdrClient(label, raise))
  || await raiseHerdrWindow(session, agents, raise);
