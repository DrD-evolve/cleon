// Herdr live state via `herdr api snapshot` (SessionSnapshot in the herdr API schema).
import { execFile } from 'node:child_process';

export function herdrSnapshot() {
  return new Promise(resolve => {
    execFile('herdr', ['api', 'snapshot'], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      let r;
      try { r = JSON.parse(stdout || stderr); } catch {
        return resolve({ online: false, reason: err?.code === 'ENOENT' ? 'herdr not installed' : 'no response' });
      }
      if (r.error) return resolve({ online: false, reason: r.error.message });
      const snap = r.result?.snapshot ?? r.result ?? r;
      resolve({
        online: true,
        workspaces: snap.workspaces ?? [],
        tabs: snap.tabs ?? [],
        agents: snap.agents ?? [],
        focused: snap.focused_pane_id ?? null,
      });
    });
  });
}
