// What each orchestrator session is doing, read from its Claude transcript
// (~/.claude/projects/<project>/<session id>.jsonl, one JSON event per line).
//
// Privacy: only the orchestrator's own narration, one-line summaries of its tool calls (the tool's
// description, never raw commands), your prompts, and background-task notices are surfaced. Tool
// output is never read past its error flag. Transcripts under excluded paths are never opened.
import { readdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { EXCLUDE } from './graph.mjs';

export const PROJECTS_DIR = join(os.homedir(), '.claude', 'projects');
const TAIL_BYTES = 1_000_000;
const MAX_EVENTS = 30;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// One line of plain text: whitespace collapsed, markdown bold markers dropped.
const oneLine = s => String(s ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const base = p => String(p ?? '').split(/[\\/]/).pop();

// Pure: the epic an orchestrator drives, from its own actions only — the /orchestrate-work command
// it was given, or the epic watcher it armed. (Other sessions may merely mention these strings.)
export function epicOf(entries) {
  let epic = null;
  for (const e of entries) {
    const c = e.message?.content;
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text) : [];
    if (e.type === 'user') for (const t of texts) {
      const m = t.match(/<command-name>\/?[\w:-]*orchestrate-work<\/command-name>\s*<command-args>\s*([A-Z]+-\d+)/);
      if (m) epic = m[1];
    }
    if (e.type === 'assistant' && Array.isArray(c)) for (const u of c) {
      const m = u.type === 'tool_use' && String(u.input?.command ?? '').match(/workspace-dispatch\.sh"?\s+watch\s+--epic\s+([A-Z]+-\d+)/);
      if (m) epic = m[1];
    }
  }
  return epic;
}

// Pure: a one-line, output-free summary of a tool call.
export function toolLine(name, input = {}) {
  if (input.description) return oneLine(input.description);
  if (input.file_path) return `${name} ${base(input.file_path)}`;
  if (name === 'Skill') return `skill ${input.skill ?? ''}`.trim();
  if (name === 'SendMessage') return `message to ${input.to ?? 'agent'}`;
  if (name === 'TaskStop') return 'stopped a background task';
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `${mcp[1].replace(/^claude_ai_/, '')}: ${mcp[2].replace(/_/g, ' ')}`;
  return name === 'Bash' ? 'ran a command' : name;
}

// Pure: your prompts that hand a PR's merge to the orchestrator ("merge 141 when green", "ship
// ACME-147"). The run files can't show this — they read the same before and after you approve —
// so without it a ticket you've already approved looks like it's still waiting on you. Anything
// hedged ("don't merge", "hold", "wait") is not an approval.
export function mergeApprovals(prompts) {
  return prompts.flatMap(p => {
    if (!/\b(merge|ship|land|approved?|lgtm)\b/i.test(p.text) || /\b(don'?t|do not|not|no|hold|wait|stop)\b/i.test(p.text)) return [];
    const prs = [...p.text.matchAll(/(?<![-\w])#?(\d{2,6})\b/g)].map(m => Number(m[1]));
    const tickets = [...p.text.matchAll(/\b[A-Z]+-\d+\b/g)].map(m => m[0]);
    return prs.length || tickets.length ? [{ t: p.t, prs, tickets }] : [];
  });
}

const notice = text => {
  const tag = k => text.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`))?.[1]?.trim();
  return { id: tag('task-id'), status: tag('status'), summary: tag('summary'), event: tag('event') };
};

// Pure: the activity feed, open background tasks, latest intent and turn state from transcript entries.
export function parseActivity(entries, now = Date.now()) {
  const events = [], tasks = new Map(), pendingBg = new Map(), toolEvents = new Map();
  let intent = null, lastAt = null, turnEnded = false;
  for (const e of entries) {
    const t = e.timestamp ? Date.parse(e.timestamp) : null;
    const c = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(c)) {
      turnEnded = false;
      for (const u of c) {
        if (u.type === 'text' && u.text.trim()) {
          intent = clip(oneLine(u.text), 300);
          events.push({ t, kind: 'say', text: intent });
        } else if (u.type === 'tool_use') {
          const ev = { t, kind: 'tool', tool: u.name, text: clip(toolLine(u.name, u.input), 140), ok: null };
          events.push(ev); toolEvents.set(u.id, ev);
          if (u.input?.run_in_background || u.name === 'Monitor') pendingBg.set(u.id, { desc: ev.text, kind: u.name === 'Monitor' ? 'watch' : 'bg', t });
          if (u.name === 'TaskStop' && u.input?.task_id) tasks.delete(u.input.task_id);
        }
      }
    } else if (e.type === 'user') {
      const parts = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
      for (const x of parts) {
        if (x.type === 'tool_result') {
          const ev = toolEvents.get(x.tool_use_id);
          if (ev) ev.ok = !x.is_error;
          const bg = pendingBg.get(x.tool_use_id);
          // The task id is in the launch acknowledgement — the only part of a result that is read.
          const ack = bg ? JSON.stringify(x.content ?? '') : '';
          const id = ack.match(/(?:background with ID: |\(task )(\w+)/)?.[1];
          // A watcher states its lifetime ("expires in 30m"); its expiry notice can be missing.
          const mins = Number(ack.match(/expires in (\d+)m/)?.[1]);
          if (id) tasks.set(id, { id, ...bg, until: mins && bg.t ? bg.t + mins * 60_000 : null });
          pendingBg.delete(x.tool_use_id);
        } else if (x.type === 'text' && x.text.includes('<task-notification>')) {
          const n = notice(x.text);
          if (n.status || /expired/i.test(n.event ?? '')) tasks.delete(n.id);
          events.push({ t, kind: 'note', text: clip(oneLine(n.event ?? n.summary ?? 'background task update'), 160), ok: n.status ? n.status === 'completed' : null });
        } else if (x.type === 'text' && x.text.trim()) {
          const cmd = x.text.match(/<command-name>([^<]+)<\/command-name>\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-args>([^<]*)<\/command-args>/);
          if (cmd) events.push({ t, kind: 'you', text: clip(oneLine(`${cmd[1]} ${cmd[2]}`), 160) });
          else if (!x.text.startsWith('<')) events.push({ t, kind: 'you', text: clip(oneLine(x.text), 200) });
        }
      }
    } else if (e.type === 'system' && (e.subtype === 'turn_duration' || e.subtype === 'stop_hook_summary')) {
      turnEnded = true;
    }
    if (t) lastAt = t;
  }
  const live = [...tasks.values()].filter(k => !k.until || k.until > now);
  // Approvals come from every prompt in the window, not just the events that fit in the feed.
  const approvals = mergeApprovals(events.filter(e => e.kind === 'you'));
  return { events: events.slice(-MAX_EVENTS), tasks: live, intent, lastAt, turnEnded, approvals };
}

const parseLines = text => text.split('\n').flatMap(l => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });

async function readRange(path, start, end) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}
async function readTail(path, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const text = await readRange(path, start, size);
  return start ? text.slice(text.indexOf('\n') + 1) : text; // drop the partial first line
}

// The epic is found by scanning each transcript once, incrementally: only new complete lines are
// parsed on later polls, so a long non-orchestrator session costs nothing after its first scan.
async function scanEpic(path, size, prev = { epic: null, offset: 0 }) {
  if (prev.epic || size <= prev.offset) return prev;
  const text = await readRange(path, prev.offset, size);
  const cut = text.lastIndexOf('\n') + 1; // stop at the last complete line
  return { epic: epicOf(parseLines(text.slice(0, cut))), offset: prev.offset + Buffer.byteLength(text.slice(0, cut)) };
}

// Transcript paths are found by session id, then cached; epics are found once per transcript size.
const pathCache = new Map(), epicCache = new Map(), activityCache = new Map();
async function transcriptPath(id) {
  if (pathCache.has(id)) return pathCache.get(id);
  for (const d of await readdir(PROJECTS_DIR).catch(() => [])) {
    const p = join(PROJECTS_DIR, d, `${id}.jsonl`);
    if (await stat(p).then(() => true, () => false)) { pathCache.set(id, p); return p; }
  }
  return null;
}

// Live orchestrator sessions with what they're doing, matched to herdr panes when herdr hosts them.
export async function listOrchestrators(sessions, snap) {
  const out = [];
  for (const s of sessions.filter(s => s.alive)) {
    const path = await transcriptPath(s.id);
    if (!path || EXCLUDE.test(path) || EXCLUDE.test(s.cwd ?? '')) continue;
    const { size } = await stat(path);
    const epic = await scanEpic(path, size, epicCache.get(path));
    epicCache.set(path, epic);
    if (!epic.epic) continue;
    let act = activityCache.get(path);
    if (!act || act.size !== size) activityCache.set(path, act = { size, ...parseActivity(parseLines(await readTail(path, size))) });
    const agent = snap?.online ? snap.agents.find(a => a.agent_session?.value === s.id) : null;
    const ws = agent && snap.workspaces.find(w => w.session === agent.session && w.workspace_id === agent.workspace_id);
    out.push({
      epic: epic.epic, sessionId: s.id, name: s.name, status: agent?.agent_status ?? s.status,
      pane: agent ? { herdr: agent.session, id: agent.pane_id, label: ws?.label ?? null } : null,
      // Activity is cached until the transcript grows, so expire watchers against the clock here too.
      intent: act.intent, tasks: act.tasks.filter(k => !k.until || k.until > Date.now()),
      events: act.events, lastAt: act.lastAt, turnEnded: act.turnEnded, approvals: act.approvals,
    });
  }
  return out;
}
