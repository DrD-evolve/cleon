// System resources: CPU, RAM, GPU/VRAM, disks, loaded Ollama models, and the processes using them.
// Read-only. Sources (all local, no PowerShell):
//   os module            system CPU % (from cpu-time deltas), RAM, uptime
//   tasklist             process names and RAM (working set) per pid — reads protected ones too
//   proc-stats.py        per-process CPU time via Win32 (CPU % = change between samples); the
//                        Process counters misalign on this machine, so they aren't used for CPU
//   typeperf counters    per-process VRAM (GPU Process Memory) and GPU % (GPU Engine)
//   nvidia-smi           whole-GPU utilisation, VRAM, temperature, power
//   Ollama HTTP API      loaded models and the VRAM they hold
// A counter read whose sample rows don't line up with its header (instances come and go mid-read)
// is dropped rather than misattributed.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const run = (cmd, args, timeout = 15000) => new Promise(resolve =>
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 50e6 }, (err, out) => resolve(err && !out ? null : out)));

// Pure: typeperf CSV → { header: [counter paths], rows: [[values]] }, or null when misaligned.
export function parseTypeperf(text) {
  const lines = (text ?? '').split(/\r?\n/).filter(l => l.startsWith('"'));
  if (lines.length < 2) return null;
  const cells = l => l.slice(1, -1).split('","');
  const header = cells(lines[0]).slice(1);
  const rows = lines.slice(1).map(l => cells(l).slice(1).map(Number));
  return rows.every(r => r.length === header.length) ? { header, rows } : null;
}
const pidOf = path => Number(path.match(/pid_(\d+)_/)?.[1]);

// Pure: per-pid VRAM bytes from "\GPU Process Memory(pid_N_luid_…)\Dedicated Usage".
export function vramByPid(tp) {
  const out = new Map();
  if (!tp) return out;
  const last = tp.rows.at(-1);
  tp.header.forEach((h, i) => { const p = pidOf(h); if (p && last[i] > 0) out.set(p, (out.get(p) ?? 0) + last[i]); });
  return out;
}
// Pure: per-pid GPU % like Task Manager — sum each engine type's instances, report the busiest type.
export function gpuByPid(tp) {
  const out = new Map();
  if (!tp) return out;
  const last = tp.rows.at(-1), byType = new Map();
  tp.header.forEach((h, i) => {
    const p = pidOf(h), type = h.match(/engtype_([^)\\]+)/)?.[1];
    if (!p || !type || !(last[i] > 0)) return;
    const k = `${p}|${type}`;
    byType.set(k, (byType.get(k) ?? 0) + last[i]);
  });
  for (const [k, v] of byType) { const p = Number(k.split('|')[0]); out.set(p, Math.max(out.get(p) ?? 0, Math.min(100, v))); }
  return out;
}
// Pure: per-pid CPU % of the whole machine, from two CPU-time samples (100 ns units) taken
// `ms` apart. A pid missing from either sample, or unreadable, gets no figure.
export function cpuByPid(prev, cur, ms, cores) {
  const out = new Map();
  if (!prev || !(ms > 0)) return out;
  for (const [pid, t] of cur) {
    const p = prev.get(pid);
    if (t != null && p != null && t >= p) out.set(pid, Math.min(100, ((t - p) / 1e4) / ms / cores * 100));
  }
  return out;
}
// Pure: tasklist /FO CSV /NH → [{ pid, name, ram (bytes) }].
export function parseTasklist(text) {
  return (text ?? '').split(/\r?\n/).filter(Boolean).flatMap(l => {
    const c = l.slice(1, -1).split('","');
    const kb = Number((c[4] ?? '').replace(/[^\d]/g, ''));
    return c.length >= 5 && Number(c[1]) ? [{ pid: Number(c[1]), name: c[0].replace(/\.exe$/i, ''), ram: kb * 1024 }] : [];
  });
}

