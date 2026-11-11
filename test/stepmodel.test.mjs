import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
// Independent of this machine's .env: pin the exclusion before the modules read it.
process.env.MC_EXCLUDE = String.raw`C:/dev/ACME-private|ACME-vault`;
const { default: adapter } = await import('../lib/adapters/orchestration-plugin.mjs');
const { foldReplies, readRuns, stepRows, roleRows, spansByTicket, ticketModels } = await import('../lib/stepmodel.mjs');
const { mergeStepModels } = await import('../lib/peers.mjs');

const t = n => Date.parse(`2026-11-03T10:${String(n).padStart(2, '0')}:00Z`);
const reply = (n, model, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: new Date(t(n)).toISOString(), message: { model, content: [] }, ...extra });
const FLOW = ['queued', 'planning', 'plan-gate', 'implementing', 'self-review', 'human-review', 'done'];

test('adapter replyOf: model and effort from an assistant record; no effort field is unknown, never a guess', () => {
  const r = adapter.replyOf(JSON.parse(reply(1, 'acme-model-1', { effort: 'high', perTurnEffort: 'low' })));
  assert.deepEqual(r, { model: 'acme-model-1', effort: 'high', at: t(1) });
  assert.equal(adapter.replyOf(JSON.parse(reply(1, 'acme-model-1', { perTurnEffort: 'low' }))).effort, 'low');
  assert.equal(adapter.replyOf(JSON.parse(reply(1, 'acme-model-1'))).effort, null);
  assert.equal(adapter.replyOf(JSON.parse(reply(1, 'acme-model-1', { effort: 5 }))).effort, null);
  assert.equal(adapter.replyOf(JSON.parse(reply(1, '<synthetic>'))), null);
  assert.equal(adapter.replyOf({ type: 'user', message: { model: 'acme-model-1' } }), null);
});

test('adapter roleConfig: orchestrator.effort is the planner effort, orchestrator.model is ignored, no key is null', () => {
  const c = adapter.roleConfig({ agents: { orchestrator: { model: 'acme-ignored', effort: 'high' }, implementer: { model: 'acme-impl' }, reviewer: { model: 'acme-rev', effort: 'low' } } });
  assert.deepEqual(c, { planner: { model: null, effort: 'high' }, implementer: { model: 'acme-impl', effort: null }, reviewer: { model: 'acme-rev', effort: 'low' } });
  assert.equal(adapter.roleConfig({ agents: { planner: { model: 'acme-plan' }, orchestrator: { model: 'acme-ignored' } } }).planner.model, 'acme-plan');
  assert.deepEqual(adapter.roleConfig(undefined).planner, { model: null, effort: null });
  assert.equal(adapter.roleConfig({ agents: { planner: { model: '', effort: 7 } } }).planner.model, null);
});

test('adapter launchOf and configured: the launch record comes first, then the config, else null', () => {
  const l = adapter.launchOf('role=planner mode=pane model=acme-launched effort=- model_source=flag effort_source=-\n');
  assert.deepEqual(l, { role: 'planner', model: 'acme-launched', effort: null });
  assert.equal(adapter.launchOf('role=reviewer mode=pane model=unset effort=high').model, null);
  assert.equal(adapter.launchOf('not a record'), null);
  assert.equal(adapter.launchOf(null), null);
  const cfg = { agents: { planner: { model: 'acme-cfg' }, orchestrator: { effort: 'medium' }, reviewer: { model: 'acme-rev' } } };
  const c = adapter.configured(cfg, [l, adapter.launchOf('role=reviewer model=- effort=-')]);
  assert.deepEqual(c.planner, { model: 'acme-launched', effort: 'medium' });
  assert.deepEqual(c.reviewer, { model: 'acme-rev', effort: null });
  assert.deepEqual(c.implementer, { model: null, effort: null });
});

