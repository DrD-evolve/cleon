import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { tunnelArgs, failureKind, supervise, killOrphans, readTunnels, writeTunnels, freePort, portFree } from '../lib/tunnel.mjs';

test('tunnelArgs: a fixed ssh command line that forwards loopback to loopback, and never takes an option from .env', () => {
  assert.deepEqual(tunnelArgs('worker', 50123), ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', '127.0.0.1:50123:127.0.0.1:4317', '--', 'worker']);
  for (const bad of ['-oProxyCommand=calc', '-L0.0.0.0:1:x:2', 'me@worker', 'worker:2222', 'two words', '', 'a;b'])
    assert.throws(() => tunnelArgs(bad, 50123), /not an ssh host alias/, bad);
  assert.throws(() => tunnelArgs('worker', 0), /not a port/);
});

test('failureKind: a taken port, a network error, or something the peer\'s sshd said (which it penalizes)', () => {
  assert.equal(failureKind('bind [127.0.0.1]:50123: Address already in use'), 'port');
  assert.equal(failureKind('Could not request local forwarding.'), 'port');
  assert.equal(failureKind('ssh: connect to host 10.9.9.9 port 22: Connection timed out'), 'network');
  assert.equal(failureKind('ssh: connect to host 10.9.9.9 port 22: Connection refused'), 'network');
  assert.equal(failureKind('ssh: Could not resolve hostname worker: Name or service not known'), 'network');
  assert.equal(failureKind('Timeout, server worker not responding.'), 'network');
  assert.equal(failureKind('me@10.9.9.9: Permission denied (publickey).'), 'sshd');
  assert.equal(failureKind('kex_exchange_identification: read: Connection reset by peer'), 'sshd');
  assert.equal(failureKind(undefined), 'sshd');
});

// A stand-in for child_process.spawn: records each ssh it starts; `end(stderr, code)` makes the latest exit.
function fakeSsh() {
  const runs = [];
  const spawn = (cmd, args, opts) => {
    const c = Object.assign(new EventEmitter(), { pid: 1000 + runs.length, stderr: new EventEmitter(), killed: false });
    c.kill = () => { c.killed = true; };
    runs.push({ cmd, args, opts, c });
    return c;
  };
  const end = async (err = '', code = 255) => { const { c } = runs.at(-1); if (err) c.stderr.emit('data', err); c.emit('close', code); await new Promise(r => setImmediate(r)); };
  return { runs, spawn, end };
}
function clock() {
  let t = 0;
  const timers = [];
  return { now: () => t, tick: ms => { t += ms; }, timers,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: h => { h.cleared = true; },
    fire: () => { const h = timers.at(-1); h.fn(); } };
}

test('supervise runs ssh, waits a minute after a refused login, and backs off from network errors', async () => {
  const ssh = fakeSsh(), c = clock(), pids = [];
  const t = supervise({ target: 'worker', port: 50123 }, { spawn: ssh.spawn, env: { X: '1' }, onPid: (pid, port) => pids.push([pid, port]), ...c });
  t.start();
  assert.equal(ssh.runs[0].cmd, 'ssh');
  assert.deepEqual(ssh.runs[0].args, tunnelArgs('worker', 50123));
  assert.deepEqual(ssh.runs[0].opts, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { X: '1' } });
  assert.deepEqual(pids, [[1000, 50123]]);
  assert.equal(t.status().state, 'running');

  // A refused key: ssh's own line is kept, and the next try is a minute away (the peer's sshd penalizes failures).
  c.tick(2000);
  await ssh.end('debug1: x\r\nme@10.9.9.9: Permission denied (publickey).\r\n', 255);
  assert.deepEqual([t.status().state, t.status().error, c.timers.at(-1).ms], ['waiting', 'me@10.9.9.9: Permission denied (publickey).', 60_000]);

  // Network errors: 1 s, then doubling, never more than a minute.
  const waits = [];
  for (let i = 0; i < 8; i++) {
    c.fire();
    c.tick(500);
    await ssh.end('ssh: connect to host 10.9.9.9 port 22: Connection timed out\n');
    waits.push(c.timers.at(-1).ms);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);

  // Up for over a minute, then dropped (sleep, a network change): reconnect after 1 s, and the backoff starts over.
  c.fire();
  c.tick(5 * 60_000);
  await ssh.end('Timeout, server worker not responding.\n');
  assert.equal(c.timers.at(-1).ms, 1000);
  assert.equal(t.status().restarts, 10);
});

