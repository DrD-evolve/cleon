// Starting a program holds up the thread that starts it while Windows creates the process: measured at
// 100–400 ms a start inside the server while the page's pollers run (herdr every 5 s, once per running session,
// and two gits per repo every 30 s), so every route stalled for up to ~0.9 s every few seconds. Programs
// are started from a worker thread instead, which leaves the server's own thread free to answer.
import { Worker, SHARE_ENV } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import dc from 'node:diagnostics_channel';

const WORKER = `
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
parentPort.on('message', ({ id, file, args, opts }) => {
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
    for (const [id, p] of pending) { pending.delete(id); failed(p.child, e); p.cb(e, '', ''); }
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
