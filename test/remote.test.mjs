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