test('supervise moves to a free port when its own was taken, and says so', async () => {
  const ssh = fakeSsh(), c = clock(), moved = [];
  const t = supervise({ target: 'worker', port: 50123 }, { spawn: ssh.spawn, newPort: async () => 50999, onPort: p => moved.push(p), ...c });
  t.start();
  await ssh.end('bind [127.0.0.1]:50123: Address already in use\nCould not request local forwarding.\n');
  assert.deepEqual(moved, [50999]);
  assert.equal(c.timers.at(-1).ms, 0);
  c.fire();
  assert.equal(ssh.runs[1].args.at(-3), '127.0.0.1:50999:127.0.0.1:4317');
  assert.equal(t.status().port, 50999);
});

test('stop ends the ssh and never starts another; a missing ssh is an error on the tunnel', async () => {
  const ssh = fakeSsh(), c = clock();
  const t = supervise({ target: 'worker', port: 50123 }, { spawn: ssh.spawn, ...c });
  t.start();
  t.stop();
  assert.equal(ssh.runs[0].c.killed, true);
  await ssh.end('', 1);
  assert.equal(c.timers.length, 0);
  assert.equal(t.status().state, 'stopped');
  // Waiting to retry, then stopped: the timer is cleared.
  const ssh2 = fakeSsh(), c2 = clock();
  const t2 = supervise({ target: 'worker', port: 50123 }, { spawn: ssh2.spawn, ...c2 });
  t2.start();
  await ssh2.end('Connection refused');
  t2.stop();
  assert.equal(c2.timers[0].cleared, true);
  // ssh not installed.
  const c3 = clock();
  const t3 = supervise({ target: 'worker', port: 50123 }, { spawn: () => { const e = new EventEmitter(); setImmediate(() => e.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))); return e; }, ...c3 });
  t3.start();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(t3.status().error, 'ssh not found on PATH');
  assert.throws(() => supervise({ target: '-oProxyCommand=calc', port: 50123 }), /not an ssh host alias/);
});

test('killOrphans ends only a recorded ssh that is still running that exact forward', async () => {
  const procs = {
    11: { name: 'ssh.exe', cmd: '"C:\\Git\\usr\\bin\\ssh.exe" -N -o BatchMode=yes -L 127.0.0.1:50123:127.0.0.1:4317 -- worker' },
    12: { name: 'chrome.exe', cmd: 'chrome.exe -L 127.0.0.1:50124:127.0.0.1:4317' },             // a reused pid
    13: { name: 'ssh.exe', cmd: 'ssh -N -L 127.0.0.1:59999:127.0.0.1:4317 -- worker' },           // another forward
  };
  const killed = [];
  const ended = await killOrphans({ worker: { pid: 11, port: 50123 }, box: { pid: 12, port: 50124 }, other: { pid: 13, port: 50125 }, gone: { pid: 14, port: 50126 }, odd: { pid: 'x' } },
    { info: async pid => procs[pid] ?? null, kill: pid => killed.push(pid) });
  assert.deepEqual(ended, ['worker']);
  assert.deepEqual(killed, [11]);
});

test('the tunnel file round-trips, and a missing or bad one reads as empty; ports are found free on loopback', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-tunnels-'));
  try {
    const file = join(dir, 'data', 'peer-tunnels-4318.json');
    assert.deepEqual(await readTunnels(file), {});
    await writeTunnels(file, { worker: { pid: 11, port: 50123 } });
    assert.deepEqual(await readTunnels(file), { worker: { pid: 11, port: 50123 } });
    const port = await freePort();
    assert.ok(port > 0 && await portFree(port));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
