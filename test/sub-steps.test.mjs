import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../lib/adapters/index.mjs';
import { FLOW, settleRuns } from '../lib/runs.mjs';

const K = 'KICKOFF.md', P = 'PLAN.md', R = 'REPORT.md', RK = 'REVIEW_KICKOFF.md', RR = 'REVIEW_REPORT.md';
const URL1 = 'https://example.com/pr/1';
const STATE = { s: 'seen', i: 'inferred', c: 'current', t: 'todo' };
// One letter per step (s seen, i inferred, c current, t todo); steps after the last letter are todo.
const exp = str => [...str.padEnd(16, 't')].map((ch, k) => ({ n: k + 1, state: STATE[ch] }));
const derive = (raw, files = []) => adapter.deriveSubSteps({ ...raw, files });
const current = list => list.filter(x => x.state === 'current');

test('the adapter lists 16 sub-steps on flow nodes with a valid signal', () => {
  const list = adapter.subSteps;
  assert.deepEqual(list.map(x => x.n), Array.from({ length: 16 }, (_, k) => k + 1));
  const nodes = new Set(FLOW.map(f => f.id));
  for (const x of list) {
    assert.ok(nodes.has(x.node), `node ${x.node}`);
    assert.ok(['file', 'transcript', 'none'].includes(x.signal), `signal ${x.signal}`);
    for (const k of ['id', 'label', 'who', 'what']) assert.ok(typeof x[k] === 'string' && x[k], `${x.n} ${k}`);
  }
  assert.deepEqual(list.filter(x => x.who === 'You').map(x => x.n), [5, 15]);
  assert.deepEqual(list.filter(x => x.signal === 'transcript').map(x => x.n), [7, 11, 12]);
  assert.deepEqual(list.filter(x => x.signal === 'none').map(x => x.n), [14]);
});

test('sub-step states at each point of the flow', () => {
  const cases = [
    ['queued, no kickoff', { step: 'queued', stage: 'queued' }, [], 'c'],
    ['queued, kickoff', { step: 'queued', stage: 'queued' }, [K], 'sc'],
    ['planning, no plan', { step: 'planning', stage: 'planning' }, [K], 'ssc'],
    ['planning, plan', { step: 'planning', stage: 'planning' }, [K, P], 'ssic'],
    ['plan gate', { step: 'plan-gate', stage: 'plan-gate' }, [K, P], 'ssisc'],
    ['implementing', { step: 'implementing', stage: 'implementing' }, [K, P], 'ssisic'],
    ['fix round', { step: 'implementing', fixRound: true, stage: 'implementing', reviewStage: 'review-done' }, [K, P, R, RK, RR], 'ssisicttsiiisttt'],
    ['fix round, review running', { step: 'implementing', fixRound: true, stage: 'implementing', reviewStage: 'review-running' }, [K, P, R, RK], 'ssisicttss'],
    ['fix round failed', { step: 'implementing', failed: true, stage: 'failed', reviewStage: 'review-done' }, [K, P, R, RK, RR], 'ssisicttsiiis'],
    ['self-review, report done', { step: 'self-review', stage: 'report-done', pr: URL1 }, [K, P, R, RK], 'ssisiiisc'],
    ['self-review, review running', { step: 'self-review', stage: 'report-done', reviewStage: 'review-running', pr: URL1 }, [K, P, R, RK], 'ssisiiissc'],
    ['human review', { step: 'human-review', stage: 'report-done', reviewStage: 'review-done', prState: 'OPEN', pr: URL1 }, [K, P, R, RK, RR], 'ssisiiissiiisict'],
    ['held before planning', { step: 'planning', held: true, stage: 'blocked' }, [K], 'ssc'],
    ['held before implementing', { step: 'implementing', held: true, stage: 'blocked' }, [K, P], 'ssisic'],
    ['held before self-review', { step: 'self-review', held: true, stage: 'blocked' }, [K, P, R], 'ssisiiiic'],
    ['held before human review', { step: 'human-review', held: true, stage: 'blocked' }, [K, P, R, RK, RR], 'ssisiiiisiiiiict'],
    ['failed implementing', { step: 'implementing', failed: true, stage: 'failed' }, [K, P], 'ssisic'],
    ['review failed', { step: 'self-review', failed: true, stage: 'report-done', reviewStage: 'review-failed', pr: URL1 }, [K, P, R, RK], 'ssisiiisc'],
    ['merged', { step: 'done', stage: 'report-done', reviewStage: 'review-done', prState: 'MERGED', pr: URL1 }, [K, P, R, RK, RR], 'ssisiiissiiisiis'],
  ];
  for (const [name, raw, files, want] of cases) assert.deepEqual(derive(raw, files), exp(want), name);
});

