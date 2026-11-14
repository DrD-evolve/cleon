import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
// Independent of this machine's .env: pin the exclusion before the modules read it.
process.env.MC_EXCLUDE = String.raw`C:/dev/ACME-private|ACME-vault`;
const { default: adapter } = await import('../lib/adapters/orchestration-plugin.mjs');
const { foldReplies, readRuns, stepRows, roleRows, spansByTicket, ticketModels } = await import('../lib/stepmodel.mjs');
const { mergeStepModels } = await import('../lib/peers.mjs');
const { ticketLaunches } = await import('../lib/runs.mjs');

const t = n => Date.parse(`2026-11-03T10:${String(n).padStart(2, '0')}:00Z`);
const at = n => new Date(t(n)).toISOString();
const reply = (n, model, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: at(n), message: { model, content: [] }, ...extra });
// A plan-gate question (asked in a reply) and its answer (a tool result).
const ask = (n, id) => JSON.stringify({ type: 'assistant', timestamp: at(n), message: { model: 'acme-p', content: [
  { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ header: 'Plan gate', question: 'Approve the ACME-1 plan?' }] } }] } });
const answer = (n, id) => JSON.stringify({ type: 'user', timestamp: at(n), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Approve' }] } });
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
  // A Codex reviewer: the Claude review session runs on the planner's values, never the Codex model.
  const codex = adapter.roleConfig({ agents: { planner: { model: 'acme-plan', effort: 'high' }, reviewer: { executor: 'codex', model: 'acme-codex' } } });
  assert.deepEqual(codex.reviewer, { model: 'acme-plan', effort: 'high' });
});

test('adapter launchOf and configured: the launch record when there is one (a "-" stays unknown), else the config, else null', () => {
  const l = adapter.launchOf('role=planner mode=pane model=acme-launched effort=- model_source=flag effort_source=-\n');
  assert.deepEqual(l, { role: 'planner', model: 'acme-launched', effort: null });
  assert.equal(adapter.launchOf('role=reviewer mode=pane model=unset effort=high').model, null);
  assert.equal(adapter.launchOf('not a record'), null);
  assert.equal(adapter.launchOf(null), null);
  const cfg = { agents: { planner: { model: 'acme-cfg' }, orchestrator: { effort: 'medium' }, reviewer: { model: 'acme-rev' } } };
  // The pane started without --effort (and the reviewer without either flag): the config's values never stand in.
  const c = adapter.configured(cfg, [l, adapter.launchOf('role=reviewer model=- effort=-')]);
  assert.deepEqual(c.planner, { model: 'acme-launched', effort: null });
  assert.deepEqual(c.reviewer, { model: null, effort: null });
  assert.deepEqual(c.implementer, { model: null, effort: null });
  assert.deepEqual(adapter.configured(cfg, []).planner, { model: 'acme-cfg', effort: 'medium' });
});

test('ticketLaunches reads the ticket folder\'s launch records', async () => {
  const runs = await mkdtemp(join(os.tmpdir(), 'cleon-launch-'));
  await mkdir(join(runs, 'ACME-1', 'ACME-2'), { recursive: true });
  await writeFile(join(runs, 'ACME-1', 'ACME-2', 'LAUNCH_implement'), 'role=planner mode=pane model=acme-p effort=- model_source=flag effort_source=-\n');
  await writeFile(join(runs, 'ACME-1', 'ACME-2', 'LAUNCH_review'), 'role=reviewer mode=pane model=acme-r effort=high model_source=config effort_source=config\n');
  assert.deepEqual(await ticketLaunches(runs, 'ACME-1', 'ACME-2'), [{ role: 'planner', model: 'acme-p', effort: null }, { role: 'reviewer', model: 'acme-r', effort: 'high' }]);
  assert.deepEqual(await ticketLaunches(runs, 'ACME-1', 'ACME-3'), []);
});

