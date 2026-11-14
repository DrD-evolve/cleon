// What the Orchestration flows panel's pips and hover card show, apart from drawing so it can be tested.
// Pure: no DOM, and the input isn't changed. The page (app.js) imports it, and so do the tests.
//
// `defs` is the payload's step list ({ n, id, label, node, who, what, signal }); a ticket's `subSteps` is
// [{ n, state }] and its `fileTimes` { artifact: mtimeMs }. A ticket without `subSteps` (a peer on an older Cleon)
// gets no pips and no card.

// The artifact a step writes, where it writes one (steps 15 and 16 write none). Offered only if `stepFiles` lists it
// (the node's, or any node's: the queued node has no entry) and the ticket has it. 'plan' is the plan in the plans dir,
// used when the run folder has no PLAN.md; the payload can't say whether it exists, so it is offered only once step 4
// has been reached.
const STEP_FILE = { 2: 'KICKOFF.md', 4: 'PLAN.md', 8: 'REPORT.md', 9: 'REVIEW_KICKOFF.md', 13: 'REVIEW_REPORT.md' };

// The steps only transcripts show (/api/step-models `seen`: { <n>: ms }) laid over a ticket's subSteps: a step that is
// inferred or not reached but has a time is seen. The current step stays current (the file signals decide it). Returns
// `subSteps` itself when there is nothing to lay over (a peer without `seen`, or no subSteps).
export function applySeen(subSteps, seen) {
  if (!Array.isArray(subSteps) || !seen || !Object.keys(seen).length) return subSteps;
  return subSteps.map(s => (s.state === 'inferred' || s.state === 'todo') && seen[s.n] > 0 ? { ...s, state: 'seen' } : s);
}

// A node's steps: the definitions in order, each with the ticket's state. Empty when the ticket has no subSteps.
export function nodeSteps(defs, subSteps, node) {
  if (!Array.isArray(subSteps)) return [];
  const state = new Map(subSteps.map(s => [s.n, s.state]));
  return (defs ?? []).filter(d => d.node === node).map(d => ({ ...d, state: state.get(d.n) ?? 'todo' }));
}

// The pip's CSS classes. The current step is pink where the node waits on you, amber elsewhere.
export const pipClass = (state, you) => `pip ${state}${state === 'current' ? (you ? ' gate' : ' work') : ''}`;

// The name to open a step's artifact by, or null: the step has none, the node doesn't offer it, or the ticket lacks it.
// `state`: the step's state ('todo' when not reached).
export function stepArtifact(n, node, stepFiles, files = [], state) {
  const want = STEP_FILE[n];
  if (!want) return null;
  const offered = [...(stepFiles?.[node] ?? []), ...Object.values(stepFiles ?? {}).flat()];
  if (offered.includes(want) && files.includes(want)) return want;
  return want === 'PLAN.md' && offered.includes('plan') && state && state !== 'todo' ? 'plan' : null;
}

// Each step's time (ms) from its artifact's modified time, else from a transcript (`seen`); null when neither has one.
export function stepTimes(steps, fileTimes, seen) {
  return Object.fromEntries(steps.map(s => {
    const f = STEP_FILE[s.n], t = f ? fileTimes?.[f] : null, u = seen?.[s.n];
    return [s.n, typeof t === 'number' && t > 0 ? t : typeof u === 'number' && u > 0 ? u : null];
  }));
}

// The time each step took: its time less the previous step's that has one, in this list. Null when either is
// missing or the order is backwards.
export function stepDurations(steps, times) {
  const out = {};
  let prev = null;
  for (const s of steps) {
    const t = times[s.n];
    out[s.n] = t != null && prev != null && t >= prev ? t - prev : null;
    if (t != null) prev = t;
  }
  return out;
}

// When the node started (its earliest step time) and how long it ran: to `now` while it is the ticket's current
// node, else to its last step time. Nulls when no step has a time; `ran` null for a node that isn't current and has
// only one, since one time gives no length.
export function nodeTiming(steps, times, running, now) {
  const ts = steps.map(s => times[s.n]).filter(t => t != null);
  if (!ts.length) return { start: null, ran: null };
  const start = Math.min(...ts), end = running ? Math.max(now, ...ts) : Math.max(...ts);
  return { start, ran: running || ts.length > 1 ? end - start : null };
}

export const fmtClock = ms => {
  if (ms == null) return '–';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};
export function fmtDur(ms) {
  if (ms == null) return '–';
  const m = Math.round(ms / 60000);
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const SAY = { seen: 'seen', inferred: 'inferred', current: 'current', todo: 'not reached' };
// Screen-reader text for a node's pips.
export function pipsLabel(nodeLabel, steps) {
  const range = steps.length > 1 ? `steps ${steps[0].n} to ${steps.at(-1).n}` : `step ${steps[0].n}`;
  return `${nodeLabel}, ${range}: ${steps.map(s => `${s.n} ${s.label} ${SAY[s.state] ?? s.state}`).join(', ')}. Press Enter for details.`;
}

// The loop a node belongs to, drawn under its mini workflow.
export const NODE_LOOP = {
  planning: '↺ redirect: back to planning from the plan gate',
  'plan-gate': '↺ redirect: back to planning',
  'self-review': '↺ re-gate fails across steps 10–12',
  'human-review': '↺ changes requested: back to implementing',
};
