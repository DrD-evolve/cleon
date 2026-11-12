// Closing this machine's Claude Code sessions before a shutdown (Windows only). Each chosen session finishes its turn
// and then ends: an idle one at once, a busy one (any status but `idle`) once its session file says `idle`. Ending
// one is `taskkill /T /F` on the claude process, which takes the programs it started (MCP servers, background
// commands) with it and leaves the shell that hosted it at its prompt. Before a pid is ended, the process holding it
// must still be claude, started when the session file says (procStart): a pid Windows has handed to another program
// is never ended. Pids come only from the session files, never from the page.
import { execFile } from './bin.mjs'; // not node's: see lib/bin.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { excludesFolder } from './config.mjs';

export const SUPPORTED = process.platform === 'win32';

// Pure: the sessions offered: this machine's (a peer's row has `machine`), still running, in a folder MC_EXCLUDE
// doesn't keep out. One the VS Code extension runs (an entrypoint other than the CLI's) is listed but never ended:
// the extension, not a shell, hosts it. A VS Code terminal's session is a CLI one and is ended like any other.
export const closable = (sessions, exclude) => sessions
  .filter(s => !s.machine && s.alive && Number.isInteger(s.pid) && s.pid > 0 && !excludesFolder(s.cwd ?? '', exclude))
  .map(s => ({ id: s.id, pid: s.pid, procStart: s.procStart, name: s.name, cwd: s.cwd, status: s.status,
    where: s.entrypoint && s.entrypoint !== 'cli' ? 'vscode' : null }));

