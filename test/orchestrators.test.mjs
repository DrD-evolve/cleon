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