test('adapter roleOfStep, actorOf, boundaryOf and stepWindow', () => {
  assert.deepEqual(adapter.roleOfStep('implementing'), ['planner', 'implementer']);
  assert.deepEqual(adapter.roleOfStep('plan-gate'), ['planner']);
  assert.deepEqual(adapter.roleOfStep('self-review'), ['reviewer']);
  // Nobody runs these: before the worker starts, your review, and after the merge.
  for (const s of ['queued', 'human-review', 'done']) assert.deepEqual(adapter.roleOfStep(s), []);
  assert.equal(adapter.actorOf({ role: 'implementer', sub: false }), 'planner');
  assert.equal(adapter.actorOf({ role: 'implementer', sub: true }), 'implementer');
  assert.equal(adapter.actorOf({ role: 'reviewer', sub: true }), 'reviewer');
  assert.equal(adapter.actorOf({ role: 'you', sub: false }), null);
  // The last plan-gate answer is the boundary (a redirected plan is asked again); else the first subagent reply; else none.
  const subs = [{ actor: 'implementer', from: 50 }, { actor: 'implementer', from: 40 }, { actor: 'planner', from: 5 }];
  assert.equal(adapter.boundaryOf(subs, [20, 30]), 30);
  assert.equal(adapter.boundaryOf(subs, []), 40);
  assert.equal(adapter.boundaryOf([{ actor: 'planner', from: 5 }], []), null);
  assert.deepEqual(adapter.stepWindow('planning', 'planner', 40), [null, 40]);
  assert.deepEqual(adapter.stepWindow('implementing', 'planner', 40), [40, null]);
  assert.deepEqual(adapter.stepWindow('implementing', 'implementer', 40), [40, null]);
  assert.deepEqual(adapter.stepWindow('self-review', 'reviewer', 40), [null, null]);
  assert.deepEqual(adapter.stepWindow('planning', 'planner', null), [null, null]);
  // A gate answer is the tool result for a gate question asked earlier in the same transcript.
  const asked = new Set();
  assert.equal(adapter.gateAnswerOf(JSON.parse(ask(10, 'toolu_acme1')), asked), null);
  assert.equal(adapter.gateAnswerOf(JSON.parse(answer(11, 'toolu_other')), asked), null);
  assert.equal(adapter.gateAnswerOf(JSON.parse(answer(12, 'toolu_acme1')), asked), t(12));
});

test('foldReplies: transcript lines become spans of model and effort, and plan-gate answers', () => {
  const { runs, gates } = foldReplies([reply(1, 'acme-a', { effort: 'medium' }), reply(2, 'acme-a', { effort: 'medium' }), 'not json "model"',
    JSON.stringify({ type: 'user', message: { content: 'hello' } }), reply(3, 'acme-b'), reply(4, 'acme-a', { effort: 'medium' }),
    answer(5, 'toolu_acme9'), ask(6, 'toolu_acme9'), answer(7, 'toolu_acme9')]);
  assert.deepEqual(runs, [{ model: 'acme-a', effort: 'medium', from: t(1), to: t(2) }, { model: 'acme-b', effort: null, from: t(3), to: t(3) },
    { model: 'acme-a', effort: 'medium', from: t(4), to: t(4) }, { model: 'acme-p', effort: null, from: t(6), to: t(6) }]);
  assert.deepEqual(gates, [t(7)]); // the result at :05 came before its question
});

test('readRuns reads whole lines only: an unfinished last line is read once it ends', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-readruns-')), f = join(dir, 's.jsonl');
  const second = reply(2, 'acme-b');
  await writeFile(f, `${reply(1, 'acme-a')}\n${second.slice(0, 20)}`);
  assert.deepEqual((await readRuns(f)).runs.map(r => r.model), ['acme-a']);
  await appendFile(f, `${second.slice(20)}\n`);
  assert.deepEqual((await readRuns(f)).runs.map(r => r.model), ['acme-a', 'acme-b']);
});

