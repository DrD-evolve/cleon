import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prMentions, sessionPrs } from '../lib/sessionprs.mjs';

test('prMentions finds PR numbers in the ways sessions write them', () => {
  assert.deepEqual(prMentions('PR #148 and PRs #12; https://github.com/o/r/pull/77; see #9'), [148, 12, 77, 9]);
  assert.deepEqual(prMentions('v2#3 a1#5 ACME-164 2026-11-01'), []);
});

test('sessionPrs keeps only your open PRs in the session repo, latest mention first', () => {
  const prs = [
    { number: 148, url: 'u148', repository: { name: 'acme-platform' } },
    { number: 36, url: 'u36', repository: { name: 'orchestration-plugin' } },
    { number: 141, url: 'u141', repository: { name: 'acme-platform' } },
  ];
  assert.deepEqual(sessionPrs(['merged PR #141', 'opened PR #148', 'see #36'], 'acme-platform', prs), ['u148', 'u141']);
  assert.deepEqual(sessionPrs(['nothing here'], 'acme-platform', prs), []);
});
