// Focus a Claude session wherever it runs: its herdr pane (plus that window) when herdr hosts it,
// otherwise the VS Code window whose terminal runs it. Only live sessions from the session list are
// accepted, so a made-up id or pid never reaches herdr or Windows.
export async function focusSession(id, { sessions, snapshot, focusPane, raiseCwd }) {
  const s = (await sessions()).find(s => s.id === id && s.alive);
  if (!s) return { ok: false, reason: 'session not running' };
  const snap = await snapshot();
  // herdr records the Claude session each agent pane runs.
  const agent = snap.online && snap.agents.find(a => a.agent_session?.value === id);
  if (agent) {
    const label = snap.workspaces.find(w => w.session === agent.session && w.workspace_id === agent.workspace_id)?.label;
    return { ...await focusPane({ pane: agent.pane_id, label }), via: 'herdr' };
  }
  const raised = await raiseCwd(s.cwd);
  return raised ? { ok: true, raised, via: 'vscode' } : { ok: false, reason: 'not running in herdr or a VS Code window' };
}
