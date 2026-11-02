import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { segments, reworkCommits, gateWaits, weekOf, rollup, processMetrics } from '../lib/metrics.mjs';
import { listRuns } from '../lib/runs.mjs';

const H = 3600e3;

test('segments split a ticket into agent time and time waiting on you', () => {
  const s = segments({ kickoff: 0, plan: 1 * H, report: 4 * H, review: 5 * H, merged: 7 * H, gateMs: 0.5 * H });
  assert.deepEqual(
    { planning: s.planning, gate: s.gate, implementing: s.implementing, selfReview: s.selfReview, mergeWait: s.mergeWait },
    { planning: H, gate: 0.5 * H, implementing: 2.5 * H, selfReview: H, mergeWait: 2 * H });
  assert.equal(s.agent, 4.5 * H);
  assert.equal(s.you, 2.5 * H);
  assert.equal(s.lead, 7 * H);
  assert.equal(s.approx, false);
});

test('a missing or rewritten artifact time is dropped and flagged, never guessed', () => {
  // KICKOFF rewritten by a re-dispatch after PLAN was written.
  const s = segments({ kickoff: 2 * H, plan: H, report: 3 * H, review: null, merged: 4 * H });
  assert.equal(s.planning, null);
  assert.equal(s.selfReview, null);
  assert.equal(s.mergeWait, H); // falls back to REPORT when there's no review
  assert.equal(s.approx, true);
});

test('rework counts commits pushed after the PR opened, with a minute of grace', () => {
  const pr = { createdAt: '2026-11-01T10:00:00Z', commits: [
    { committedDate: '2026-11-01T09:50:00Z' }, { committedDate: '2026-11-01T10:00:30Z' },
    { committedDate: '2026-11-01T10:30:00Z' }, { committedDate: '2026-11-01T11:00:00Z' }] };
  assert.equal(reworkCommits(pr), 2);
  assert.equal(reworkCommits({ createdAt: '2026-11-01T10:00:00Z' }), 0);
});

test('gateWaits pairs a Plan gate question with its answer and names the ticket', () => {
  const known = new Set(['ACME-147', 'ACME-9']);
  const line = (ts, type, content) => JSON.stringify({ type, timestamp: ts, message: { content } });
  const lines = [
    line('2026-11-01T17:00:00Z', 'user', 'GOAL: ACME-9. Do the thing'),
    line('2026-11-01T17:42:20Z', 'assistant', [{ type: 'tool_use', name: 'AskUserQuestion', id: 'a1',
      input: { questions: [{ header: 'Plan gate', question: 'ACME-147 plan is at C:/wt/plans/ACME-147-plan.md. Approve?' }] } }]),
    // A non-gate dialog is ignored.
    line('2026-11-01T17:43:00Z', 'assistant', [{ type: 'tool_use', name: 'AskUserQuestion', id: 'a2',
      input: { questions: [{ header: 'Scope', question: 'Which?' }] } }]),
    line('2026-11-01T17:44:00Z', 'user', [{ type: 'tool_result', tool_use_id: 'a2', content: 'x' }]),
    line('2026-11-01T17:51:27Z', 'user', [{ type: 'tool_result', tool_use_id: 'a1', content: 'Approve' }]),
    // A gate whose question names no ticket falls back to the opening prompt.
    line('2026-11-01T18:00:00Z', 'assistant', [{ type: 'tool_use', name: 'AskUserQuestion', id: 'a3',
      input: { questions: [{ header: 'Plan gate', question: 'Approve the plan with those answers?' }] } }]),
    line('2026-11-01T18:10:00Z', 'user', [{ type: 'tool_result', tool_use_id: 'a3', content: 'Approve' }]),
    'not json',
  ];
  assert.deepEqual(gateWaits(lines, known).map(w => [w.ticket, (w.answeredAt - w.askedAt) / 1000]),
    [['ACME-147', 547], ['ACME-9', 600]]);
});

test('weekOf starts weeks on Monday, and rollup sums each week', () => {
  const sun = new Date(2026, 10, 1, 15).getTime(), mon = new Date(2026, 10, 2, 9).getTime();
  assert.equal(weekOf(sun), new Date(2026, 9, 26).getTime());
  assert.equal(weekOf(mon), new Date(2026, 10, 2).getTime());
  const t = (mergedAt, agent, you, rework, lead) => ({ mergedAt, rework, size: 10, seg: { agent, you, gate: 0, lead } });
  const weeks = rollup([t(sun, H, 2 * H, 0, 3 * H), t(sun, 2 * H, H, 3, 5 * H), t(mon, H, H, 1, 2 * H)]);
  assert.deepEqual(weeks.map(w => [w.merged, w.agent / H, w.you / H, w.rework, w.reworked, w.medianLead / H]),
    [[1, 1, 1, 1, 1, 2], [2, 3, 3, 3, 1, 3]]);
});

test('processMetrics keeps merged tickets only and never calls gh or reads transcripts in tests', async () => {
  const { runs } = await listRuns(fileURLToPath(new URL('./fixtures/runs-gh', import.meta.url)), { lookup: async () => null });
  const prs = async urls => new Map(urls.map(u => [u, u.endsWith('/31')
    ? { title: 'x', createdAt: '2026-11-01T10:00:00Z', mergedAt: '2026-11-01T12:00:00Z', additions: 5, deletions: 2, commits: [] }
    : { title: 'y', createdAt: '2026-11-01T10:00:00Z', mergedAt: null }]));
  const m = await processMetrics(runs, { prs, waits: async () => [] });
  assert.deepEqual(m.tickets.map(t => [t.ticket, t.size, t.rework]), [['T-31', 7, 0]]);
  assert.equal(m.tickets[0].seg.approx, true); // the fixture has no artifact files
  assert.equal(m.weeks.length, 1);
});