const config = { planner: { model: 'acme-plan', effort: 'high' }, implementer: { model: 'acme-impl', effort: null }, reviewer: { model: null, effort: null } };
const ran = [
  { actor: 'planner', model: 'acme-p', effort: 'medium', from: t(1), to: t(24) },
  { actor: 'planner', model: 'acme-q', effort: null, from: t(26), to: t(40) },
  { actor: 'implementer', model: 'acme-i', effort: 'low', from: t(25), to: t(35) },
  { actor: 'implementer', model: 'acme-j', effort: null, from: t(30), to: t(36) },
];

test('stepRows: a step that ran shows what ran, split at the implementer\'s first reply; models are all listed', () => {
  const m = ticketModels({ flow: FLOW, current: 'self-review', ran, config });
  assert.deepEqual(m.steps.planning, [{ role: 'planner', source: 'ran', model: ['acme-p'], effort: ['medium'] }]);
  assert.deepEqual(m.steps.implementing, [{ role: 'planner', source: 'ran', model: ['acme-q'], effort: [] },
    { role: 'implementer', source: 'ran', model: ['acme-i', 'acme-j'], effort: ['low'] }]);
});

test('stepRows: a step not reached shows the configured values, marked; unknown stays unknown', () => {
  const m = ticketModels({ flow: FLOW, current: 'planning', ran: ran.slice(0, 1), config });
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
  const m = ticketModels({ flow: FLOW, current: 'implementing', ran: only, config });
  assert.equal(m.steps.planning[0].model[0], 'acme-p');
  assert.equal(m.steps.implementing[0].model[0], 'acme-p');
});

test('roleRows: one row per role, from what ran or else the configured values', () => {
  const rows = roleRows({ ran, config });
  assert.deepEqual(rows.map(r => [r.role, r.source]), [['planner', 'ran'], ['implementer', 'ran'], ['reviewer', null]]);
  assert.equal(roleRows({ ran: [], config })[0].source, 'configured');
  // A role whose steps were reached with nothing read (the worker edited itself; a transcript gone) is unknown.
  const done = ticketModels({ flow: FLOW, current: 'done', ran: ran.slice(0, 2), config });
  assert.deepEqual(done.roles.find(r => r.role === 'implementer'), { role: 'implementer', source: null, model: [], effort: [] });
});

test('the plan-gate answer splits planning from implementing, wherever the plan file was rewritten', () => {
  // Opus planned; the gate was answered at :11; the worker switched to Sonnet and edited itself (no subagent).
  const w = [{ actor: 'planner', model: 'acme-opus', effort: 'high', from: t(1), to: t(10) }, { actor: 'planner', model: 'acme-sonnet', effort: 'medium', from: t(12), to: t(40) }];
  const m = ticketModels({ flow: FLOW, current: 'self-review', ran: w, gates: [t(11)], config });
  assert.deepEqual(m.steps.planning[0].model, ['acme-opus']);
  assert.deepEqual(m.steps.implementing[0].model, ['acme-sonnet']);
  // A subagent the worker ran while planning is not the implementer.
  const explore = { actor: 'implementer', model: 'acme-explore', effort: null, from: t(3), to: t(4) };
  const m2 = ticketModels({ flow: FLOW, current: 'self-review', ran: [...w, explore], gates: [t(11)], config });
  assert.deepEqual(m2.steps.implementing[1], { role: 'implementer', source: null, model: [], effort: [] });
});

test('nobody runs queued or human-review; a review that sent the ticket back still shows what ran it', () => {
  const rev = { actor: 'reviewer', model: 'acme-rev', effort: 'high', from: t(50), to: t(55) };
  const done = ticketModels({ flow: FLOW, current: 'done', ran: [...ran, rev], config });
  assert.deepEqual(done.steps.queued, []);
  assert.deepEqual(done.steps['human-review'], []);
  // Fix round: back at implementing after the review ran, so self-review is reached and shows the reviewer.
  const fix = ticketModels({ flow: FLOW, current: 'implementing', furthest: 'self-review', ran: [...ran, rev], config });
  assert.deepEqual(fix.steps['self-review'], [{ role: 'reviewer', source: 'ran', model: ['acme-rev'], effort: ['high'] }]);
  assert.equal(fix.roles.find(r => r.role === 'reviewer').source, 'ran');
});

