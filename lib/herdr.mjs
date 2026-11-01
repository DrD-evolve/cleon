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

// Focus a pane in whichever running session currently owns it. Only panes in the live snapshot
// are accepted, so a stale fleet.tsv id (or anything a caller makes up) never reaches herdr.
export async function herdrFocus(pane, run = herdr) {
  const snap = await herdrSnapshot(run);
  const agent = snap.online && snap.agents.find(a => a.pane_id === pane);
  if (!agent) return { ok: false, reason: 'pane not live' };
  const r = await run(['--session', agent.session, 'agent', 'focus', pane]);
  return r.error ? { ok: false, reason: r.error.message } : { ok: true, session: agent.session, pane };
}
