import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../lib/adapters/orchestration-plugin.mjs';
import { nodeSteps, pipClass, stepArtifact, stepTimes, stepDurations, nodeTiming, fmtClock, fmtDur, pipsLabel, NODE_LOOP } from '../public/flow-pips.mjs';

const defs = adapter.subSteps;
const SF = adapter.stepFiles;
const mk = o => defs.map(d => ({ n: d.n, state: o[d.n] ?? 'todo' }));

test('a node gets its own steps, in order, in the ticket\'s states', () => {
  const s = nodeSteps(defs, mk({ 3: 'seen', 4: 'current' }), 'planning');
  assert.deepEqual(s.map(x => [x.n, x.state]), [[3, 'seen'], [4, 'current']]);
  assert.deepEqual(nodeSteps(defs, mk({}), 'self-review').map(x => x.n), [9, 10, 11, 12, 13]);
  assert.deepEqual(nodeSteps(defs, mk({}), 'done').map(x => x.n), [16]);
});

test('a ticket without subSteps has no steps, so no pips and no card', () => {
  assert.deepEqual(nodeSteps(defs, undefined, 'planning'), []);
  assert.deepEqual(nodeSteps(defs, null, 'queued'), []);
  assert.deepEqual(nodeSteps(undefined, mk({}), 'queued'), []);
});

test('pip classes: one per state, the current one pink at a gate and amber elsewhere', () => {
  assert.equal(pipClass('seen', false), 'pip seen');
  assert.equal(pipClass('inferred', true), 'pip inferred');
  assert.equal(pipClass('todo', false), 'pip todo');
  assert.equal(pipClass('current', true), 'pip current gate');
  assert.equal(pipClass('current', false), 'pip current work');
});

test('a step opens an artifact only when its node offers it and the ticket has it', () => {
  assert.equal(stepArtifact(2, 'queued', { queued: ['KICKOFF.md'] }, ['KICKOFF.md']), 'KICKOFF.md');
  assert.equal(stepArtifact(2, 'queued', SF, ['KICKOFF.md']), 'KICKOFF.md', 'queued has no stepFiles entry; implementing offers the name');
  assert.equal(stepArtifact(2, 'queued', SF, []), null);
  assert.equal(stepArtifact(2, 'queued', {}, ['KICKOFF.md']), null);
  assert.equal(stepArtifact(8, 'implementing', SF, ['REPORT.md']), 'REPORT.md');
  assert.equal(stepArtifact(8, 'implementing', SF, []), null);
  assert.equal(stepArtifact(13, 'self-review', SF, ['REVIEW_REPORT.md']), 'REVIEW_REPORT.md');
  assert.equal(stepArtifact(9, 'self-review', SF, ['REVIEW_KICKOFF.md']), 'REVIEW_KICKOFF.md');
});

test('the plan step falls back to the plans-dir plan once reached, and steps with no artifact are never clickable', () => {
  assert.equal(stepArtifact(4, 'planning', SF, ['PLAN.md']), 'PLAN.md');
  assert.equal(stepArtifact(4, 'planning', SF, [], 'inferred'), 'plan');
  assert.equal(stepArtifact(4, 'planning', SF, [], 'current'), 'plan');
  assert.equal(stepArtifact(4, 'planning', SF, [], 'todo'), null, 'not reached: there may be no plan to open');
  assert.equal(stepArtifact(4, 'planning', SF, []), null);
  for (const n of [1, 3, 5, 6, 7, 10, 11, 12, 14, 15, 16]) assert.equal(stepArtifact(n, defs[n - 1].node, SF, ['KICKOFF.md', 'PLAN.md', 'REPORT.md', 'REVIEW_REPORT.md', 'REVIEW_KICKOFF.md']), null, `step ${n}`);
});

test('step times come from the step\'s own artifact; a missing time stays a dash, never 0', () => {
  const steps = nodeSteps(defs, mk({}), 'implementing'); // 6, 7, 8
  const t = stepTimes(steps, { 'REPORT.md': 5000 });
  assert.deepEqual(t, { 6: null, 7: null, 8: 5000 });
  assert.equal(stepTimes(steps, { 'REPORT.md': 0 })[8], null);
  assert.equal(stepTimes(steps, undefined)[8], null);
  assert.equal(stepTimes(nodeSteps(defs, mk({}), 'planning'), { 'PLAN.md': 9 })[4], 9);
});

test('durations run from the previous step that has a time, and are null without one or when out of order', () => {
  const steps = nodeSteps(defs, mk({}), 'self-review'); // 9..13
  const d = stepDurations(steps, { 9: 1000, 10: null, 11: null, 12: null, 13: 61000 });
  assert.deepEqual(d, { 9: null, 10: null, 11: null, 12: null, 13: 60000 });
  assert.equal(stepDurations(steps, { 9: 5000, 13: 1000 })[13], null);
  assert.equal(stepDurations(steps, { 9: null, 13: 1000 })[13], null);
});

test('a node starts at its earliest step time and runs to now while current, else to its last step time', () => {
  const steps = nodeSteps(defs, mk({}), 'planning');
  assert.deepEqual(nodeTiming(steps, { 3: null, 4: 1000 }, false, 9e6), { start: 1000, ran: null }, 'one time, not current: no length');
  assert.deepEqual(nodeTiming(steps, { 3: null, 4: 1000 }, true, 9000), { start: 1000, ran: 8000 });
  assert.deepEqual(nodeTiming(steps, { 3: 1000, 4: 4000 }, false, 9e6), { start: 1000, ran: 3000 });
  assert.deepEqual(nodeTiming(steps, { 3: 1000, 4: 4000 }, true, 9000), { start: 1000, ran: 8000 });
  assert.deepEqual(nodeTiming(steps, { 3: null, 4: null }, true, 9000), { start: null, ran: null });
});

test('formatting: a dash for no time, minutes under an hour', () => {
  assert.equal(fmtClock(null), '–');
  assert.match(fmtClock(Date.now()), /^\d\d:\d\d$/);
  assert.equal(fmtDur(null), '–');
  assert.equal(fmtDur(20000), '<1m');
  assert.equal(fmtDur(12 * 60000), '12m');
  assert.equal(fmtDur(75 * 60000), '1h 15m');
});

test('screen-reader text names the node, its range and every step with its state', () => {
  const s = nodeSteps(defs, mk({ 3: 'seen', 4: 'current' }), 'planning');
  assert.equal(pipsLabel('Planning', s), 'Planning, steps 3 to 4: 3 Set up seen, 4 Write the plan current. Press Enter for details.');
  assert.match(pipsLabel('Done', nodeSteps(defs, mk({ 16: 'todo' }), 'done')), /^Done, step 16: 16 Close out not reached/);
  assert.match(pipsLabel('Self-review', nodeSteps(defs, mk({ 11: 'inferred' }), 'self-review')), /11 Attack each claim inferred/);
});

test('loops are named for the nodes they touch', () => {
  assert.match(NODE_LOOP['self-review'], /10–12/);
  assert.ok(NODE_LOOP['plan-gate'] && NODE_LOOP.planning);
});