test('mergeStepModels keys a peer\'s tickets by machine and skips ones it got from elsewhere', () => {
  const out = mergeStepModels({ 'ACME-1': 'mine' }, [{ name: 'box', value: { tickets: { 'ACME-1': 'theirs', 'other|ACME-2': 'third' } } }]);
  assert.deepEqual(out, { 'ACME-1': 'mine', 'box|ACME-1': 'theirs' });
});

test('spansByTicket reads the sessions Usage attributes to a ticket, by role, and never an excluded one', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-stepmodel-'));
  const write = async (rel, lines) => { await mkdir(join(dir, rel, '..'), { recursive: true }); await writeFile(join(dir, rel), lines.join('\n') + '\n'); };
  await write('p-acme/s1.jsonl', [reply(1, 'acme-worker', { effort: 'medium' }), ask(1, 'toolu_acme1'), answer(2, 'toolu_acme1')]);
  await write('p-acme/s1/subagents/agent-a1.jsonl', [reply(2, 'acme-sub', { effort: 'low' })]);
  await write('p-acme/s2.jsonl', [reply(3, 'acme-rev', { effort: 'high' }), ask(3, 'toolu_acme2'), answer(4, 'toolu_acme2')]);
  // The reviewer's helper: its opening prompt isn't a reviewer's, so only its parent makes it the reviewer's.
  await write('p-acme/s2/subagents/agent-r1.jsonl', [reply(4, 'acme-finder', { effort: 'high' })]);
  await write('p-acme/s3.jsonl', [reply(4, 'acme-other')]);
  await write('p-acme/s4.jsonl', [reply(5, 'acme-hidden')]);
  await write('ACME-vault/s5.jsonl', [reply(6, 'acme-hidden')]);
  await write('p-acme/s6.jsonl', [reply(7, 'acme-hidden')]);
  const wt = n => `C:/dev/acme-wt-ACME-${n}`;
  const files = {
    'p-acme/s1.jsonl': { cwd: wt(1), reviewer: false }, 'p-acme/s1/subagents/agent-a1.jsonl': { cwd: wt(1), reviewer: false },
    'p-acme/s2.jsonl': { cwd: wt(1), reviewer: true }, 'p-acme/s2/subagents/agent-r1.jsonl': { cwd: wt(1), reviewer: false },
    'p-acme/s3.jsonl': { cwd: wt(2), reviewer: false },
    'p-acme/s4.jsonl': { cwd: wt(1), reviewer: false, excluded: true }, 'ACME-vault/s5.jsonl': { cwd: wt(1), reviewer: false },
    // Its folder matches MC_EXCLUDE (written with the other slash), though the ledger read it before that.
    'p-acme/s6.jsonl': { cwd: String.raw`C:\dev\ACME-private\acme-wt-ACME-1`, reviewer: false, excluded: false },
    'p-acme/gone.jsonl': { cwd: wt(1), reviewer: false },
  };
  const by = await spansByTicket(files, [], dir);
  const one = by.get('ACME-1');
  assert.deepEqual(one.ran.map(s => [s.actor, s.model, s.effort]).sort(),
    [['implementer', 'acme-sub', 'low'], ['planner', 'acme-p', null], ['planner', 'acme-worker', 'medium'], ['reviewer', 'acme-finder', 'high'], ['reviewer', 'acme-p', null], ['reviewer', 'acme-rev', 'high']]);
  // Only the worker's gate answers count: the reviewer's dialogs don't end planning.
  assert.deepEqual(one.gates, [t(2)]);
  assert.deepEqual(by.get('ACME-2').ran.map(s => s.model), ['acme-other']);
  // A transcript under an excluded path is never opened.
  assert.deepEqual((await readRuns(join(dir, 'ACME-vault', 's5.jsonl'))).runs, []);
});

