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
