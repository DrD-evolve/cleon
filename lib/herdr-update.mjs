// Keeping herdr up to date. herdr checks for a new version itself and keeps what it found in
// release-notes.json, next to its default session's socket; Cleon reads that file, so it makes no update
// check of its own. Updating restarts herdr's servers, which interrupts whatever their panes are doing, so
// it's only done at a pause. Dependencies are injectable for tests.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { herdrWindowClass } from './open.mjs';

// herdr, with its output as text (`status --json` and `update` aren't API replies).
export const herdrExec = (args, timeout = 8000) => new Promise(resolve =>
  execFile('herdr', args, { timeout, windowsHide: true, maxBuffer: 4e6 },
    (err, out, errOut) => resolve({ ok: !err, out: out ?? '', err: (errOut || err?.message || '').trim() })));
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pure: is version `a` newer than `b`? Compares the leading x.y.z; an unreadable version is never newer.
export function newer(a, b) {
  const v = s => String(s ?? '').match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const x = v(a), y = v(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The installed herdr, the newest version herdr's own check found (with its notes), and each running
// server's version. `behind` names the servers older than the installed herdr: they keep running the old
// version until they're restarted.
export async function herdrVersions(run = herdrExec, read = p => readFile(p, 'utf8')) {
  const me = parse((await run(['status', '--json'])).out);
  if (!me?.client?.version) return { installed: null, reason: 'herdr not installed' };
  const found = me.server?.socket ? parse(await read(join(dirname(me.server.socket), 'release-notes.json')).catch(() => null)) : null;
  const sessions = parse((await run(['session', 'list', '--json'])).out)?.sessions ?? [];
  const servers = await Promise.all(sessions.filter(s => s.running).map(async s =>
    ({ session: s.name, version: parse((await run(['--session', s.name, 'status', '--json'])).out)?.server?.version ?? null })));
  const installed = me.client.version, latest = found?.version ?? null, update = newer(latest, installed);
  return { installed, channel: me.client.channel ?? null, latest, update, notes: update ? String(found.body ?? '') : null,
    servers, behind: servers.filter(s => newer(installed, s.version)).map(s => s.session) };
}

// Pure: is it a pause, where restarting herdr's servers interrupts nothing? Not while a herdr agent is
// working or waiting on a question, nor while an orchestrator is live with tickets not yet merged: an idle
// orchestrator may be waiting on a merge watcher, which a restart would end. `why` says what's still running.
export function pauseState(snap, orchestrators, runs) {
  const why = [];
  for (const a of snap?.online ? snap.agents : []) {
    if (a.agent_status !== 'working' && a.agent_status !== 'blocked') continue;
    const w = snap.workspaces.find(w => w.session === a.session && w.workspace_id === a.workspace_id);
    why.push(`${w?.label || a.workspace_id} (${a.session}): ${a.agent || 'an agent'} is ${a.agent_status}`);
  }
  for (const epic of new Set(orchestrators.map(o => o.epic))) {
    const tickets = runs.filter(r => r.epic === epic).flatMap(r => r.tickets);
    const open = new Set(tickets.filter(t => t.step !== 'done').map(t => t.ticket)).size;
    if (!tickets.length || open) why.push(`the ${epic} orchestrator is running${open ? ` (${open} ticket${open > 1 ? 's' : ''} open)` : ''}`);
  }
  return { ok: !why.length, why };
}

// Restart one herdr server on the installed version. herdr restores the session's workspaces and resumes
// its Claude panes. A window Cleon opened on the session drops to a bash prompt when its server stops, so
// it's closed, and a new one is attached in the same place once the server is back.
export async function restartServer(session, { run = herdrExec, cwd, serve, closeWindows, attach, place, wait = sleep }) {
  // Unreadable status counts as still running, so a failed check never leads to closing windows.
  const running = async () => parse((await run(['--session', session, 'status', '--json'])).out)?.server?.running !== false;
  const stop = await run(['--session', session, 'server', 'stop'], 30_000);
  let up = true;
  for (let i = 0; i < 40 && (up = await running()); i++) await wait(500);
  if (up) return { ok: false, session, reason: `the ${session} server didn't stop${stop.err ? `: ${stop.err.split('\n').pop()}` : ''}` };
  const placements = await closeWindows(herdrWindowClass(session));
  const s = await serve(session, cwd);
  if (!s.ok) return { ok: false, session, reason: `the ${session} server stopped but didn't start again: ${s.reason}` };
  let back = false;
  for (let i = 0; i < 40 && !(back = Boolean(parse((await run(['--session', session, 'api', 'snapshot'])).out)?.result)); i++) await wait(500);
  if (!back) return { ok: false, session, reason: `herdr session ${session} didn't come back` };
  let windows = 0;
  for (const [k, at] of placements.entries()) {
    const id = Date.now() + k, a = await attach(session, cwd, id);
    if (a.ok) { windows++; await place(`${herdrWindowClass(session)}${id}`, at); }
  }
  return { ok: true, session, windows };
}

// Bring herdr up to date: at a pause, install the version herdr's own check found (`herdr update`), then
// restart every running server older than the installed herdr. Nothing is restarted if the update didn't
// install, and the pause is checked again before the restarts, since an update can take a while.
export async function bringUpToDate({ versions, pause, update, restart }) {
  const p = await pause();
  if (!p.ok) return { ok: false, reason: `Not a pause: ${p.why.join('; ')}` };
  let v = await versions();
  if (!v.installed) return { ok: false, reason: v.reason };
  const from = v.installed;
  if (v.update) {
    const u = await update();
    v = await versions();
    if (!v.installed || newer(v.latest, v.installed))
      return { ok: false, reason: `herdr update didn't install ${v.latest ?? 'the new version'}${u.err ? `: ${u.err.split('\n').pop()}` : ''}` };
  }
  const done = { from, to: v.installed, restarted: [], failed: [], pending: [] };
  if (!v.behind.length) return { ok: true, ...done };
  const p2 = await pause();
  if (!p2.ok) return { ok: true, ...done, pending: v.behind, reason: `Servers not restarted, no longer a pause: ${p2.why.join('; ')}` };
  for (const session of v.behind) {
    const r = await restart(session);
    if (r.ok) done.restarted.push({ session, windows: r.windows }); else done.failed.push({ session, reason: r.reason });
  }
  return { ok: !done.failed.length, ...done, ...(done.failed.length ? { reason: done.failed.map(f => f.reason).join('; ') } : {}) };
}