// A process's image name and start time as a FILETIME (Windows), or null when there's none or the lookup failed.
export const procInfo = pid => new Promise(resolve => { const t0 = performance.now(); execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p.Name; $p.CreationDate.ToFileTimeUtc() }`],
{ timeout: 10_000, windowsHide: true }, (err, out) => {
  if (process.env.DIAG_CLOSE) console.error(`DIAG procInfo pid=${pid} ms=${Math.round(performance.now() - t0)} err=${JSON.stringify(err && { m: err.message.slice(0, 80), code: err.code, killed: err.killed, signal: err.signal })} out=${JSON.stringify(out)}`);
  const [name, start] = (err ? '' : out).split(/\r?\n/).map(s => s.trim());
  resolve(name ? { name, start } : null);
}); });

// Pure: whether a process is the session's own: claude, started within a millisecond of procStart (Windows keeps the
// start in 100 ns units; the CIM lookup has microseconds, so the two differ in the last digit).
export function sameProcess(s, p) {
  if (!p || !/^claude(\.exe)?$/i.test(p.name ?? '')) return false;
  try {
    const d = BigInt(p.start) - BigInt(s.procStart);
    return (d < 0n ? -d : d) < 10_000n;
  } catch { return false; } // no procStart, or not a number
}

// End a process and every process it started.
export const endTree = pid => new Promise(resolve => execFile('taskkill', ['/PID', String(Number(pid)), '/T', '/F'],
  { timeout: 10_000, windowsHide: true },
  (err, _out, errOut) => resolve(err ? { ok: false, reason: (errOut || err.message || '').trim().split(/\r?\n/)[0] } : { ok: true })));

// Pure: the line that reopens a closed session, for a bash prompt. The folder is single-quoted, so a `$` or a backtick in
// its name is not expanded when the line is pasted.
export const reopenLine = s => `cd '${String(s.cwd).replaceAll("'", "'\\''")}' && claude --resume ${s.id}`;

// The sessions a close chose, saved before anything ends so they can be reopened after a restart. A close adds to the
// list (its sessions first, the earlier closes' after them, the newest REOPEN_MAX kept), so an earlier close's lines
// are still there after a reboot.
const REOPEN_MAX = 50;
export const readReopen = file => readFile(file, 'utf8').then(JSON.parse)
  .then(v => (v && Array.isArray(v.sessions) ? { at: v.at, sessions: v.sessions.map(s => ({ ...s, line: reopenLine(s) })) } : null), () => null);
export const writeReopen = async (file, sessions, now = Date.now()) => {
  const ids = new Set(sessions.map(s => s.id));
  const earlier = ((await readReopen(file))?.sessions ?? []).filter(s => !ids.has(s.id)).map(({ name, id, cwd }) => ({ name, id, cwd }));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ at: now, sessions: [...sessions, ...earlier].slice(0, REOPEN_MAX) }, null, 2));
};
// Pure: the reopen list without the sessions still running (a close that failed or hasn't ended them yet, or one
// reopened since): only the ones actually ended are offered as reopen lines.
export const notRunning = (reopen, running) => reopen && { ...reopen, sessions: reopen.sessions.filter(s => !running.some(r => r.id === s.id)) };

// One close at a time, kept in memory. `list()` reads the session files afresh; `info`, `kill` and `save` are
// lookups, taskkill and the reopen list (injected by the tests). Each row's `state`: waiting (busy; ended when idle),
// closing, closed or failed (`reason` says why).
export function closer({ list, exclude, save, info = procInfo, kill = endTree, every = 2000, setTimer = setTimeout }) {
  let rows = [], timer = null, ticking = false, starting = false;
  const end = async r => {
    r.state = 'closing';
    try {
      const p = await info(r.pid);
      if (!sameProcess(r, p)) {
        return Object.assign(r, { state: 'failed', reason: p ? 'its pid now belongs to another process; nothing was ended' : 'its process was not found' });
      }
      const k = await kill(r.pid);
      if (sameProcess(r, await info(r.pid))) return Object.assign(r, { state: 'failed', reason: k.reason || 'still running after taskkill' });
      return Object.assign(r, { state: 'closed', reason: null });
    } catch (e) { return Object.assign(r, { state: 'failed', reason: e.message }); }
  };
  const schedule = () => { if (!timer && !ticking && rows.some(r => r.state === 'waiting')) timer = setTimer(tick, every); };
  const tick = async () => {
    timer = null;
    ticking = true;
    try {
      const now = await list();
      for (const r of rows) {
        if (r.state !== 'waiting') continue; // Close now may have taken it meanwhile
        const s = now.find(x => x.id === r.id && x.pid === r.pid);
        if (!s?.alive) { Object.assign(r, { state: 'closed', reason: 'it ended on its own' }); continue; }
        r.status = s.status;
        if (s.status === 'idle') await end(r);
      }
    } catch { /* a torn read: try again next time */ }
    ticking = false;
    schedule();
  };
  // The close itself, once start() holds the slot.
  const begin = async ids => {
    const offered = closable(await list(), exclude);
    const picked = [...new Set(ids)].map(id => offered.find(s => s.id === id) ?? { id, missing: true });
    const ending = picked.filter(s => !s.missing && !s.where);
    if (!ending.length) return { ok: false, reason: 'none of those sessions can be closed here' };
    try { await save(ending.map(({ name, id, cwd }) => ({ name, id, cwd }))); } catch (e) {
      return { ok: false, reason: `the reopen list could not be saved, so nothing was ended (${e.message})` };
    }
    rows = picked.map(s => (s.missing ? { id: s.id, name: null, cwd: null, status: null, state: 'failed', reason: 'not a running session on this machine' }
      : s.where ? { ...s, state: 'failed', reason: 'close it in VS Code' } : { ...s, state: 'waiting', reason: null }));
    for (const r of rows) if (r.state === 'waiting' && r.status === 'idle') end(r);
    schedule();
    return { ok: true };
  };
  return {
    // `ids` are session ids from the page; each is looked up in the session files, and one that isn't offered here
    // is reported, never acted on.
    async start(ids) {
      if (starting || rows.some(r => r.state === 'waiting' || r.state === 'closing')) return { ok: false, reason: 'a close is still running' };
      starting = true; // held until `rows` is set: a second start meanwhile (another tab) is refused, not interleaved
      try { return await begin(ids); } finally { starting = false; }
    },
    // Close now: end a waiting session without waiting for idle.
    now(id) {
      const r = rows.find(x => x.id === id && x.state === 'waiting');
      if (!r) return { ok: false, reason: "that session isn't waiting" };
      end(r);
      return { ok: true };
    },
    state: () => rows.map(({ id, name, cwd, status, state, reason }) => ({ id, name, cwd, status, state, reason })),
  };
}
