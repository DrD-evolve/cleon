// What Cleon is doing, for the Activity panel: each program it starts, each web request it makes, each
// request from the page and each Claude session check, kept for the last five minutes, plus the
// server's own CPU, memory and event-loop delay every 2 s.
// Programs, web requests and page requests come from Node's built-in diagnostics channels, so the
// modules that make them report nothing themselves. A session check (a file read and a pid probe) is
// invisible to those, so sessions.mjs and orchestrators.mjs call note(). The page request being served
// is carried through its async calls (AsyncLocalStorage), so each call records which endpoint asked.
// Request headers are never read, so no token reaches the feed.
import dc from 'node:diagnostics_channel';
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BITBUCKET_URL, EXCLUDE, excludesFolder } from './config.mjs';

export const KEEP_MS = 5 * 60_000;
export const asking = new AsyncLocalStorage(); // { route } of the page request being served
const route = () => asking.getStore()?.route ?? null;

const exeName = f => basename(String(f ?? '')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
const clip = (s, n = 100) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const without = (a, i) => (i >= 0 ? a.filter((_, j) => j !== i && j !== i + 1) : a);

// Pure: what a program Cleon started checks → { node, what }. `node` is what it talks to: the repos
// (git), one herdr session, GitHub (gh), Docker, Windows itself (process stats, window raising).
// A folder matching MC_EXCLUDE is never named.
export function classifyProcess(file, args = [], exclude = EXCLUDE) {
  const exe = exeName(file), a = args.map(String);
  if (exe === 'git') {
    const c = a.indexOf('-C'), dir = c >= 0 ? a[c + 1] : null;
    const where = dir ? `${excludesFolder(dir, exclude) ? '(excluded folder)' : basename(dir)} · ` : '';
    return { node: 'git', what: clip(`${where}git ${without(a, c).join(' ')}`) };
  }
  if (exe === 'herdr') {
    const s = a.indexOf('--session');
    return { node: s >= 0 ? `herdr:${a[s + 1]}` : 'herdr', what: clip(`herdr ${without(a, s).join(' ')}`) };
  }
  if (exe === 'gh') return { node: 'github', what: clip(`gh ${a.slice(0, 3).join(' ')}`) };
  if (exe === 'docker') return { node: 'docker', what: clip(`docker ${a.join(' ')}`) };
  if (['tasklist', 'typeperf', 'nvidia-smi', 'ps'].includes(exe)) return { node: 'windows', what: clip(`${exe} ${a.join(' ')}`) };
  if (exe === 'python' || exe === 'py') {
    const i = a.findIndex(x => /\.py$/i.test(x));
    return { node: 'windows', what: clip(i >= 0 ? [basename(a[i]), ...a.slice(i + 1)].join(' ') : `python ${a.join(' ')}`) };
  }
  if (exe === 'where' || exe === 'code') return { node: 'vscode', what: clip(`${exe} ${a.join(' ')}`) };
  if (exe === 'mintty') return { node: 'terminal', what: 'open a Git Bash window' };
  return { node: exe || 'program', what: clip(`${exe} ${a.join(' ')}`) };
}

// Pure: what a web request goes to → { node, what }. Only the path is kept, never the query.
export function classifyRequest(origin, path = '', bitbucket = BITBUCKET_URL) {
  let host;
  try { host = new URL(origin).host; } catch { host = String(origin); }
  const what = clip(String(path).split('?')[0]);
  if (host === 'api.linear.app') return { node: 'linear', what: 'Linear GraphQL' };
  if (bitbucket && host === (() => { try { return new URL(bitbucket).host; } catch { return null; } })()) return { node: 'bitbucket', what };
  if (/^(127\.0\.0\.1|localhost):11434$/.test(host)) return { node: 'ollama', what };
  if (host === 'api.github.com') return { node: 'github', what };
  return { node: `web:${host}`, what };
}

// The Claude session a transcript belongs to: <id>.jsonl, or <id>/subagents/agent-*.jsonl.
export const transcriptSession = path => (basename(dirname(path)) === 'subagents'
  ? basename(dirname(dirname(path))) : basename(path, '.jsonl'));

// The event log. Each event is { id, rev, at, ms, node, kind, what, route, result, why, cached };
// ms is null while it runs. `rev` grows on every start and finish, so a reader asks for what changed
// since the last rev it saw.
export function createRecorder(now = Date.now) {
  let events = [], id = 0, rev = 0;
  const counts = { program: 0, web: 0, page: 0, session: 0 };
  return {
    start(e) {
      const ev = { id: ++id, rev: ++rev, at: now(), ms: null, route: null, result: null, ...e };
      events.push(ev);
      counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
      if (events.length > 50_000) events = events.filter(x => x.ms == null).concat(events.filter(x => x.ms != null).slice(-40_000));
      return ev;
    },
    finish(ev, done = {}) {
      if (ev.ms != null) return;
      Object.assign(ev, { result: 'ok', ...done, ms: Math.max(0, now() - ev.at), rev: ++rev });
    },
    // A finished check, recorded in one go.
    note(e, at) { const ev = this.start(e); ev.at = at ?? ev.at; this.finish(ev, { result: e.result ?? 'ok' }); return ev; },
    // Drop what finished before the window; anything still running stays.
    trim() { const cut = now() - KEEP_MS; events = events.filter(e => e.ms == null || e.at >= cut); },
    since: r => events.filter(e => e.rev > r),
    recent: ms => { const cut = now() - ms; return events.filter(e => e.ms == null || e.at >= cut); },
    takeCounts() { const c = { ...counts }; for (const k in counts) counts[k] = 0; return c; },
    get events() { return events; },
    get rev() { return rev; },
  };
}

// Pure: per-node totals over the events → { [node]: { calls, running, ok, no, fail, cached, avgMs,
// maxMs, last, routes: { route: n } } }. A route of null is background work (no page request).
export function summarize(events) {
  const out = {};
  for (const e of events) {
    const n = out[e.node] ??= { calls: 0, running: 0, ok: 0, no: 0, fail: 0, cached: 0, totalMs: 0, done: 0, maxMs: 0, last: 0, routes: {} };
    n.calls++;
    n.last = Math.max(n.last, e.at);
    if (e.ms == null) n.running++;
    else { n.done++; n.totalMs += e.ms; n.maxMs = Math.max(n.maxMs, e.ms); n[e.result] = (n[e.result] ?? 0) + 1; }
    if (e.cached) n.cached++;
    const r = e.route ?? 'background';
    n.routes[r] = (n.routes[r] ?? 0) + 1;
  }
  for (const n of Object.values(out)) { n.avgMs = n.done ? n.totalMs / n.done : null; delete n.totalMs; delete n.done; }
  return out;
}

export const recorder = createRecorder();

// A session check made without a program or web request (a file read, a pid probe).
export const note = (e, at) => recorder.note({ kind: 'session', route: route(), ...e }, at);

dc.subscribe('child_process', ({ process: child }) => {
  // Published before the program is created, so the start time includes Windows' process start-up.
  const ev = recorder.start({ kind: 'program', node: 'program', what: '', route: route() });
  // Its file and arguments are set once spawn() returns, before any microtask runs.
  queueMicrotask(() => Object.assign(ev, classifyProcess(child.spawnfile, (child.spawnargs ?? []).slice(1))));
  child.once('exit', (code, signal) => recorder.finish(ev, signal ? { result: 'fail', why: `stopped (${signal})` }
    : { result: code === 0 ? 'ok' : 'no', why: code ? `exit ${code}` : null }));
  child.once('error', e => recorder.finish(ev, { result: 'fail', why: e.code ?? e.message }));
});

const web = new WeakMap();
dc.subscribe('undici:request:create', ({ request }) =>
  web.set(request, recorder.start({ kind: 'web', route: route(), ...classifyRequest(request.origin, request.path) })));
dc.subscribe('undici:request:headers', ({ request, response }) => { const ev = web.get(request); if (ev) ev.status = response.statusCode; });
dc.subscribe('undici:request:trailers', ({ request }) => {
  const ev = web.get(request);
  if (ev) recorder.finish(ev, { result: ev.status >= 500 ? 'fail' : ev.status >= 400 ? 'no' : 'ok', why: ev.status >= 400 ? `HTTP ${ev.status}` : null });
});
dc.subscribe('undici:request:error', ({ request, error }) => { const ev = web.get(request); if (ev) recorder.finish(ev, { result: 'fail', why: error?.message ?? 'failed' }); });

// The page's own requests to the API (the Activity panel's polling is left out).
dc.subscribe('http.server.request.start', ({ request, response }) => {
  const path = String(request.url).split('?')[0];
  if (!path.startsWith('/api/') || path === '/api/activity') return;
  const ev = recorder.start({ kind: 'page', node: 'page', what: `${request.method} ${path}`, route: path });
  response.once('close', () => recorder.finish(ev, response.statusCode >= 400
    ? { result: response.statusCode >= 500 ? 'fail' : 'no', why: `HTTP ${response.statusCode}` } : { result: 'ok' }));
});

// The server's own CPU (% of one core), memory, longest event-loop delay and starts per kind, every 2 s.
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const samples = [];
let prev = { at: Date.now(), cpu: process.cpuUsage() };
setInterval(() => {
  const at = Date.now(), cpu = process.cpuUsage(), mem = process.memoryUsage();
  samples.push({ at, cpu: (cpu.user - prev.cpu.user + cpu.system - prev.cpu.system) / 10 / Math.max(1, at - prev.at),
    rss: mem.rss, heap: mem.heapUsed, lag: loop.max / 1e6, ...recorder.takeCounts() });
  if (samples.length > KEEP_MS / 2000) samples.shift();
  loop.reset();
  prev = { at, cpu };
  recorder.trim();
}, 2000).unref();

// Bytes the server has read and written (files and pipes; Windows' I/O counters), read at most every
// 10 s and only while the panel asks.
const PROC_STATS = fileURLToPath(new URL('./proc-stats.py', import.meta.url));
const io = [];
let ioAt = 0;
function readIo() {
  if (process.platform !== 'win32' || Date.now() - ioAt < 10_000) return;
  ioAt = Date.now();
  execFile('python', ['-I', PROC_STATS, '--io', String(process.pid)], { timeout: 5000, windowsHide: true }, (err, out) => {
    try { const j = JSON.parse(out); if (j) { io.push({ at: Date.now(), read: j.read, write: j.write }); if (io.length > 40) io.shift(); } } catch { /* no reading this time */ }
  });
}

// What the Activity panel asks for: events changed since `rev` (a first ask, rev 0, gets the last 30 s
// and anything still running), per-node totals over the window (`from` is its oldest event), and
// samples newer than `at`.
export function activity(rev = 0, at = 0) {
  const events = rev > 0 ? recorder.since(rev).slice(-5000) : recorder.recent(30_000);
  const out = { now: Date.now(), pid: process.pid, rev: recorder.rev, from: recorder.events[0]?.at ?? Date.now(), events,
    nodes: summarize(recorder.events), samples: samples.filter(s => s.at > at), io: [...io] };
  readIo(); // after the answer is built: the program it starts is only named once spawn() has returned
  return out;
}