test('adapter roleOfStep, actorOf, boundaryOf and stepWindow', () => {
  assert.deepEqual(adapter.roleOfStep('implementing'), ['planner', 'implementer']);
  assert.deepEqual(adapter.roleOfStep('plan-gate'), ['planner']);
  assert.deepEqual(adapter.roleOfStep('self-review'), ['reviewer']);
  assert.deepEqual(adapter.roleOfStep('done'), []);
  assert.equal(adapter.actorOf({ role: 'implementer', sub: false }), 'planner');
  assert.equal(adapter.actorOf({ role: 'implementer', sub: true }), 'implementer');
  assert.equal(adapter.actorOf({ role: 'reviewer', sub: true }), 'reviewer');
  assert.equal(adapter.actorOf({ role: 'you', sub: false }), null);
  // The first implementer reply is the boundary; else the plan's write time; else none.
  assert.equal(adapter.boundaryOf([{ actor: 'implementer', from: 50 }, { actor: 'implementer', from: 40 }, { actor: 'planner', from: 5 }], { plan: 10 }), 40);
  assert.equal(adapter.boundaryOf([{ actor: 'planner', from: 5 }], { plan: 10 }), 10);
  assert.equal(adapter.boundaryOf([], {}), null);
  assert.deepEqual(adapter.stepWindow('planning', 'planner', 40), [null, 40]);
  assert.deepEqual(adapter.stepWindow('implementing', 'planner', 40), [40, null]);
  assert.deepEqual(adapter.stepWindow('implementing', 'implementer', 40), [null, null]);
  assert.deepEqual(adapter.stepWindow('planning', 'planner', null), [null, null]);
});

test('foldReplies: transcript lines become spans of model and effort', () => {
  const runs = foldReplies([reply(1, 'acme-a', { effort: 'medium' }), reply(2, 'acme-a', { effort: 'medium' }), 'not json "model"',
    JSON.stringify({ type: 'user', message: { content: 'hello' } }), reply(3, 'acme-b'), reply(4, 'acme-a', { effort: 'medium' })]);
  assert.deepEqual(runs, [{ model: 'acme-a', effort: 'medium', from: t(1), to: t(2) }, { model: 'acme-b', effort: null, from: t(3), to: t(3) },
    { model: 'acme-a', effort: 'medium', from: t(4), to: t(4) }]);
});

const config = { planner: { model: 'acme-plan', effort: 'high' }, implementer: { model: 'acme-impl', effort: null }, reviewer: { model: null, effort: null } };
const ran = [
  { actor: 'planner', model: 'acme-p', effort: 'medium', from: t(1), to: t(24) },
  { actor: 'planner', model: 'acme-q', effort: null, from: t(26), to: t(40) },
  { actor: 'implementer', model: 'acme-i', effort: 'low', from: t(25), to: t(35) },
  { actor: 'implementer', model: 'acme-j', effort: null, from: t(30), to: t(36) },
];

test('stepRows: a step that ran shows what ran, split at the implementer\'s first reply; models are all listed', () => {
  const m = ticketModels({ flow: FLOW, current: 'self-review', ran, config, times: {} });
  assert.deepEqual(m.steps.planning, [{ role: 'planner', source: 'ran', model: ['acme-p'], effort: ['medium'] }]);
  assert.deepEqual(m.steps.implementing, [{ role: 'planner', source: 'ran', model: ['acme-q'], effort: [] },
    { role: 'implementer', source: 'ran', model: ['acme-i', 'acme-j'], effort: ['low'] }]);
});

test('stepRows: a step not reached shows the configured values, marked; unknown stays unknown', () => {
  const m = ticketModels({ flow: FLOW, current: 'planning', ran: ran.slice(0, 1), config, times: {} });
  assert.deepEqual(m.steps.implementing[1], { role: 'implementer', source: 'configured', model: ['acme-impl'], effort: [] });
  assert.deepEqual(m.steps['self-review'], [{ role: 'reviewer', source: null, model: [], effort: [] }]);
  // A step reached with nothing read is unknown, not the configured value.
  const none = stepRows('planning', { ran: [], config });
  assert.deepEqual(none, [{ role: 'planner', source: null, model: [], effort: [] }]);
  assert.deepEqual(stepRows('done', { config }), []);
});

