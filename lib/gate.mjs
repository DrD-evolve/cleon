// Answering a plan gate from the dashboard: pick one numbered option in the worker's question dialog.
// Nothing is sent unless the pane shows a plan gate with exactly the question and options the dashboard
// displayed. Keys go one at a time, with the screen re-read after each, and Enter is pressed only once
// ❯ is on the chosen option. Some terminal UIs ignore several keys arriving in one chunk; this way the
// selection is seen on screen before it is committed.
import { parseDialog } from './attention.mjs';

const same = (d, expect) => d && d.question === expect.question
  && d.options.length === expect.options.length && d.options.every((o, i) => o === expect.options[i]);

// deps: read() → screen text; key(name) → { ok }; sleep(ms).
export async function answerGate(expect, choice, { read, key, sleep }) {
  let d = parseDialog(await read());
  if (!d) return { ok: false, reason: 'no question is open in the pane' };
  if (d.multi) return { ok: false, reason: 'the dialog asks several questions; answer it in the pane' };
  if (!/plan gate/i.test(d.title ?? '')) return { ok: false, reason: `the open question isn't a plan gate (${d.title ?? 'untitled'})` };
  if (!same(d, expect)) return { ok: false, reason: 'the question in the pane has changed; nothing was sent' };
  if (!Number.isInteger(choice) || choice < 0 || choice >= d.options.length) return { ok: false, reason: 'no such option' };
  for (let steps = 0; d.cursor !== choice; steps++) {
    if (steps > d.options.length + 2) return { ok: false, reason: "couldn't move the selection to that option; nothing was chosen" };
    const r = await key(d.cursor < choice ? 'down' : 'up');
    if (!r.ok) return { ok: false, reason: `herdr refused a key: ${r.reason}` };
    await sleep(350);
    d = parseDialog(await read());
    if (!same(d, expect)) return { ok: false, reason: 'the question changed while moving the selection; nothing was chosen' };
  }
  const r = await key('enter');
  if (!r.ok) return { ok: false, reason: `herdr refused Enter: ${r.reason}` };
  await sleep(1000);
  return same(parseDialog(await read()), expect)
    ? { ok: false, reason: 'Enter was sent but the question is still showing; check the pane' }
    : { ok: true, chose: d.options[choice] };
}
