import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
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

test('a blocked ticket is held before the first step whose artifact is missing', () => {
  const held = files => deriveStep({ stage: 'blocked', files });
  assert.deepEqual(held(['KICKOFF.md']), { step: 'planning', held: true });
  assert.deepEqual(held(['KICKOFF.md', 'PLAN.md', 'REVIEW_KICKOFF.md']), { step: 'implementing', held: true });
  assert.deepEqual(held(['PLAN.md', 'REPORT.md']), { step: 'self-review', held: true });
  assert.deepEqual(held(['PLAN.md', 'REPORT.md', 'REVIEW_REPORT.md']), { step: 'human-review', held: true });
  assert.equal(deriveStep({ stage: 'blocked', prState: 'MERGED', files: [] }).step, 'done');
});

test('parseFleet reads the six-column fleet.tsv', () => {
  assert.deepEqual(parseFleet('T-1\treview\tw1:t2\tw1:p5\tw1:p5\treleased\r\n'),
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

test('a ticket merged in one run is done in every run, and stops counting as active', async () => {
  const { runs } = await listRuns(fileURLToPath(new URL('./fixtures/runs-dup', import.meta.url)));
  const old = runs.find(r => r.epic === 'EP-10');
  assert.equal(old.tickets[0].step, 'done');
  assert.equal(old.tickets[0].mergedElsewhere, true);
  assert.equal(old.active, false);
});

test('locationsOf resolves runs and plans the way the plugin does', async () => {
  const { locationsOf } = await import('../lib/runs.mjs');
  // Repo file: nested paths, explicit runs_root wins.
  assert.deepEqual(locationsOf({ paths: { worktrees_root: 'C:/dev/Development', runs_root: 'C:/x/runs' } }), { runs: 'C:/x/runs', plans: null });
  // Repo file without runs_root: <worktrees_root>/.orchestrate-runs.
  assert.deepEqual(locationsOf({ paths: { worktrees_root: 'C:/dev/Development' } }).runs, 'C:/dev/Development/.orchestrate-runs');
  // Global plugin option: flat paths_* keys.
  assert.deepEqual(locationsOf({ paths_worktrees_root: 'C:/wt', paths_plans_dir: 'C:/wt/plans' }), { runs: 'C:/wt/.orchestrate-runs', plans: 'C:/wt/plans' });
  assert.deepEqual(locationsOf(undefined), { runs: null, plans: null });
});

test('a ticket whose PR merged on GitHub is done even when the watcher never recorded it', async () => {
  const dir = fileURLToPath(new URL('./fixtures/runs-gh', import.meta.url));
  const states = { 'https://github.com/o/r/pull/31': 'MERGED', 'https://github.com/o/r/pull/32': 'OPEN', 'https://github.com/o/r/pull/33': null };
  const asked = [];
  const { runs } = await listRuns(dir, { lookup: async url => { asked.push(url); return states[url]; } });
  const t = id => runs[0].tickets.find(x => x.ticket === id);
  // Merged: done, not inactive, though .watch-state still says OPEN.
  assert.equal(t('T-31').step, 'done');
  assert.equal(t('T-31').prState, 'MERGED');
  assert.equal(t('T-31').stale, false);
  // Still open: unchanged.
  assert.equal(t('T-32').step, 'self-review');
  assert.equal(t('T-32').stale, true);
  // gh failed: left as it was, never marked done.
  assert.equal(t('T-33').step, 'self-review');
  assert.equal(t('T-33').stale, true);
  assert.equal(asked.length, 3);
});

test('tickets already done are not looked up on GitHub', async () => {
  let called = false;
  await listRuns(fileURLToPath(new URL('./fixtures/runs-dup', import.meta.url)), { lookup: async () => { called = true; } });
  assert.equal(called, false);
});

test('a ticket carries the time of each artifact it has, and the sub-steps', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-times-'));
  try {
    const td = join(dir, 'ACME-300', 'ACME-301');
    await mkdir(td, { recursive: true });
    for (const f of ['KICKOFF.md', 'PLAN.md', 'NOTES.txt']) await writeFile(join(td, f), 'x');
    await writeFile(join(td, 'STAGE'), 'planning');
    const { runs } = await listRuns(dir, { lookup: async () => null });
    const [t] = runs[0].tickets;
    assert.deepEqual([...t.files].sort(), ['KICKOFF.md', 'PLAN.md']);
    assert.deepEqual(Object.keys(t.fileTimes).sort(), [...t.files].sort());
    for (const v of Object.values(t.fileTimes)) assert.equal(typeof v, 'number');
    assert.ok(t.fileTimes['KICKOFF.md'] > 0);
    assert.equal('NOTES.txt' in t.fileTimes, false);
    assert.equal('STAGE' in t.fileTimes, false);
    assert.equal(t.subSteps.length, 16);
    assert.equal(t.subSteps.find(x => x.state === 'current').n, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