test('a transcript with no effort field and a config with no effort key both give an empty effort', () => {
  const rows = stepRows('self-review', { ran: [{ actor: 'reviewer', model: 'acme-r', effort: null, from: t(1), to: t(2) }], config });
  assert.deepEqual(rows, [{ role: 'reviewer', source: 'ran', model: ['acme-r'], effort: [] }]);
  const cfg = stepRows('self-review', { reached: false, config: { reviewer: { model: 'acme-r', effort: null } } });
  assert.deepEqual(cfg, [{ role: 'reviewer', source: 'configured', model: ['acme-r'], effort: [] }]);
});

test('with no reliable boundary the planner\'s one session shows its values for each of its steps', () => {
  const only = [{ actor: 'planner', model: 'acme-p', effort: 'medium', from: t(1), to: t(20) }];
  const m = ticketModels({ flow: FLOW, current: 'implementing', ran: only, config, times: {} });
  assert.equal(m.steps.planning[0].model[0], 'acme-p');
  assert.equal(m.steps.implementing[0].model[0], 'acme-p');
});

test('roleRows: one row per role, from what ran or else the configured values', () => {
  const rows = roleRows({ ran, config });
  assert.deepEqual(rows.map(r => [r.role, r.source]), [['planner', 'ran'], ['implementer', 'ran'], ['reviewer', null]]);
  assert.equal(roleRows({ ran: [], config })[0].source, 'configured');
});

test('mergeStepModels keys a peer\'s tickets by machine and skips ones it got from elsewhere', () => {
  const out = mergeStepModels({ 'ACME-1': 'mine' }, [{ name: 'box', value: { tickets: { 'ACME-1': 'theirs', 'other|ACME-2': 'third' } } }]);
  assert.deepEqual(out, { 'ACME-1': 'mine', 'box|ACME-1': 'theirs' });
});

test('spansByTicket reads the sessions Usage attributes to a ticket, by role, and never an excluded one', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-stepmodel-'));
  const write = async (rel, lines) => { await mkdir(join(dir, rel, '..'), { recursive: true }); await writeFile(join(dir, rel), lines.join('\n') + '\n'); };
  await write('p-acme/s1.jsonl', [reply(1, 'acme-worker', { effort: 'medium' })]);
  await write('p-acme/s1/subagents/agent-a1.jsonl', [reply(2, 'acme-sub', { effort: 'low' })]);
  await write('p-acme/s2.jsonl', [reply(3, 'acme-rev', { effort: 'high' })]);
  await write('p-acme/s3.jsonl', [reply(4, 'acme-other')]);
  await write('p-acme/s4.jsonl', [reply(5, 'acme-hidden')]);
  await write('ACME-vault/s5.jsonl', [reply(6, 'acme-hidden')]);
  const wt = n => `C:/dev/acme-wt-ACME-${n}`;
  const files = {
    'p-acme/s1.jsonl': { cwd: wt(1), reviewer: false }, 'p-acme/s1/subagents/agent-a1.jsonl': { cwd: wt(1), reviewer: false },
    'p-acme/s2.jsonl': { cwd: wt(1), reviewer: true }, 'p-acme/s3.jsonl': { cwd: wt(2), reviewer: false },
    'p-acme/s4.jsonl': { cwd: wt(1), reviewer: false, excluded: true }, 'ACME-vault/s5.jsonl': { cwd: wt(1), reviewer: false },
    'p-acme/gone.jsonl': { cwd: wt(1), reviewer: false },
  };
  const by = await spansByTicket(files, [], dir);
  const one = by.get('ACME-1');
  assert.deepEqual(one.map(s => [s.actor, s.model, s.effort]).sort(), [['implementer', 'acme-sub', 'low'], ['planner', 'acme-worker', 'medium'], ['reviewer', 'acme-rev', 'high']]);
  assert.deepEqual(by.get('ACME-2').map(s => s.model), ['acme-other']);
  // A transcript under an excluded path is never opened.
  assert.deepEqual(await readRuns(join(dir, 'ACME-vault', 's5.jsonl')), []);
});