// A reply that makes tool calls, for the steps only transcripts show.
const tool = (n, name, input, model = 'acme-p') => JSON.stringify({ type: 'assistant', timestamp: at(n), message: { model, content: [{ type: 'tool_use', id: `toolu_${n}`, name, input }] } });
const bash = (n, command) => tool(n, 'Bash', { command });
const ATTACKS = '{"findings":[],"attacks":[{"claim":"ACME claim text"}]}';

test('adapter stepEventOf: verify, attack record and push, as times only; a configured verify command wins', () => {
  const ev = (line, ctx) => adapter.stepEventOf(JSON.parse(line), ctx);
  assert.deepEqual(ev(bash(3, 'cd C:/dev/acme && npm test 2>&1 | tail -5')), [{ n: 7, at: t(3) }]);
  assert.deepEqual(ev(bash(3, 'npm test'), { verify: 'acme-verify.sh' }), []);
  assert.deepEqual(ev(bash(3, 'bash acme-verify.sh --all'), { verify: 'acme-verify.sh' }), [{ n: 7, at: t(3) }]);
  assert.deepEqual(ev(bash(4, 'findings-artifact.sh assert acme.json --require-attacks')), [{ n: 11, at: t(4) }]);
  assert.deepEqual(ev(tool(4, 'Write', { file_path: 'C:/runs/ACME-1/FINDINGS.json', content: ATTACKS })), [{ n: 11, at: t(4) }]);
  assert.deepEqual(ev(tool(4, 'Write', { file_path: 'C:/runs/ACME-1/FINDINGS.json', content: '{"findings":[]}' })), []);
  assert.deepEqual(ev(tool(4, 'Write', { file_path: 'C:/runs/ACME-1/notes.md', content: ATTACKS })), []);
  for (const push of ['git push origin acme', 'git -C "C:/dev/acme wt" push -u origin acme', 'git -c credential.helper= -c "credential.helper=!gh auth git-credential" push'])
    assert.deepEqual(ev(bash(5, push)), [{ n: 12, at: t(5) }], push);
  assert.deepEqual(ev(bash(5, 'git commit -m "fix: push the button"')), []);
  assert.deepEqual(ev(bash(5, 'git status')), []);
  assert.deepEqual(adapter.stepEventOf({ type: 'user', timestamp: at(5), message: { content: 'npm test' } }), []);
});

test('adapter seenSteps: 7 is the worker first verify after the boundary, 11 the reviewer first attack record, 12 its first push after 11', () => {
  const e = (actor, n, m) => ({ actor, n, at: t(m) });
  const events = [e('planner', 7, 1), e('planner', 7, 6), e('planner', 7, 8), e('reviewer', 7, 2), e('reviewer', 12, 9), e('reviewer', 11, 10), e('reviewer', 12, 12), e('reviewer', 12, 14), e('planner', 11, 3)];
  assert.deepEqual(adapter.seenSteps(events, t(5)), { 7: t(6), 11: t(10), 12: t(12) });
  assert.deepEqual(adapter.seenSteps(events, null)[7], t(1));
  assert.deepEqual(adapter.seenSteps([e('reviewer', 12, 9)], null), {}); // a push before any attack record is not a re-gate
  assert.deepEqual(adapter.seenSteps([], t(5)), {});
  assert.equal(adapter.verifyCommand({ checks: { verify_command: ' npm run acme ' } }), 'npm run acme');
  assert.equal(adapter.verifyCommand({ checks: { verify_command: '' } }), null);
  assert.equal(adapter.verifyCommand({}), null);
});

