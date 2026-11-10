// Starting a program holds up the thread that starts it while Windows creates the process: measured at
// 100–400 ms a start inside the server while the page's pollers run (herdr every 5 s, once per running session,
// and two gits per repo every 30 s), so every route stalled for up to ~0.9 s every few seconds. Programs
// are started from a worker thread instead, which leaves the server's own thread free to answer.
import { Worker, SHARE_ENV } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import dc from 'node:diagnostics_channel';

const WORKER = `
const { parentPort } = require('node:worker_threads');
const { execFile, spawn } = require('node:child_process');
const live = new Map(); // id → a long-lived child (spawn), until it closes
const streamed = ({ id, file, args, opts }) => {
  const post = (ev, ...a) => parentPort.postMessage({ id, ev, a });
  let child;
  try { child = spawn(file, args, opts); }
  catch (e) { post('error', { message: e.message, code: e.code }); return post('close', null, null); }
  live.set(id, child);
  child.once('spawn', () => post('spawn', child.pid));
  for (const s of ['stdout', 'stderr']) child[s]?.setEncoding('utf8').on('data', d => post(s, d));
  child.on('error', e => post('error', { message: e.message, code: e.code }));
  child.once('exit', (code, signal) => post('exit', code, signal));
  child.once('close', (code, signal) => { live.delete(id); post('close', code, signal); });
};
parentPort.on('message', m => {
  if (m.kill) { try { live.get(m.id)?.kill(m.kill); } catch { /* already gone */ } return; }
  if (m.stream) return streamed(m);
  const { id, file, args, opts } = m;
  let child;
  try { child = execFile(file, args, opts, (err, stdout, stderr) => parentPort.postMessage({ id, stdout, stderr,
    err: err && { message: err.message, code: err.code, killed: err.killed, signal: err.signal, cmd: err.cmd } })); }
  catch (e) { return parentPort.postMessage({ id, stdout: '', stderr: '', err: { message: e.message, code: e.code } }); }
  child.once('exit', (code, signal) => parentPort.postMessage({ id, exit: [code, signal] }));
});`;

let worker = null;
const failed = (child, e) => { if (child.listenerCount('error')) child.emit('error', e); }; // unheard, an 'error' would throw
const pending = new Map(); // id → { cb, child }
let seq = 0;
const started = dc.channel('child_process'); // what the Activity panel listens to (lib/activity.mjs)

function spawner() {
  if (worker) return worker;
  // SHARE_ENV: a later change to process.env (PATH, say) reaches the programs started, as with node's own.
  const w = worker = new Worker(WORKER, { eval: true, env: SHARE_ENV });
  w.on('message', m => {
    const p = pending.get(m.id);
    if (!p) return;
    if (p.stream) return void streamEvent(m.id, p.child, m);
    if (m.exit) { p.exited = true; return void p.child.emit('exit', ...m.exit); }
    pending.delete(m.id);
    if (!pending.size) w.unref(); // idle: don't keep the process alive
    const err = m.err && Object.assign(new Error(m.err.message), m.err);
    if (!p.exited) failed(p.child, err ?? new Error('no exit')); // never started (ENOENT, EACCES, EINVAL…), so no exit
    p.cb(err ?? null, m.stdout ?? '', m.stderr ?? '');
  });
  const fail = e => {
    if (worker !== w) return; // 'exit' after 'error': a newer worker may hold the calls by now
    worker = null;
    for (const [id, p] of pending) {
      pending.delete(id);
      // A program the worker started outlives the worker: end it, so the 'close' below is true and no one (the
      // tunnel, docker events) starts a second one beside it. One whose pid never arrived can't be reached.
      if (p.stream && p.child.pid && !p.child.exited) try { process.kill(p.child.pid); } catch { /* already gone */ }
      failed(p.child, e);
      p.cb(e, '', '');
    }
  };
  const streamEvent = (id, c, { ev, a }) => {
    if (ev === 'spawn') { c.pid = a[0]; return void c.emit('spawn'); }
    if (ev === 'stdout' || ev === 'stderr') return void c[ev].emit('data', a[0]);
    if (ev === 'exit') { c.exited = true; return void c.emit('exit', ...a); }
    if (ev === 'error') return void failed(c, Object.assign(new Error(a[0].message), a[0]));
    pending.delete(id); // close: the last event
    if (!pending.size) w.unref();
    c.emit('close', ...a);
  };
  w.on('error', fail);
  w.on('exit', () => fail(new Error('spawn worker stopped')));
  return w;
}

// node:child_process's execFile, started from the worker. Options must be plain data (timeout, windowsHide,
// maxBuffer, cwd, env); output comes back as text. The child isn't returned (no caller uses it); a stand-in
// carrying its file, arguments, exit and error is published as node's own would be, so Activity still sees it.
export function execFile(file, args, opts, cb) {
  const id = ++seq;
  const child = Object.assign(new EventEmitter(), { spawnfile: file, spawnargs: [file, ...args] });
  pending.set(id, { cb, child });
  const w = spawner();
  w.ref();
  if (started.hasSubscribers) started.publish({ process: child });
  try { w.postMessage({ id, file, args, opts }); } catch (e) { // an option that isn't plain data: throw, as node does for a bad one
    pending.delete(id);
    if (!pending.size) w.unref();
    failed(child, e);
    throw e;
  }
}

// node:child_process's spawn, started from the worker, for a program that runs on (docker events, an ssh tunnel).
// Options must be plain data. The stand-in returned has stdout/stderr emitters ('data', as text), 'spawn' (pid
// set), 'exit', 'error' and 'close', and kill(). A kill once the pid is known goes straight to the process from
// this thread: it creates nothing, so it doesn't stall, and it still lands from a process 'exit' handler, where
// a message to the worker would never be read. A kill before the pid is known goes to the worker, so one made
// during exit is lost: on Windows the program still ends with the server (node's children do), elsewhere it is
// left running. If the worker stops, each child still running is ended and gets 'error' and 'close'.
export function spawn(file, args, opts) {
  const id = ++seq;
  const child = Object.assign(new EventEmitter(), { spawnfile: file, spawnargs: [file, ...args], pid: undefined,
    exited: false, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter() });
  child.kill = (signal = 'SIGTERM') => {
    if (!pending.has(id) || child.exited) return false;
    if (child.pid) { try { process.kill(child.pid, signal); } catch { return false; } }
    else worker?.postMessage({ id, kill: signal });
    return (child.killed = true);
  };
  pending.set(id, { stream: true, child, cb: () => child.emit('close', null, null) });
  const w = spawner();
  w.ref();
  if (started.hasSubscribers) started.publish({ process: child });
  try { w.postMessage({ id, file, args, opts, stream: true }); } catch (e) {
    pending.delete(id);
    if (!pending.size) w.unref();
    failed(child, e);
    throw e;
  }
  return child;
}