test('every raw state gives the sub-step on the node deriveStep names', () => {
  const stages = [undefined, 'queued', 'planning', 'plan-gate', 'implementing', 'report-done', 'blocked', 'failed', 'junk'];
  const reviews = [undefined, 'review-running', 'review-done', 'review-failed'];
  const states = [undefined, 'OPEN', 'MERGED'];
  const fileSets = [[], [K], [K, P], [K, P, R], [K, P, R, RK], [K, P, R, RK, RR]];
  let n = 0;
  for (const stage of stages) for (const reviewStage of reviews) for (const prState of states) {
    for (const files of fileSets) for (const pr of [null, URL1]) {
      const raw = { stage, reviewStage, prState, files }, d = adapter.deriveStep(raw);
      const s = adapter.deriveSubSteps({ ...raw, ...d, pr }), label = JSON.stringify({ ...raw, pr });
      assert.equal(s.length, 16, label); n++;
      if (d.step === 'done') {
        assert.equal(current(s).length, 0, label);
        assert.ok(s.every(x => x.state === 'seen' || x.state === 'inferred'), label);
        assert.equal(s[15].state, 'seen', label);
      } else {
        assert.equal(current(s).length, 1, label);
        assert.equal(adapter.subSteps.find(x => x.n === current(s)[0].n).node, d.step, label);
      }
    }
  }
  assert.equal(n, stages.length * reviews.length * states.length * fileSets.length * 2);
});

const ticket = (extra = {}) => {
  const raw = { stage: 'report-done', reviewStage: 'review-done', files: [K, P, R, RK, RR], pr: URL1 };
  return { ticket: 'ACME-1', ...raw, ...adapter.deriveStep(raw), active: false, panes: [], ...extra };
};
const withSubs = t => ({ ...t, subSteps: adapter.deriveSubSteps(t) });

test('settleRuns re-derives sub-steps for merged tickets and leaves peer tickets without them alone', async () => {
  const mine = withSubs(ticket());
  const copy = withSubs(ticket({ stage: 'implementing', reviewStage: undefined, step: 'implementing', pr: null, files: [K, P] }));
  const peer = ticket({ ticket: 'ACME-2' });
  const runs = [
    { epic: 'ACME-10', root: 'x', tickets: [mine, peer], updatedAt: 1, active: false },
    { epic: 'ACME-11', root: 'x', tickets: [copy], updatedAt: 2, active: false },
  ];
  const out = await settleRuns(runs, { lookup: async u => u === URL1 ? 'MERGED' : null });
  assert.equal(mine.step, 'done');
  assert.equal(mine.subSteps[15].state, 'seen');
  assert.equal(current(mine.subSteps).length, 0);
  assert.equal(copy.mergedElsewhere, true);
  assert.equal(copy.subSteps[15].state, 'seen');
  assert.equal(current(copy.subSteps).length, 0);
  assert.equal('subSteps' in peer, false);
  assert.deepEqual(out.subSteps, adapter.subSteps);
  assert.deepEqual(out.stepFiles, adapter.stepFiles);
});
