// Bring the VS Code window that hosts a herdr session to the front. herdr runs in a VS Code
// integrated terminal; `code --status` shows which window's process tree holds
// `herdr session attach <name>`; that window's title names its folder, and raise-window.py brings
// the window with that title forward. It only ever raises an existing window, never opens one.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// code.cmd is a batch file, which Node can't execFile without a shell. Do what it does instead:
// run Code.exe on the (versioned) cli.js with ELECTRON_RUN_AS_NODE — no shell, no quoting.
async function codeCli() {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    const cmd = join(dir, 'code.cmd');
    const text = await readFile(cmd, 'utf8').catch(() => null);
    const rel = text?.match(/"%~dp0\.\.\\([^"]+cli\.js)"/)?.[1];
    if (rel) return { exe: join(dir, '..', 'Code.exe'), cli: join(dir, '..', rel) };
  }
  return null;
}

async function code(args) {
  const c = await codeCli();
  if (!c) return null;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.VSCODE_DEV;
  return new Promise(resolve => execFile(c.exe, [c.cli, ...args], { env, timeout: 30000, windowsHide: true, maxBuffer: 20e6 },
    (err, out) => resolve(err ? null : out)));
}

// Pure: map each herdr session attached inside a VS Code window to that window's folder name.
// Window titles read "<editor> - <folder> - Visual Studio Code" or "<folder> - Visual Studio Code".
export function herdrWindows(status) {
  const out = new Map();
  let folder = null;
  for (const line of status.split(/\r?\n/)) {
    const w = line.match(/^\s*\d+\s+\d+\s+\d+\s+window \[\d+\] \((.*)\)\s*$/);
    if (w) { folder = w[1].split(' - ').at(-2) ?? null; continue; }
    if (/^Workspace Stats/.test(line)) folder = null;
    const h = line.match(/^\s*\d+\s+\d+\s+\d+\s+.*herdr(?:\.exe)?"?\s+session attach (\S+)\s*$/);
    if (h && folder) out.set(h[1], folder);
  }
  return out;
}

// `code <folder>` only flashes the taskbar when the request comes from a background process
// (Windows' foreground lock), so raise-window.py does it with Win32 calls instead.
const RAISE = fileURLToPath(new URL('./raise-window.py', import.meta.url));
const raiseByFolder = folder => new Promise(resolve =>
  execFile('python', ['-I', RAISE, folder], { timeout: 5000, windowsHide: true }, err => resolve(!err)));

// `code --status` takes a few seconds, so the session → window mapping is cached.
let cache = { at: 0, map: new Map() };
export async function raiseHerdrWindow(session, run = code, raise = raiseByFolder) {
  if (Date.now() - cache.at > 5 * 60_000 || !cache.map.has(session)) {
    const status = await run(['--status']);
    if (status) cache = { at: Date.now(), map: herdrWindows(status) };
  }
  const name = cache.map.get(session);
  return name && await raise(name) ? name : null;
}
