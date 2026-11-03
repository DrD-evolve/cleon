// Herdr live state via `herdr --session <name> api snapshot` (SessionSnapshot in the herdr API schema),
// merged across every running session from `herdr session list --json`.
import { execFile } from 'node:child_process';

export function herdr(args) {
  return new Promise(resolve => {
    execFile('herdr', args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      // Some commands (e.g. `pane run`) print nothing on success.
      if (!err && !stdout.trim() && !stderr.trim()) return resolve({ result: { type: 'ok' } });
      try { resolve(JSON.parse(stdout || stderr)); } catch {
        resolve({ error: { message: err?.code === 'ENOENT' ? 'herdr not installed' : 'no response' } });
      }
    });
  });
}

export async function herdrSnapshot(run = herdr) {
  const list = await run(['session', 'list', '--json']);
  if (list.error) return { online: false, reason: list.error.message };
  const running = (list.sessions ?? []).filter(s => s.running).map(s => s.name);
  if (!running.length) return { online: false, reason: 'no herdr session running' };

  const out = { online: true, sessions: running, workspaces: [], tabs: [], agents: [], panes: [], focused: null };
  // Asked all at once (each is its own herdr process), then merged in session order.
  const replies = await Promise.all(running.map(session => run(['--session', session, 'api', 'snapshot'])));
  for (const [i, session] of running.entries()) {
    const snap = replies[i].result?.snapshot;
    if (!snap) continue;
    const tag = x => ({ ...x, session });
    out.workspaces.push(...(snap.workspaces ?? []).map(tag));
    out.tabs.push(...(snap.tabs ?? []).map(tag));
    out.agents.push(...(snap.agents ?? []).map(tag));
    out.panes.push(...(snap.panes ?? []).map(({ pane_id, workspace_id, tab_id, cwd }) => ({ pane_id, workspace_id, tab_id, cwd, session })));
    out.focused ??= snap.focused_pane_id ?? null;
  }
  return out;
}

// The pids running in an agent's pane (`herdr pane process-info`), memoized for one pass over the
// sessions so each pane is asked at most once.
export function panePids(run = herdr) {
  const memo = new Map();
  return a => {
    const k = `${a.session}|${a.pane_id}`;
    if (!memo.has(k)) memo.set(k, run(['--session', a.session, 'pane', 'process-info', '--pane', a.pane_id]).then(r => {
      const info = r.result?.process_info;
      return [info?.foreground_process_group_id, ...(info?.foreground_processes ?? []).map(p => p.pid)].filter(Boolean);
    }));
    return memo.get(k);
  };
}
// herdr's record of a pane's Claude session id goes stale on /clear or resume; the pid doesn't.
// A pane is "stale" when its recorded id matches no live session. Only those panes are asked for
// pids, so the usual case (every id current) costs no extra herdr calls.
const isStale = (a, live) => !live.some(s => s.id === a.agent_session?.value);
// The agent pane running live session `s`: by recorded session id, else by pid among stale panes.
export async function agentForSession(s, snap, live, pidsOf) {
  if (!snap?.online) return null;
  const byId = snap.agents.find(a => a.agent_session?.value === s.id);
  if (byId || !s.pid) return byId ?? null;
  for (const a of snap.agents.filter(a => isStale(a, live))) if ((await pidsOf(a)).includes(s.pid)) return a;
  return null;
}
// The live session running in agent pane `a`: by recorded session id, else by the pane's pids.
export async function sessionForAgent(a, live, pidsOf) {
  const byId = live.find(s => s.id === a.agent_session?.value);
  if (byId) return byId;
  const pids = await pidsOf(a);
  return live.find(s => s.pid && pids.includes(s.pid)) ?? null;
}

// The herdr pane whose foreground process is `pid`. A fallback for when herdr's record of a pane's
// Claude session id has gone stale (it changes on /clear or resume); the pid doesn't. One
// process-info call per pane, so callers try the session id first.
export async function paneForPid(pid, run = herdr) {
  const snap = await herdrSnapshot(run);
  if (!snap.online || !pid) return null;
  for (const a of snap.agents) {
    const info = (await run(['--session', a.session, 'pane', 'process-info', '--pane', a.pane_id])).result?.process_info;
    const pids = [info?.foreground_process_group_id, ...(info?.foreground_processes ?? []).map(p => p.pid)];
    if (pids.includes(pid)) {
      const ws = snap.workspaces.find(w => w.session === a.session && w.workspace_id === a.workspace_id);
      return { session: a.session, pane: a.pane_id, label: ws?.label ?? null };
    }
  }
  return null;
}

// Focus a pane, or a whole workspace, in whichever running session owns it. Targets are matched
// against the live snapshot, so a stale fleet.tsv id (or anything a caller makes up) never reaches
// herdr. Ids like "w2" repeat across sessions; `label` (the workspace label a run recorded)
// disambiguates, and a target that still matches more than one session is refused.
// `raise(session, agents)`, when given, brings the window hosting the session forward afterwards.
// `attach(session, cwd)`, when given, opens a window on the session when `raise` finds none: a session
// keeps running headless after its windows close (a crash, a closed window), and focusing a pane in a
// session no window shows would otherwise show nothing.
export async function herdrFocus({ pane, workspace, label }, run = herdr, raise = null, attach = null) {
  const snap = await herdrSnapshot(run);
  if (!snap.online) return { ok: false, reason: snap.reason };
  const wsMatch = (session, id) => snap.workspaces.some(w => w.session === session && w.workspace_id === id && (!label || w.label === label));
  const hits = pane
    ? snap.agents.filter(a => a.pane_id === pane && wsMatch(a.session, a.workspace_id))
    : snap.workspaces.filter(w => w.workspace_id === workspace && wsMatch(w.session, w.workspace_id));
  if (hits.length !== 1) return { ok: false, reason: hits.length ? 'matches more than one herdr session' : `${pane ? 'pane' : 'workspace'} not live` };
  const { session } = hits[0];
  const r = await run(pane ? ['--session', session, 'agent', 'focus', pane] : ['--session', session, 'workspace', 'focus', workspace]);
  if (r.error) return { ok: false, reason: r.error.message };
  const out = { ok: true, session, pane, workspace: hits[0].workspace_id };
  const wsLabel = snap.workspaces.find(w => w.session === session && w.workspace_id === hits[0].workspace_id)?.label;
  if (raise) out.raised = await raise(session, snap.agents, wsLabel);
  if (attach && !out.raised) {
    const cwd = snap.panes.find(p => p.session === session && (pane ? p.pane_id === pane : p.workspace_id === out.workspace))?.cwd;
    const a = await attach(session, cwd);
    if (!a.ok) return { ok: false, reason: `focused it in herdr session ${session}, but no window shows that session and opening one failed: ${a.reason}` };
    Object.assign(out, { attached: true, raised: a.raised });
  }
  return out;
}
