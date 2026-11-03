import { test } from 'node:test';
import assert from 'node:assert/strict';
import { epicOf, toolLine, parseActivity } from '../lib/orchestrators.mjs';

const at = s => `2026-11-01T10:${s}Z`;
const said = (t, text) => ({ type: 'assistant', timestamp: at(t), message: { content: [{ type: 'text', text }] } });
const tool = (t, id, name, input) => ({ type: 'assistant', timestamp: at(t), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (t, id, content, is_error = false) => ({ type: 'user', timestamp: at(t), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const note = (t, body) => ({ type: 'user', timestamp: at(t), message: { content: `<task-notification> ${body} </task-notification>` } });

test('epicOf trusts only the session\'s own command and watcher, not mentions in output', () => {
  const watch = 'bash "C:/dev/Tooling/orchestration-plugin/skills/orchestrate-work/scripts/workspace-dispatch.sh" watch --epic ACME-12';
  assert.equal(epicOf([tool('00:00', 'a', 'Monitor', { command: watch })]), 'ACME-12');
  assert.equal(epicOf([{ type: 'user', message: { content: '<command-name>/orchestration:orchestrate-work</command-name>\n<command-args>ACME-99</command-args>' } }]), 'ACME-99');
  // A different session that merely read output containing the watch command is not an orchestrator.
  assert.equal(epicOf([tool('00:00', 'b', 'Bash', { command: 'code --status' }), result('00:01', 'b', `... ${watch} ...`)]), null);
});

test('toolLine uses descriptions and never raw commands', () => {
  assert.equal(toolLine('Bash', { command: 'export TOKEN=secret && deploy', description: 'Deploy the dev stack' }), 'Deploy the dev stack');
  assert.equal(toolLine('Bash', { command: 'export TOKEN=secret' }), 'ran a command');
  assert.equal(toolLine('Read', { file_path: 'C:\\x\\PLAN.md' }), 'Read PLAN.md');
  assert.equal(toolLine('mcp__linear__save_comment', {}), 'linear: save comment');
});

test('parseActivity tracks background work, intent, results and turn end without reading output', () => {
  const now = Date.parse(at('40:00'));
  const r = parseActivity([
    tool('00:00', 'w1', 'Monitor', { description: 'ACME-12 worker stages' }),
    result('00:01', 'w1', 'Monitor started (task oldw, expires in 30m unless the source ends first)'),
    tool('20:00', 'd', 'Bash', { description: 'Deploy the dev stack', run_in_background: true }),
    result('20:01', 'd', 'Command running in background with ID: dep1. Output is being written to: x'),
    tool('21:00', 'w2', 'Monitor', { description: 'ACME-12 worker stages' }),
    result('21:01', 'w2', 'Monitor started (task neww, expires in 30m unless the source ends first)'),
    tool('22:00', 'm', 'Bash', { description: 'Merge #140 when green' }),
    result('22:30', 'm', 'SECRET OUTPUT', true),
    note('23:00', '<task-id>dep1</task-id> <status>completed</status> <summary>Background command "Deploy the dev stack" completed</summary>'),
    said('24:00', 'Merging #140 once mutations are green.'),
    { type: 'system', subtype: 'turn_duration', timestamp: at('24:01') },
  ], now);
  // The 00:01 watcher expired at 30:01 with no notice; the deploy finished; the new watcher runs.
  assert.deepEqual(r.tasks.map(t => t.id), ['neww']);
  assert.equal(r.intent, 'Merging #140 once mutations are green.');
  assert.equal(r.turnEnded, true);
  assert.equal(r.events.find(e => e.text === 'Merge #140 when green').ok, false);
  assert.ok(!JSON.stringify(r).includes('SECRET OUTPUT'));
});

test('mergeApprovals finds prompts that hand a merge to the orchestrator, and ignores hedged ones', async () => {
  const { mergeApprovals } = await import('../lib/orchestrators.mjs');
  const p = text => ({ t: 1, text });
  assert.deepEqual(mergeApprovals([p('merge 141 when green')]), [{ t: 1, prs: [141], tickets: [] }]);
  assert.deepEqual(mergeApprovals([p('ship ACME-147')]), [{ t: 1, prs: [], tickets: ['ACME-147'] }]);
  assert.deepEqual(mergeApprovals([p('LGTM #139')]).map(a => a.prs), [[139]]);
  // The digits inside a ticket id are not a PR number.
  assert.deepEqual(mergeApprovals([p('merge ACME-147')])[0].prs, []);
  for (const hedged of ["don't merge 141 yet", 'hold 141, do not merge', 'wait on 141 before merging', 'close 245'])
    assert.deepEqual(mergeApprovals([p(hedged)]), [], hedged);
});

test('a subagent is running work until it finishes — "waiting on its own background work" is not finished', () => {
  const launched = id => `Async agent launched successfully. (internal metadata)\nagentId: ${id} (internal ID)`;
  const r = parseActivity([
    tool('00:00', 'a', 'Agent', { description: 'Implement ACME-164 draw routes' }),
    result('00:01', 'a', launched('impl1')),
    tool('00:02', 'b', 'Agent', { description: 'Skeptic review' }),
    result('00:03', 'b', launched('skep1')),
    note('10:00', '<task-id>impl1</task-id> <status>completed</status> <summary>Agent "Implement ACME-164 draw routes" is waiting on its own background work</summary>'),
    // Some sessions record notices only in the request blob, sometimes more than once.
    { type: 'api-request-blob', message: { content: [{ type: 'text', text: '<task-notification> <task-id>skep1</task-id> <status>completed</status> <summary>Agent "Skeptic review" finished</summary> </task-notification>' }] } },
    { type: 'api-request-blob', message: { content: [{ type: 'text', text: '<task-notification> <task-id>skep1</task-id> <status>completed</status> <summary>Agent "Skeptic review" finished</summary> </task-notification>' }] } },
  ], Date.parse(at('11:00')));
  assert.deepEqual(r.tasks.map(k => [k.id, k.kind, Boolean(k.waiting)]), [['impl1', 'agent', true]]);
  assert.equal(r.events.filter(e => e.kind === 'note' && /Skeptic/.test(e.text)).length, 1);
});

test('askOf finds the question a finished turn leaves for you', async () => {
  const { askOf, needsYou } = await import('../lib/orchestrators.mjs');
  const close = `PR #29 is merged.\n\nNext:\n1. (me) Close ACME-174's Herdr tab and remove the empty folder. Do you want me to?\n2. (me) Run sync-cache after ACME-173 merges.`;
  assert.equal(askOf(close), "Close ACME-174's Herdr tab and remove the empty folder. Do you want me to?");
  assert.equal(askOf('ACME-147 (PR #141) is ready for your review. Approve the merge when you are happy.'), 'ACME-147 (PR #141) is ready for your review. Approve the merge when you are happy.');
  assert.equal(askOf('Migration 0026 is applied on dev. All twelve functions updated.'), null);
  // A "?" inside a code block is not a question to you.
  assert.equal(askOf('Done.\n```\nif (x?) y\n```\nAll set.'), null);
  assert.deepEqual(needsYou('waiting', { asks: null }), { why: 'dialog', ask: null, items: [] });
  assert.deepEqual(needsYou('idle', { asks: 'Shall I?' }), { why: 'question', ask: 'Shall I?', items: [] });
  assert.equal(needsYou('busy', { asks: null }), null);
});

test('a question only stands while the turn that asked it is over', () => {
  const asked = [said('00:00', 'Shall I merge it?'), { type: 'system', subtype: 'turn_duration', timestamp: at('00:01') }];
  assert.equal(parseActivity(asked).asks, 'Shall I merge it?');
  assert.equal(parseActivity([...asked, said('01:00', 'Merging now.')]).asks, null);
});

test('"(you)" items in a closing Next: list are work waiting on you, question or not', async () => {
  const { youItems, needsYou } = await import('../lib/orchestrators.mjs');
  const close = `The epic is not closed yet.

Next:
1. (you) Start the ACME-175 session in Acme with the prompt above.
2. (me) Dispatch ACME-179 here now.`;
  assert.deepEqual(youItems(close), ['Start the ACME-175 session in Acme with the prompt above.']);
  assert.deepEqual(youItems(`- (you) review **PR #29**
- (me) sync the cache`), ['review PR #29']);
  assert.deepEqual(youItems('I asked you (you said yes) earlier.'), []);
  // No question, but a (you) item: still waiting on you, headlined by that item.
  assert.deepEqual(needsYou('idle', { asks: null, yours: ['Start the ACME-175 session.'] }),
    { why: 'action', ask: 'Start the ACME-175 session.', items: ['Start the ACME-175 session.'] });
});

test('youItems: a numbered list introduced as yours counts, without "(you)" markers', async () => {
  const { youItems } = await import('../lib/orchestrators.mjs');
  const msg = 'PR #147 has finished CI.\n\nI\'m not merging it. Three things are still yours:\n\n1. Ratify ADR-0040, or send it back.\n2. D11: should results be public by default? I recommend private.\n3. A fourth Codex review pass.\n';
  assert.deepEqual(youItems(msg), ['Ratify ADR-0040, or send it back.', 'D11: should results be public by default? I recommend private.', 'A fourth Codex review pass.']);
  assert.deepEqual(youItems('Two things are waiting on you:\n1. A\n2. B\n\nAfter that I can continue.'), ['A', 'B']);
  // A plain numbered list isn't a handoff.
  assert.deepEqual(youItems('Here is what I changed:\n1. A\n2. B'), []);
});

test('listSessionActivity skips sessions that are gone or have no transcript', async () => {
  const { listSessionActivity } = await import('../lib/orchestrators.mjs');
  const a = await listSessionActivity([
    { id: 'no-such-session-0000', alive: true, cwd: 'C:/dev/Acme' },
    { id: 'no-such-session-0001', alive: false, cwd: 'C:/dev/Acme' },
  ]);
  assert.deepEqual(a, {});
});
