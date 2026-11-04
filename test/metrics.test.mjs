import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { segments, reworkCommits, gateWaits, presence, awayStretches, awayWithin, weekOf, rollup, processMetrics } from '../lib/metrics.mjs';
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

test('presence: your prompts and dialog answers, never notifications, summaries or other sessions', () => {
  const at = m => `2026-11-03T20:${String(m).padStart(2, '0')}:00Z`;
  const user = (m, content, extra = {}) => JSON.stringify({ type: 'user', timestamp: at(m), message: { content }, ...extra });
  const human = { origin: { kind: 'human' }, promptSource: 'typed' };
  const lines = [
    user(1, 'GOAL: build it', human),
    user(2, '<task-notification> <task-id>x</task-id>', { origin: { kind: 'task-notification' }, promptSource: 'system' }),
    user(3, 'This session is being continued from a previous conversation…', { isCompactSummary: true }),
    user(4, 'Another Claude session sent a message: <teammate-message>…'), // no origin
    user(5, 'Caveat: local command output', { ...human, isMeta: true }),
    user(6, 'a subagent prompt', { ...human, isSidechain: true }),
    JSON.stringify({ type: 'assistant', timestamp: at(7), message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'toolu_q1', input: {} },
      { type: 'tool_use', name: 'Bash', id: 'toolu_b1', input: {} }] } }),
    user(8, [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: 'ok' }]),
    user(9, [{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'Approve' }]),
    user(10, [{ type: 'text', text: 'yes do those now' }], { origin: { kind: 'human' }, promptSource: 'suggestion_accepted' }),
    'not json',
  ];
  assert.deepEqual(presence(lines).map(ms => new Date(ms).getUTCMinutes()), [1, 9, 10]);
  // A worker's pane: herdr types the orchestrator's prompts there, so only dialog answers are yours.
  assert.deepEqual(presence(lines, { typed: false }).map(ms => new Date(ms).getUTCMinutes()), [9]);
});

test('awayStretches finds gaps of three hours or more; awayWithin measures the overlap', () => {
  const marks = [22 * H, 9 * H, 10 * H, 15 * H, 21 * H]; // unsorted on purpose
  assert.deepEqual(awayStretches(marks), [[10 * H, 15 * H], [15 * H, 21 * H]]);
  assert.deepEqual(awayStretches([0, 2.9 * H]), []);
  assert.deepEqual(awayStretches([]), []);
  const away = [[10 * H, 15 * H]];
  assert.equal(awayWithin(8 * H, 12 * H, away), 2 * H);
  assert.equal(awayWithin(11 * H, 12 * H, away), H);
  assert.equal(awayWithin(16 * H, 18 * H, away), 0);
});

test('segments count a wait while you were away apart from waiting on you; lead stays wall-clock', () => {
  // Reviewed at 20:00, you left at 22:00 and came back at 05:00, merged at 05:30.
  const away = [[22 * H, 29 * H]];
  const s = segments({ kickoff: 17 * H, plan: 18 * H, report: 19 * H, review: 20 * H, merged: 29.5 * H, gateMs: 0.5 * H, gateAwayMs: 0.25 * H, away });
  assert.equal(s.mergeWait, 2.5 * H);
  assert.equal(s.mergeAway, 7 * H);
  assert.equal(s.gate, 0.25 * H);
  assert.equal(s.gateAway, 0.25 * H);
  assert.equal(s.implementing, 0.5 * H); // the whole gate still comes out of implementing
  assert.equal(s.you, 2.75 * H);
  assert.equal(s.away, 7.25 * H);
  assert.equal(s.lead, 12.5 * H);
});

test('weekOf starts weeks on Monday, and rollup sums each week', () => {
  const sun = new Date(2026, 10, 1, 15).getTime(), mon = new Date(2026, 10, 2, 9).getTime();
  assert.equal(weekOf(sun), new Date(2026, 9, 26).getTime());
  assert.equal(weekOf(mon), new Date(2026, 10, 2).getTime());
  const t = (mergedAt, agent, you, rework, lead) => ({ mergedAt, rework, size: 10, seg: { agent, you, away: H, gate: 0, lead } });
  const weeks = rollup([t(sun, H, 2 * H, 0, 3 * H), t(sun, 2 * H, H, 3, 5 * H), t(mon, H, H, 1, 2 * H)]);
  assert.deepEqual(weeks.map(w => [w.merged, w.agent / H, w.you / H, w.away / H, w.rework, w.reworked, w.medianLead / H]),
    [[1, 1, 1, 1, 1, 1, 2], [2, 3, 3, 2, 3, 1, 3]]);
});

test('processMetrics keeps merged tickets only and never calls gh or reads transcripts in tests', async () => {
  const { runs } = await listRuns(fileURLToPath(new URL('./fixtures/runs-gh', import.meta.url)), { lookup: async () => null });
  const prs = async urls => new Map(urls.map(u => [u, u.endsWith('/31')
    ? { title: 'x', createdAt: '2026-11-01T10:00:00Z', mergedAt: '2026-11-01T12:00:00Z', additions: 5, deletions: 2, commits: [] }
    : { title: 'y', createdAt: '2026-11-01T10:00:00Z', mergedAt: null }]));
  const m = await processMetrics(runs, { prs, transcripts: async () => ({ waits: [], marks: [] }) });
  assert.deepEqual(m.tickets.map(t => [t.ticket, t.size, t.rework]), [['T-31', 7, 0]]);
  assert.equal(m.tickets[0].seg.approx, true); // the fixture has no artifact files
  assert.equal(m.weeks.length, 1);
});

test('processMetrics splits a plan gate that waited overnight', async () => {
  const { runs } = await listRuns(fileURLToPath(new URL('./fixtures/runs-gh', import.meta.url)), { lookup: async () => null });
  const prs = async urls => new Map(urls.map(u => [u, { title: 'x', createdAt: '2026-11-01T10:00:00Z', mergedAt: '2026-11-02T12:00:00Z', commits: [] }]));
  const night = Date.parse('2026-11-01T22:00:00Z'), morning = Date.parse('2026-11-02T05:00:00Z');
  const transcripts = async known => ({
    // Asked an hour before you left, answered half an hour after you came back.
    waits: [...known].map(ticket => ({ ticket, askedAt: night - H, answeredAt: morning + H / 2 })),
    marks: [night - 2 * H, night, morning, morning + H / 2],
  });
  const t = (await processMetrics(runs, { prs, transcripts })).tickets[0];
  assert.equal(t.seg.gate, 1.5 * H);
  assert.equal(t.seg.gateAway, 7 * H);
  assert.equal(t.seg.away, 7 * H);
});
