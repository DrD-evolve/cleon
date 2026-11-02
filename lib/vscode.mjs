// Bring the VS Code window a terminal process runs in to the front. VS Code can't say which window
// owns a terminal (`code --status` hangs every window's terminals off one shared pty-host), but a
// window's title names its folder and a terminal's cwd is that folder or inside it. So the cwd's
// folder names, nearest first, are matched against open window titles by raise-window.py, which
// also gets past Windows' foreground lock. It only raises existing windows, never opens one.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
// The herdr client window (any terminal) whose title shows this workspace label.
export const raiseHerdrClient = (label, raise = raiseFirst) => raise(['--herdr', label]);
