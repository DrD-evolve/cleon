import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Independent of this machine's .env: pin the exclusion pattern before the modules read it
// (an existing env var wins over .env, and static imports would load first).
process.env.MC_EXCLUDE = String.raw`secret[\s_-]?project`;
const { parseDialog, listAttention } = await import('../lib/attention.mjs');

const PLAN_GATE = readFileSync(new URL('./fixtures/screens/plan-gate.txt', import.meta.url), 'utf8');

test('parseDialog reads a plan-gate question and its options off a pane screen', () => {
  const d = parseDialog(PLAN_GATE);
  assert.equal(d.title, 'Plan gate');
  assert.match(d.question, /^ACME-175 plan written to .* Approve\?$/);
  assert.deepEqual(d.options, ['Approve (Recommended)', 'Put it on ADR-0034 instead', 'Revise', 'Abort']);
  assert.deepEqual(d.notes, [
    'Implement as written: ADR-0033 A2, Proposed status, regenerate the index, open the PR.',
    'Make it ADR-0034 A1, amending D3, where the config-key escalation was last stated.',
    'Change something else in the plan before any code is written.',
    'Stop; the worktree stays and nothing is committed.',
  ]);
});

test('parseDialog ignores screens without a live dialog', () => {
  assert.equal(parseDialog('Next:\n1. (you) do a thing\n2. (me) do another\n❯ '), null);
  assert.equal(parseDialog(''), null);
});

test('listAttention flags waiting or blocked sessions, with the question when herdr can show it', async () => {
  const sessions = [
    { id: 'a', name: 'ACME-175', alive: true, status: 'waiting', cwd: 'C:/dev/Development/Project Acme' },
    { id: 'b', name: 'other', alive: true, status: 'idle', cwd: 'C:/x' },
    { id: 'c', name: 'vscode-only', alive: true, status: 'waiting', cwd: 'C:/y' },
    { id: 'd', name: 'vault', alive: true, status: 'waiting', cwd: 'C:/dev/Development/Secret Project' },
  ];
  const snap = { online: true, agents: [
    { agent_session: { value: 'a' }, session: 'acme', pane_id: 'w4:p1', agent_status: 'blocked', terminal_title_stripped: 'ACME-175 implement' },
    { agent_session: { value: 'd' }, session: 'acme', pane_id: 'w5:p1', agent_status: 'blocked', terminal_title_stripped: 'vault' },
  ] };
  const reads = [];
  const r = await listAttention(sessions, snap, async (s, p) => { reads.push(p); return PLAN_GATE; });
  assert.deepEqual(r.map(x => [x.name, x.title, x.options.length]), [['ACME-175', 'Plan gate', 4], ['vscode-only', null, 0], ['vault', null, 0]]);
  // The excluded session is flagged, but its screen is never read.
  assert.deepEqual(reads, ['w4:p1']);
});

test('listAttention: an idle session whose last turn handed you something counts, with its items', async () => {
  const sessions = [
    { id: 'idle-asked', name: 'review', alive: true, status: 'idle', cwd: 'C:/x' },
    { id: 'idle-done', name: 'done', alive: true, status: 'idle', cwd: 'C:/y' },
  ];
  const handedOff = async s => s.id === 'idle-asked' ? { why: 'action', ask: 'Ratify ADR-0040', items: ['Ratify ADR-0040', 'Decide D11'] } : null;
  const r = await listAttention(sessions, { online: false }, async () => null, async () => [], handedOff);
  assert.deepEqual(r.map(a => [a.name, a.question, a.items.length]), [['review', 'Ratify ADR-0040', 2]]);
});

test('listAttention marks a plan-gate dialog as a gate, and any other question as not', async () => {
  const sessions = [{ id: 'a', name: 'ACME-175', alive: true, status: 'waiting', cwd: 'C:/x' }, { id: 'c', name: 'plain', alive: true, status: 'waiting', cwd: 'C:/y' }];
  const snap = { online: true, agents: [{ agent_session: { value: 'a' }, session: 'acme', pane_id: 'w4:p1', agent_status: 'blocked', terminal_title_stripped: 'x' }] };
  const r = await listAttention(sessions, snap, async () => PLAN_GATE);
  assert.deepEqual(r.map(x => [x.name, x.gate]), [['ACME-175', true], ['plain', false]]);
});