let prevCpu = null;
function systemCpu() {
  const t = os.cpus().reduce((a, c) => { const tot = Object.values(c.times).reduce((x, y) => x + y, 0); return { idle: a.idle + c.times.idle, total: a.total + tot }; }, { idle: 0, total: 0 });
  const pct = prevCpu && t.total > prevCpu.total ? 100 * (1 - (t.idle - prevCpu.idle) / (t.total - prevCpu.total)) : null;
  prevCpu = t;
  return pct;
}

async function gpu() {
  const out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], 8000);
  const c = out?.split(/\r?\n/)[0]?.split(',').map(s => s.trim());
  if (!c || c.length < 6) return null;
  return { name: c[0], util: Number(c[1]), memUsed: Number(c[2]) * 2 ** 20, memTotal: Number(c[3]) * 2 ** 20, temp: Number(c[4]), power: Number(c[5]) };
}
async function ollama() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return (j.models ?? []).map(m => ({ name: m.name, size: m.size, vram: m.size_vram, until: m.expires_at }));
  } catch { return null; } // Ollama not running
}
async function disks() {
  const out = [];
  for (const d of 'CDEFGHIJ') {
    if (!existsSync(`${d}:\\`)) continue;
    const s = await statfs(`${d}:\\`).catch(() => null);
    if (s?.blocks) out.push({ drive: `${d}:`, free: s.bavail * s.bsize, total: s.blocks * s.bsize });
  }
  return out;
}

const PROC_STATS = fileURLToPath(new URL('./proc-stats.py', import.meta.url));
let prevTimes = null; // { at, times: Map(pid → cpu time) } from the previous sample

// One full sample (~3 s, the reads run in parallel). `labels` maps pid → a friendly name.
// Per-process CPU % needs a previous sample, so the first one has none.
export async function sampleResources(labels = new Map()) {
  const cores = os.cpus().length;
  const [tl, ps, tpVram, tpGpu, g, models, dk] = await Promise.all([
    run('tasklist', ['/FO', 'CSV', '/NH']),
    run('python', ['-I', PROC_STATS]),
    run('typeperf', ['\\GPU Process Memory(*)\\Dedicated Usage', '-sc', '1']),
    run('typeperf', ['\\GPU Engine(*)\\Utilization Percentage', '-sc', '2', '-si', '1']),
    gpu(), ollama(), disks(),
  ]);
  let times = null;
  try { times = new Map(JSON.parse(ps).map(p => [p.pid, p.cpu])); } catch { /* script failed: no CPU this round */ }
  const now = Date.now();
  const cpu = times ? cpuByPid(prevTimes?.times, times, now - (prevTimes?.at ?? now), cores) : new Map();
  if (times) prevTimes = { at: now, times };
  const vram = vramByPid(parseTypeperf(tpVram)), gpuPct = gpuByPid(parseTypeperf(tpGpu));
  const procs = parseTasklist(tl).map(p => ({
    ...p, label: labels.get(p.pid) ?? null,
    // null = that read was dropped this round (unknown), 0 = read fine and nothing used.
    // A process Windows won't open for its CPU time (protected, like the WSL VM) is unknown, not 0%.
    cpu: cpu.size && times?.get(p.pid) != null ? cpu.get(p.pid) ?? 0 : null,
    vram: vram.size ? vram.get(p.pid) ?? 0 : null, gpu: gpuPct.size ? gpuPct.get(p.pid) ?? 0 : null,
  }));
  return {
    at: Date.now(),
    cpu: { pct: systemCpu(), cores, model: os.cpus()[0]?.model?.trim() },
    mem: { total: os.totalmem(), used: os.totalmem() - os.freemem() },
    gpu: g, ollama: models, disks: dk, uptime: os.uptime(),
    // Which reads made it this round (a dropped counter read shows as "—", not as zeros).
    sources: { cpu: cpu.size > 0, vram: vram.size > 0, gpu: gpuPct.size > 0 },
    procs,
  };
}
