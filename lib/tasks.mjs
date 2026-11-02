// Progress of background tasks (backgrounded commands, Monitor watchers). Claude Code writes each
// task's output to <tmp>/claude/<project>/<session>/tasks/<id>.output while it runs; the tail of that
// file is the progress. Found by task id only, and only for ids the dashboard already lists.
import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

const ROOT = join(os.tmpdir(), 'claude');
const TAIL_BYTES = 16_384;
const ID = /^\w{4,40}$/;
const found = new Map(); // id → path; a task's file doesn't move

// Pure: terminal output → its last `n` non-empty lines as displayed. Colour codes are stripped, and a
// line redrawn with \r (progress bars, counters) keeps only its final state.
export function tailLines(text, n) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map(l => l.split('\r').filter(s => s.trim()).at(-1) ?? '')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim())
    .slice(-n);
}

export async function outputPath(id) {
  if (!ID.test(id)) return null;
  if (found.has(id)) return found.get(id);
  for (const project of await readdir(ROOT).catch(() => [])) {
    for (const session of await readdir(join(ROOT, project)).catch(() => [])) {
      const p = join(ROOT, project, session, 'tasks', `${id}.output`);
      if (await stat(p).catch(() => null)) { found.set(id, p); return p; }
    }
  }
  return null;
}

async function readTail(path, size) {
  const fh = await open(path, 'r');
  try {
    const len = Math.min(size, TAIL_BYTES), buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}

// { size, at (last write, ms), lines } or null when the task has no output file.
export async function taskOutput(id, n = 1) {
  const path = await outputPath(id);
  const s = path && await stat(path).catch(() => null);
  if (!s) return null;
  return { size: s.size, at: s.mtimeMs, lines: s.size ? tailLines(await readTail(path, s.size), n) : [] };
}
