// Herdr live state via `herdr --session <name> api snapshot` (SessionSnapshot in the herdr API schema),
// merged across every running session from `herdr session list --json`.
import { execFile } from 'node:child_process';

function herdr(args) {
  return new Promise(resolve => {
    execFile('herdr', args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
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

  const out = { online: true, sessions: running, workspaces: [], tabs: [], agents: [], focused: null };
  for (const session of running) {
    const r = await run(['--session', session, 'api', 'snapshot']);
    const snap = r.result?.snapshot;
    if (!snap) continue;
    const tag = x => ({ ...x, session });
    out.workspaces.push(...(snap.workspaces ?? []).map(tag));
    out.tabs.push(...(snap.tabs ?? []).map(tag));
    out.agents.push(...(snap.agents ?? []).map(tag));
    out.focused ??= snap.focused_pane_id ?? null;
  }
  return out;
}

// Focus a pane, or a whole workspace, in whichever running session owns it. Targets are matched
// against the live snapshot, so a stale fleet.tsv id (or anything a caller makes up) never reaches
// herdr. Ids like "w2" repeat across sessions; `label` (the workspace label a run recorded)
// disambiguates, and a target that still matches more than one session is refused.
export async function herdrFocus({ pane, workspace, label }, run = herdr) {
  const snap = await herdrSnapshot(run);
  if (!snap.online) return { ok: false, reason: snap.reason };
  const wsMatch = (session, id) => snap.workspaces.some(w => w.session === session && w.workspace_id === id && (!label || w.label === label));
  const hits = pane
    ? snap.agents.filter(a => a.pane_id === pane && wsMatch(a.session, a.workspace_id))
    : snap.workspaces.filter(w => w.workspace_id === workspace && wsMatch(w.session, w.workspace_id));
  if (hits.length !== 1) return { ok: false, reason: hits.length ? 'matches more than one herdr session' : `${pane ? 'pane' : 'workspace'} not live` };
  const { session } = hits[0];
  const r = await run(pane ? ['--session', session, 'agent', 'focus', pane] : ['--session', session, 'workspace', 'focus', workspace]);
  return r.error ? { ok: false, reason: r.error.message } : { ok: true, session, pane, workspace: hits[0].workspace_id };
}
