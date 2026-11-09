// Sessions waiting on you, wherever they run — not only orchestration panes. A session counts when
// Claude reports it "waiting" (a question dialog or permission prompt is open) or herdr reports its
// pane "blocked". An open question isn't in the transcript yet (it's written once answered), so for
// herdr-hosted sessions the question and its options are read off the pane's screen. A session with
// no dialog open still counts when its last finished turn handed you something (from its transcript).
import { execFile } from './bin.mjs'; // not node's: see bin.mjs
import { EXCLUDE } from './config.mjs';
import { agentForSession, panePids } from './herdr.mjs';
import { transcriptPath, readActivity, needsYou } from './orchestrators.mjs';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Pure: a Claude question dialog on a terminal screen → { title, question, options }, or null when
// the screen isn't showing one. The "Enter to select" footer is what marks a live dialog.
export function parseDialog(screen) {
  if (!screen || !/Enter to select/.test(screen)) return null;
  const lines = screen.split(/\r?\n/);
  const footer = lines.findLastIndex(l => /Enter to select/.test(l));
  const first = lines.findIndex((l, i) => i < footer && /^\s*(?:❯\s*)?1\.\s+\S/.test(l));
  if (first < 0) return null;
  // Each option's indented description lines follow it; `notes[n]` holds option n's, joined.
  // `cursor`: the option ❯ is on (-1 when it's on "Type something" / "Chat about this").
  const options = [], notes = [];
  let cur = -1, cursor = -1;
  for (let i = first; i < footer; i++) {
    const m = lines[i].match(/^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/);
    if (m) {
      cur = /^(Type something|Chat about this)/i.test(m[2]) ? -1 : options.push(m[2]) - 1;
      if (/^\s*❯/.test(lines[i])) cursor = cur;
      if (cur >= 0) notes[cur] = '';
    } else if (cur >= 0 && /^\s{3,}\S/.test(lines[i]) && !/^\s*─/.test(lines[i])) {
      notes[cur] = `${notes[cur]} ${lines[i].trim()}`.trim();
    }
  }
  // The question is the │-bordered block just above the options; the ☐ line above it is the title.
  const q = [];
  let i = first - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  for (; i >= 0 && /^\s*│/.test(lines[i]); i--) q.unshift(lines[i].replace(/^\s*│\s?/, '').trim());
  let title = null;
  for (; i >= 0 && i > first - 40; i--) { const t = lines[i].match(/^\s*☐\s+(.+?)\s*$/); if (t) { title = t[1]; break; } }
  const question = q.join(' ').replace(/\s+/g, ' ').trim();
  // Several questions in one dialog show a tab bar ("☐ A  ☐ B  ✔ Submit"); answering those isn't supported.
  const multi = lines.slice(Math.max(0, first - 40), first).some(l => (l.match(/☐|☒|✔/g) ?? []).length > 1 || /✔\s*Submit/.test(l));
  return { title, question: question ? clip(question, 3000) : null, options, notes, cursor, multi };
}

const herdrRead = (session, pane) => new Promise(resolve =>
  execFile('herdr', ['--session', session, 'agent', 'read', pane, '--source', 'visible'], { timeout: 5000, windowsHide: true, maxBuffer: 4e6 },
    (err, out) => resolve(err ? null : out)));

// What a finished turn handed you, from the session's transcript. Excluded sessions aren't read.
async function transcriptHandoff(s) {
  if (EXCLUDE.test(s.cwd ?? '')) return null;
  const path = await transcriptPath(s.id);
  if (!path || EXCLUDE.test(path)) return null;
  const n = needsYou(s.status, await readActivity(path));
  return n && n.why !== 'dialog' ? n : null;
}

export async function listAttention(sessions, snap, read = herdrRead, pidsOf = panePids(), handedOff = transcriptHandoff) {
  const out = [];
  const live = sessions.filter(s => s.alive);
  for (const s of live) {
    const agent = await agentForSession(s, snap, live, pidsOf);
    if (s.status !== 'waiting' && agent?.agent_status !== 'blocked') {
      // No dialog open, but the last turn may have ended by handing you something: a question,
      // "(you)" items, or a numbered list introduced as yours.
      const h = await handedOff(s);
      if (h) out.push({ sessionId: s.id, name: s.name, cwd: s.cwd,
        pane: agent ? { herdr: agent.session, id: agent.pane_id, title: agent.terminal_title_stripped } : null,
        // With a list, its first item heads it: the question may be one of its later items.
        title: null, question: h.items[0] ?? h.ask ?? null, options: [], notes: [], items: h.items, why: h.why });
      continue;
    }
    // Never read the screen of a session working on excluded material (financial documents).
    const dialog = agent && !EXCLUDE.test(s.cwd ?? '') ? parseDialog(await read(agent.session, agent.pane_id)) : null;
    out.push({
      sessionId: s.id, name: s.name, cwd: s.cwd,
      pane: agent ? { herdr: agent.session, id: agent.pane_id, title: agent.terminal_title_stripped } : null,
      title: dialog?.title ?? null, question: dialog?.question ?? null, options: dialog?.options ?? [], notes: dialog?.notes ?? [],
    });
  }
  return out;
}
