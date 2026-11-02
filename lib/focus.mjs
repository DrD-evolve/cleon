// Focus a Claude session wherever it runs, trying in order:
//   1. its herdr pane, found by the Claude session id herdr records for each agent pane;
//   2. its herdr pane, found by pid — herdr's session id goes stale on /clear or resume, the pid doesn't;
//   3. the terminal window it runs in (Git Bash, Windows Terminal), found through its parent processes;
//   4. the VS Code window whose terminal runs it, found by its working folder.
// A herdr focus also raises the window hosting herdr. Only live sessions from the session list are
// accepted, so a made-up id or pid never reaches herdr or Windows.
export async function focusSession(id, { sessions, snapshot, focusPane, paneForPid, raisePid, raiseCwd }) {
  const s = (await sessions()).find(s => s.id === id && s.alive);
  if (!s) return { ok: false, reason: 'session not running' };
  const snap = await snapshot();
  const agent = snap.online && snap.agents.find(a => a.agent_session?.value === id);
  let target = null;
  if (agent) {
    const label = snap.workspaces.find(w => w.session === agent.session && w.workspace_id === agent.workspace_id)?.label;
    target = { pane: agent.pane_id, label };
  } else {
    const byPid = await paneForPid(s.pid);
    if (byPid) target = { pane: byPid.pane, label: byPid.label };
  }
  if (target) {
    const r = await focusPane(target);
    if (r.ok) return { ...r, via: 'herdr' };
  }
  const term = await raisePid(s.pid);
  if (term) return { ok: true, raised: term, via: 'terminal' };
  const raised = await raiseCwd(s.cwd);
  if (raised) return { ok: true, raised, via: 'vscode' };
  return { ok: false, reason: target ? `found its herdr pane ${target.pane} but couldn't focus it, and no terminal or VS Code window matched`
    : 'no herdr pane runs it (checked session id and pid), it has no terminal window, and no VS Code window matched its folder' };
}
