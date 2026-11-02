import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortIssues, linearIssues } from '../lib/linear.mjs';
import { checkState } from '../lib/github.mjs';

const issue = (id, type, priority, updatedAt = '2026-11-01T00:00:00Z') => ({ identifier: id, state: { type }, priority, updatedAt });

test('sortIssues: in progress first, then priority with "none" last, then recency', () => {
  const sorted = sortIssues([
    issue('A', 'backlog', 1), issue('B', 'started', 0), issue('C', 'started', 2),
    issue('D', 'unstarted', 3, '2026-10-01T00:00:00Z'), issue('E', 'unstarted', 3, '2026-10-30T00:00:00Z'),
  ]);
  assert.deepEqual(sorted.map(i => i.identifier), ['C', 'B', 'E', 'D', 'A']);
});

test('linearIssues reports missing key and API errors as offline', async () => {
  assert.equal((await linearIssues('')).online, false);
  const fake = async () => ({ json: async () => ({ errors: [{ message: 'Authentication required' }] }) });
  assert.deepEqual(await linearIssues('k', fake), { online: false, reason: 'Authentication required' });
});

test('linearIssues sends the key as the authorization header', async () => {
  let seen;
  const fake = async (_url, init) => {
    seen = init.headers.authorization;
    return { json: async () => ({ data: { viewer: { name: 'J', assignedIssues: { nodes: [issue('X', 'started', 1)] } } } }) };
  };
  const r = await linearIssues('secret', fake);
  assert.equal(seen, 'secret');
  assert.equal(r.issues[0].identifier, 'X');
});

test('checkState collapses check runs and status contexts', () => {
  assert.equal(checkState([]), 'none');
  assert.equal(checkState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'passing');
  assert.equal(checkState([{ status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(checkState([{ state: 'PENDING' }]), 'pending');
  assert.equal(checkState([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), 'failing');
});

test('summarizeChecks counts mutation jobs and orders failures first', async () => {
  const { summarizeChecks, prChecks } = await import('../lib/github.mjs');
  const c = (name, bucket, completedAt = '0001-01-01T00:00:00Z') => ({ name, bucket, link: 'l', startedAt: '2026-11-01T00:00:00Z', completedAt });
  const s = summarizeChecks([c('mutations · b', 'pending'), c('cdk synth', 'pass', '2026-11-01T00:01:00Z'), c('mutations · a', 'pass', '2026-11-01T00:02:00Z'), c('mutations · c', 'fail', '2026-11-01T00:03:00Z')]);
  assert.deepEqual(s.mutations, { total: 3, done: 2, running: 0, failed: 1 });
  assert.deepEqual(s.checks.map(k => k.name), ['mutations · c', 'mutations · b', 'cdk synth', 'mutations · a']);
  assert.equal(s.checks[1].completedAt, null);
  assert.equal(summarizeChecks([c('cdk synth', 'pass')]).mutations, null);
  // Only real PR URLs ever reach gh.
  let called = false;
  assert.equal(await prChecks('--repo=evil/x', async () => { called = true; return []; }), null);
  assert.equal(called, false);
});

test('summarizeChecks tells running from queued by state, not start time', async () => {
  const { summarizeChecks } = await import('../lib/github.mjs');
  const c = (name, state) => ({ name, state, bucket: 'pending', link: 'l', startedAt: '2026-11-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' });
  const s = summarizeChecks([c('mutations · q', 'QUEUED'), c('mutations · r', 'IN_PROGRESS')]);
  assert.deepEqual(s.checks.map(k => [k.name, k.running]), [['mutations · r', true], ['mutations · q', false]]);
  assert.deepEqual(s.mutations, { total: 2, done: 0, running: 1, failed: 0 });
});

test('prState reads a PR state, null when gh fails, and never passes a non-PR URL', async () => {
  const { prState } = await import('../lib/github.mjs');
  assert.equal(await prState('https://github.com/o/r/pull/1', async () => ({ state: 'MERGED' })), 'MERGED');
  assert.equal(await prState('https://github.com/o/r/pull/1', async () => null), null);
  let called = false;
  assert.equal(await prState('--repo=evil/x', async () => { called = true; return { state: 'MERGED' }; }), null);
  assert.equal(called, false);
});
