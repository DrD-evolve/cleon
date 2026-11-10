// A peer's SSH tunnel (MC_PEERS `name=ssh://<host>`): Cleon runs ssh's local forward to the peer's own
// loopback-only Cleon and keeps it up, instead of the operator running one. The forward binds 127.0.0.1 only,
// the ssh arguments are fixed here (only the host comes from .env), and ssh authenticates with its own key
// setup: BatchMode, so it never prompts, and a login it can't make shows as the tunnel's error.
import { spawn as binSpawn, execFile } from './bin.mjs';
import { createServer } from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// The peer's Cleon, on its own machine.
export const REMOTE_PORT = 4317;
// An ssh_config Host alias or a host name: no user, no port, nothing ssh could read as an option.
export const SSH_TARGET = /^[A-Za-z0-9][\w.-]{0,252}$/;

// Pure: ssh's command line. `--` ends ssh's options, so the host can never be read as one.
export function tunnelArgs(target, localPort, remotePort = REMOTE_PORT) {
  if (!SSH_TARGET.test(String(target))) throw new Error(`not an ssh host alias or host name: ${target}`);
  for (const p of [localPort, remotePort]) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`not a port: ${p}`);
  return ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '--', target];
}

// Pure: what ssh's last error line means for the next try.
// - 'port': the local port was taken (ExitOnForwardFailure): take another one and go again at once.
// - 'network': it never reached the peer's sshd (a timeout, no route, no one listening, an unknown host):
//   retry soon, backing off.
// - 'sshd': anything else, such as a refused key or a connection the peer's sshd closed. OpenSSH penalizes those
//   per source address (PerSourcePenalties: about 5 s a failed login, and every connection refused once 15 s
//   build up, for up to 10 minutes), which would also cut off every other ssh from this machine. So wait a
//   minute between them.
export function failureKind(line) {
  const l = String(line ?? '');
  if (/address already in use|cannot listen to port|could not request local forwarding/i.test(l)) return 'port';
  if (/timed out|not responding|no route to host|network is unreachable|connection refused|could not resolve hostname|name or service not known|broken pipe/i.test(l)) return 'network';
  return 'sshd';
}

// A free loopback port, and whether a given one is free.
export const freePort = () => new Promise((resolve, reject) => {
  const s = createServer().once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
export const portFree = port => new Promise(resolve => {
  const s = createServer().once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

const UP = 60_000, CAP = 60_000;
// One peer's tunnel, kept up. `start()` runs ssh; when it exits it runs again, after a wait that depends on why
// (failureKind) and on how long it had been up: one that ran for a minute and then dropped (sleep, a network
// change) is retried after 1 s. `onPid(pid, port)` records each ssh it starts (orphan cleanup), `onPort(port)`
// says the local port moved. `status()` is local only: ssh's error names the account and the peer's address.
export function supervise({ target, port }, { spawn = binSpawn, env, newPort = freePort, onPid, onPort,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  tunnelArgs(target, port); // refuse a bad target before anything runs
  let child = null, timer = null, stopped = false, delay = 1000;
  const st = { target, port, state: 'stopped', error: null, restarts: 0, since: null, retryAt: null };
  const start = () => {
    timer = null;
    if (stopped) return;
    const c = child = spawn('ssh', tunnelArgs(target, st.port), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
    Object.assign(st, { state: 'running', since: now(), retryAt: null });
    // lib/bin.mjs's child learns its pid once the worker has started it; node's has it at once.
    if (c.pid != null) onPid?.(c.pid, st.port);
    else c.once('spawn', () => { if (child === c) onPid?.(c.pid ?? null, st.port); });
    let tail = '', done = false;
    c.stderr?.on('data', d => { tail = (tail + d).slice(-4096); });
    const ended = async fallback => {
      if (done) return;
      done = true;
      if (child === c) child = null;
      st.error = tail.split(/\r?\n/).map(s => s.trim()).filter(Boolean).at(-1) ?? fallback;
      if (stopped) return;
      const kind = failureKind(st.error);
      let wait;
      if (kind === 'port') {
        st.port = await newPort();
        onPort?.(st.port);
        wait = 0;
      } else if (now() - st.since >= UP) { wait = 1000; delay = 2000; } // it was up: reconnect now
      else if (kind === 'network') { wait = delay; delay = Math.min(delay * 2, CAP); }
      else wait = CAP;
      if (stopped) return;
      Object.assign(st, { state: 'waiting', retryAt: now() + wait });
      st.restarts++;
      timer = setTimer(start, wait);
    };
    c.once('close', code => ended(`ssh exited (${code})`));
    c.once('error', e => ended(e.code === 'ENOENT' ? 'ssh not found on PATH' : e.message));
  };
  return {
    start,
    status: () => ({ ...st }),
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      child?.kill();
      child = null;
      Object.assign(st, { state: 'stopped', retryAt: null });
    },
  };
}

// Each tunnel's last ssh pid and local port, in a file per Cleon port (a second Cleon on this machine, such as
// a test one, never touches another's tunnels). Read at startup to end the ssh a killed Cleon left behind, and
// to keep each peer on the same local port (its page's address, and what the browser remembers for it).
export const readTunnels = file => readFile(file, 'utf8').then(JSON.parse).then(v => (v && typeof v === 'object' ? v : {}), () => ({}));
export const writeTunnels = (file, state) => mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, JSON.stringify(state))).catch(() => {});

// A process's image name and command line (Windows), or null.
const procInfo = pid => new Promise(resolve => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p.Name; $p.CommandLine }`],
{ timeout: 10_000, windowsHide: true }, (err, out) => {
  const [name, ...cmd] = (err ? '' : out).split(/\r?\n/);
  resolve(name?.trim() ? { name: name.trim(), cmd: cmd.join(' ').trim() } : null);
}));
// End the ssh a killed Cleon left behind: only a recorded pid that is still an ssh running that exact forward
// (a reused pid is left alone). Resolves to the names of the peers whose ssh was ended.
export async function killOrphans(saved, { info = procInfo, kill = pid => process.kill(pid) } = {}) {
  const ended = [];
  for (const [name, { pid, port } = {}] of Object.entries(saved ?? {})) {
    if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
    const p = await info(pid);
    if (!p || !/^ssh(\.exe)?$/i.test(p.name) || !p.cmd.includes(`-L 127.0.0.1:${port}:127.0.0.1:`)) continue;
    try { kill(pid); ended.push(name); } catch { /* already gone */ }
  }
  return ended;
}
