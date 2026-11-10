// Claude Code sessions: one JSON file per running CLI process in ~/.claude/sessions.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { note } from './activity.mjs';
import { SESSIONS_DIR_SRC } from './config.mjs';

export const SESSIONS_DIR = SESSIONS_DIR_SRC ?? join(os.homedir(), '.claude', 'sessions');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function listSessions(dir = SESSIONS_DIR, isAlive = pidAlive) {
  const files = (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const at = Date.now();
    try {
      const s = JSON.parse(await readFile(join(dir, f), 'utf8'));
      const alive = isAlive(s.pid);
      out.push({
        pid: s.pid, id: s.sessionId, name: s.name, cwd: s.cwd, status: s.status,
        kind: s.kind, entrypoint: s.entrypoint, procStart: s.procStart, startedAt: s.startedAt, updatedAt: s.updatedAt,
        ticket: s.cwd?.match(/wt-([A-Z]+-\d+)/)?.[1] ?? null,
        alive,
      });
      note({ node: `claude:${s.sessionId}`, what: `session file · ${alive ? 'process running' : 'process gone'}` }, at);
    } catch { /* partially written file — skip this poll */ }
  }
  return out.sort(sessionOrder);
}
// Pure: running sessions first, then newest started first. Not by last activity: that moved a card
// every few seconds, sometimes from under the cursor as you clicked it.
export const sessionOrder = (a, b) => Number(b.alive) - Number(a.alive)
  || (b.startedAt ?? 0) - (a.startedAt ?? 0) || String(a.id).localeCompare(String(b.id));