test('foldReplies keeps step events as times only, and still skips lines that are not replies or gate answers', () => {
  const secret = 'ACME-SECRET-COMMAND';
  const lines = [
    reply(1, 'acme-p', { effort: 'high' }), bash(2, `npm test # ${secret}`), tool(3, 'Write', { file_path: 'C:/x/FINDINGS.json', content: ATTACKS }),
    JSON.stringify({ type: 'user', timestamp: at(4), message: { content: `a prompt about ${secret}` } }),
    JSON.stringify({ type: 'attachment', timestamp: at(4), attachment: { text: secret } }),
    JSON.stringify({ type: 'user', timestamp: at(5), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_other', content: secret }] } }),
  ];
  const parsed = [], real = JSON.parse;
  JSON.parse = s => { parsed.push(s); return real(s); };
  let c;
  try { c = foldReplies(lines); } finally { JSON.parse = real; }
  assert.equal(parsed.length, 3, 'only the three assistant records are parsed');
  assert.deepEqual(c.events, [{ n: 7, at: t(2) }, { n: 11, at: t(3) }]);
  // Privacy: every string held is a model or effort name.
  const strings = [];
  (function walk(v) { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') for (const x of v instanceof Set ? [...v] : Object.values(v)) walk(x); })(c);
  assert.deepEqual(strings.sort(), ['acme-p', 'acme-p', 'high']);
});

test('readRuns reads a transcript once, then only what it gained; a changed verify command reads it again', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-stepmodel-'));
  const path = join(dir, 'acme.jsonl');
  await writeFile(path, [bash(2, 'npm test'), bash(3, 'bash acme-verify.sh')].join('\n') + '\n');
  assert.deepEqual((await readRuns(path)).events.map(e => e.at), [t(2)]);
  assert.equal((await readRuns(path)).events.length, 1, 'an unchanged transcript is not read twice');
  await appendFile(path, bash(4, 'npm test') + '\n');
  assert.deepEqual((await readRuns(path)).events.map(e => e.at), [t(2), t(4)], 'only the new lines were folded');
  assert.deepEqual((await readRuns(path, { verify: 'acme-verify.sh' })).events.map(e => e.at), [t(3)]);
});

test('spansByTicket and ticketModels: 7, 11 and 12 from the worker and reviewer sessions only', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-stepmodel-'));
  const write = async (rel, lines) => { await mkdir(join(dir, rel, '..'), { recursive: true }); await writeFile(join(dir, rel), lines.join('\n') + '\n'); };
  await write('p-acme/w.jsonl', [bash(1, 'npm test'), ask(2, 'toolu_g'), answer(3, 'toolu_g'), bash(5, 'npm test'), bash(7, 'git push origin acme')]);
  await write('p-acme/w/subagents/agent-i.jsonl', [bash(6, 'npm test')]); // the implementer's own run: not the worker's
  await write('p-acme/r.jsonl', [bash(8, 'git push origin acme'), tool(9, 'Write', { file_path: 'C:/runs/FINDINGS.json', content: ATTACKS }), bash(11, 'git push origin acme')]);
  const wt = 'C:/dev/acme-wt-ACME-1';
  const files = { 'p-acme/w.jsonl': { cwd: wt }, 'p-acme/w/subagents/agent-i.jsonl': { cwd: wt }, 'p-acme/r.jsonl': { cwd: wt, reviewer: true } };
  const one = (await spansByTicket(files, [], dir)).get('ACME-1');
  const m = ticketModels({ flow: FLOW, current: 'self-review', ran: one.ran, gates: one.gates, events: one.events, config: {} });
  assert.deepEqual(m.seen, { 7: t(5), 11: t(9), 12: t(11) });
  assert.deepEqual(ticketModels({ flow: FLOW, current: 'planning', config: {} }).seen, {});
});

test('mergeStepModels passes `seen` through, and a peer without it has none', () => {
  const out = mergeStepModels({ 'ACME-1': { seen: { 7: 5 } } }, [{ name: 'box', value: { tickets: { 'ACME-1': { seen: { 11: 9 } }, 'ACME-2': { steps: {} } } } }]);
  assert.deepEqual(out['box|ACME-1'].seen, { 11: 9 });
  assert.equal(out['box|ACME-2'].seen, undefined);
});
