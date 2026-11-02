// Sessions waiting on you, wherever they run — not only orchestration panes. A session counts when
// Claude reports it "waiting" (a question dialog or permission prompt is open) or herdr reports its
// pane "blocked". An open question isn't in the transcript yet (it's written once answered), so for
// herdr-hosted sessions the question and its options are read off the pane's screen.
import { execFile } from 'node:child_process';
import { EXCLUDE } from './graph.mjs';
import { agentForSession, panePids } from './herdr.mjs';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Pure: a Claude question dialog on a terminal screen → { title, question, options }, or null when
// the screen isn't showing one. The "Enter to select" footer is what marks a live dialog.
export function parseDialog(screen) {
  if (!screen || !/Enter to select/.test(screen)) return null;
  const lines = screen.split(/\r?\n/);
  const footer = lines.findLastIndex(l => /Enter to select/.test(l));
  const first = lines.findIndex((l, i) => i < footer && /^\s*(?:❯\s*)?1\.\s+\S/.test(l));
  if (first < 0) return null;
  const options = [];
  for (let i = first; i < footer; i++) {
    const m = lines[i].match(/^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/);
    if (m && !/^(Type something|Chat about this)/i.test(m[2])) options.push(m[2]);
  }
  // The question is the │-bordered block just above the options; the ☐ line above it is the title.
  const q = [];
  let i = first - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  for (; i >= 0 && /^\s*│/.test(lines[i]); i--) q.unshift(lines[i].replace(/^\s*│\s?/, '').trim());
  let title = null;
  for (; i >= 0 && i > first - 40; i--) { const t = lines[i].match(/^\s*☐\s+(.+?)\s*$/); if (t) { title = t[1]; break; } }
  const question = q.join(' ').replace(/\s+/g, ' ').trim();
  return { title, question: question ? clip(question, 600) : null, options };
}

const herdrRead = (session, pane) => new Promise(resolve =>
  execFile('herdr', ['--session', session, 'agent', 'read', pane, '--source', 'visible'], { timeout: 5000, windowsHide: true, maxBuffer: 4e6 },
    (err, out) => resolve(err ? null : out)));

export async function listAttention(sessions, snap, read = herdrRead, pidsOf = panePids()) {
  const out = [];
  const live = sessions.filter(s => s.alive);
  for (const s of live) {
    const agent = await agentForSession(s, snap, live, pidsOf);
    if (s.status !== 'waiting' && agent?.agent_status !== 'blocked') continue;
    // Never read the screen of a session working on excluded material (financial documents).
    const dialog = agent && !EXCLUDE.test(s.cwd ?? '') ? parseDialog(await read(agent.session, agent.pane_id)) : null;
    out.push({
      sessionId: s.id, name: s.name, cwd: s.cwd,
      pane: agent ? { herdr: agent.session, id: agent.pane_id, title: agent.terminal_title_stripped } : null,
      title: dialog?.title ?? null, question: dialog?.question ?? null, options: dialog?.options ?? [],
    });
  }
  return out;
}
