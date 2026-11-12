// TEMPORARY diagnostic: times the process lookup the close job uses, with the raw execFile outcome.
import { spawn, execFile } from 'node:child_process';
import { procInfo } from '../lib/close.mjs';
const stub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
await new Promise(r => stub.once('spawn', r));
const cmd = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${stub.pid}"; if ($p) { $p.Name; $p.CreationDate.ToFileTimeUtc() }`;
for (let i = 0; i < 15; i++) {
  const t0 = performance.now();
  const raw = await new Promise(res => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
    { timeout: 10_000, windowsHide: true }, (err, out, errOut) => res({ ms: Math.round(performance.now() - t0), code: err?.code, killed: err?.killed, signal: err?.signal, out: out.trim().split(/\r?\n/)[0], errOut: errOut.trim().slice(0, 120) })));
  const t1 = performance.now();
  const p = await procInfo(stub.pid);
  console.log(`DIAG ${i} raw=${JSON.stringify(raw)} procInfo=${p ? p.name : 'null'} in ${Math.round(performance.now() - t1)}ms exitCode=${stub.exitCode}`);
}
stub.kill();
