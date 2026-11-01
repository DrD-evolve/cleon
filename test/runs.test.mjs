import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deriveStep, parseFleet, listRuns, readRunFile } from '../lib/runs.mjs';

const FIX = fileURLToPath(new URL('./fixtures/runs', import.meta.url));

test('deriveStep maps stage files to flow steps', () => {
  assert.equal(deriveStep({ prState: 'MERGED', stage: 'implementing' }).step, 'done');
  assert.equal(deriveStep({ stage: 'plan-gate' }).step, 'plan-gate');
  assert.deepEqual(deriveStep({ stage: 'implementing', reviewStage: 'review-done' }), { step: 'implementing', fixRound: true });
  assert.equal(deriveStep({ stage: 'report-done' }).step, 'self-review');
  assert.equal(deriveStep({ stage: 'report-done', reviewStage: 'review-running' }).step, 'self-review');
  assert.equal(deriveStep({ stage: 'report-done', reviewStage: 'review-done', prState: 'OPEN' }).step, 'human-review');
  assert.deepEqual(deriveStep({ stage: 'report-done', reviewStage: 'review-failed' }), { step: 'self-review', failed: true });
  assert.equal(deriveStep({}).step, 'queued');
});

test('parseFleet reads the six-column fleet.tsv', () => {
  assert.deepEqual(parseFleet('T-1\treview\tw1:t2\tw1:p5\tw1:p5\treleased\n'),
    [{ ticket: 'T-1', role: 'review', tab: 'w1:t2', pane: 'w1:p5', lane: 'released' }]);
});

test('listRuns builds epics from a run directory', async () => {
  const { runs } = await listRuns(FIX);
  assert.equal(runs.length, 1);
  const [t] = runs[0].tickets;
  assert.equal(runs[0].label, 'Sample epic');
  assert.equal(t.step, 'implementing');
  assert.equal(t.fixRound, true);
  assert.equal(t.active, true);
  assert.equal(t.stale, false);
  assert.deepEqual(t.files, ['PLAN.md']);
});

test('readRunFile only serves whitelisted artifacts', async () => {
  assert.equal(await readRunFile('EP-1', 'T-1', 'PLAN.md', FIX), '# plan');
  assert.equal(await readRunFile('EP-1', 'T-1', 'STAGE', FIX), null);
  assert.equal(await readRunFile('..', 'T-1', 'PLAN.md', FIX), null);
  assert.equal(await readRunFile('EP-1', '../../x', 'PLAN.md', FIX), null);
});
