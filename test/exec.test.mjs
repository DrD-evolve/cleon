import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { change, money, span, spendCard, cycleCard, stalledCard, portfolioCard, groomCard, execCards, readSnapshots, snapshotIfDue } from '../lib/exec.mjs';

const H = 36e5, D = 24 * H;
const NOW = new Date(2026, 10, 6, 12).getTime(); // Friday
const ticket = (id, mergedAt, seg = {}, machine = null) => ({ ticket: id, machine, mergedAt, seg: { agent: 4 * H, you: H, gate: 0, lead: 6 * H, ...seg } });

test('change, money, span: the change as a percentage for money and time, a difference for counts', () => {
  assert.equal(change(140, 100, 'money'), '+40%');
  assert.equal(change(50, 100, 'time'), '-50%');
  assert.equal(change(5, 0, 'money'), 'new');
  assert.equal(change(3, 5, 'count'), '-2');
  assert.equal(change(4, 4, 'count'), 'same');
  assert.equal(change(4, null, 'count'), null);
  assert.deepEqual([money(3.456), money(1234.5), money(null)], ['$3.46', '$1,235', '—']);
  assert.deepEqual([span(30 * 6e4), span(5 * H), span(3 * D), span(null)], ['30m', '5.0h', '3.0d', '—']);
});

test('spendCard: spend against the week before, merged tickets in the same windows, cost per ticket, and the top project', () => {
  const usage = { tiles: { week: 40, prior: 20 }, projects: [{ project: 'acme-web', machine: null, week: 25 }, { project: 'acme-api', machine: 'worker', week: 15 }] };
  const tickets = [ticket('ACME-1', NOW - D), ticket('ACME-2', NOW - 2 * D), ticket('ACME-3', NOW - 9 * D)];
  const c = spendCard({ usage, tickets, now: NOW });
  assert.deepEqual([c.value, c.prev, c.change], ['$40', '$20', '+100%']);
  assert.equal(c.sub, '2 merged (was 1) · $20 per merged ticket (was $20)');
  assert.equal(c.action, 'Most went to acme-web ($25).');
  const none = spendCard({ usage, tickets: [], now: NOW });
  assert.equal(none.action, 'Nothing merged in 7 days; most went to acme-web ($25).');
  assert.equal(spendCard({ usage: null, tickets, now: NOW }).action, 'Usage is still reading transcripts.');
});

test('cycleCard: time on you against agent time for tickets merged in 7 days; the longest plan-gate wait', () => {
  const tickets = [ticket('ACME-1', NOW - D, { you: 2 * H, gate: 90 * 6e4 }), ticket('ACME-2', NOW - 2 * D, { you: 2 * H, gate: 3 * H }, 'worker'),
    ticket('ACME-3', NOW - 9 * D, { you: 8 * H })];
  const c = cycleCard({ tickets, now: NOW });
  assert.deepEqual([c.value, c.prev, c.change], ['4.0h on you', '8.0h', '-50%']);
  assert.equal(c.sub, 'agents 8.0h · median lead 6.0h · 2 merged');
  assert.equal(c.action, 'Longest plan-gate wait: ACME-2 on worker (3.0h).');
  // A ticket with no kickoff time has no lead: it's left out of the median, not counted as 0.
  const partial = cycleCard({ tickets: [...tickets, ticket('ACME-4', NOW - D, { lead: null }), ticket('ACME-5', NOW - D, { lead: null })], now: NOW });
  assert.equal(partial.sub, 'agents 16.0h · median lead 6.0h (2 of 4) · 4 merged');
  assert.equal(cycleCard({ tickets: [ticket('ACME-6', NOW - D, { lead: null })], now: NOW }).sub, 'agents 4.0h · median lead unknown · 1 merged');
  const empty = cycleCard({ tickets: [], now: NOW });
  assert.deepEqual([empty.n, empty.value, empty.prev, empty.change, empty.action], [null, '—', 'nothing merged', null, 'Nothing merged in 7 days.']);
});

test('stalledCard: tickets with no step change in 5 days and Linear In Progress untouched for 7; the three oldest', () => {
  const runs = [{ machine: null, tickets: [{ ticket: 'ACME-1', step: 'implementing', since: NOW - 6 * D }, { ticket: 'ACME-2', step: 'done', since: NOW - 30 * D },
    { ticket: 'ACME-3', step: 'review', since: NOW - 2 * D }, { ticket: 'ACME-4', step: 'plan-gate', since: NOW - 20 * D, stale: true }] },
    { machine: 'worker', tickets: [{ ticket: 'ACME-5', step: 'human-review', since: NOW - 10 * D }] }];
  const linear = [{ identifier: 'ACME-9', state: { type: 'started' }, updatedAt: new Date(NOW - 8 * D).toISOString() },
    { identifier: 'ACME-8', state: { type: 'started' }, updatedAt: new Date(NOW - D).toISOString() }, { identifier: 'ACME-7', state: { type: 'backlog' }, updatedAt: new Date(NOW - 90 * D).toISOString() }];
  const c = stalledCard({ runs, linear, now: NOW, prev: 1 });
  assert.deepEqual([c.value, c.prev, c.change], ['3', '1', '+2']);
  assert.equal(c.action, 'Oldest: ACME-5 on worker (10d), ACME-9 (8d), ACME-1 (6d).');
  const none = stalledCard({ runs: [], linear: null, now: NOW });
  assert.deepEqual([none.value, none.prev, none.action], ['0', null, 'Nothing stalled.']);
  assert.match(none.sub, /Linear not read/);
});

test('portfolioCard: active in 7 and 30 days, quiet for 30+, and the ones that went quiet this month', () => {
  const p = (name, ago, repo = true) => ({ name, repo, lastCommitAt: ago == null ? null : NOW - ago * D });
  const c = portfolioCard({ projects: [p('a', 1), p('b', 3), p('c', 20), p('d', 35), p('e', 45), p('f', 200), p('notes', 1, false), p('empty', null)], now: NOW, prev: 4 });
  assert.deepEqual([c.value, c.prev, c.change], ['2 active', '4 active', '-2']);
  assert.equal(c.sub, '3 active in 30 days · 3 quiet 30+ days · of 6 repos');
  assert.equal(c.action, 'Went quiet this month: d (35d), e (45d). Close out or pick back up.');
  assert.equal(portfolioCard({ projects: [p('a', 1)], now: NOW }).action, 'No project went quiet this month.');
});

test('groomCard: the queue size and its oldest item; unreadable says so', () => {
  const c = groomCard({ items: [{ title: 'Signed SOW', at: NOW - 3 * D }, { title: 'Staging credentials for the vendor sandbox', at: NOW - 6 * D }], now: NOW, prev: 5 });
  assert.deepEqual([c.value, c.prev, c.change, c.sub], ['2', '5', '-3', 'oldest 6d']);
  assert.equal(c.action, 'Oldest: Staging credentials for the vendor sandbox (6d).');
  assert.equal(groomCard({ items: [], now: NOW }).action, 'Nothing to groom.');
  assert.equal(groomCard({ items: null, now: NOW }).action, 'The Groom queue could not be read.');
});

test('execCards and the weekly snapshot: last week\'s numbers come from last week\'s line; one line a week, kept across restarts', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-exec-'));
  try {
    const file = join(dir, 'data', 'exec-4318.json');
    assert.deepEqual(await readSnapshots(file), []);
    const lastWeek = { at: NOW - 7 * D, values: { stalled: 2, portfolio: 9, groom: 4 } };
    const older = { at: NOW - 14 * D, values: { stalled: 7 } };
    const cards = execCards({ usage: null, metrics: { tickets: [] }, runs: [], linear: [], projects: [], groom: [], snapshots: [older, lastWeek], now: NOW });
    assert.deepEqual(cards.map(c => c.id), ['spend', 'cycle', 'stalled', 'portfolio', 'groom']);
    assert.deepEqual(cards.map(c => c.prev), [null, 'nothing merged', '2', '9 active', '4']);
    let snaps = await snapshotIfDue(file, [], cards, NOW);
    assert.deepEqual(snaps.at(-1).values, { stalled: 0, portfolio: 0, groom: 0 }, 'only numbers that were read');
    snaps = await snapshotIfDue(file, await readSnapshots(file), cards, NOW + H);
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1, 'once a week');
    assert.equal((await readSnapshots(file)).length, 1, 'read back after a restart');
    await snapshotIfDue(file, await readSnapshots(file), cards, NOW + 7 * D);
    assert.equal((await readSnapshots(file)).length, 2, 'next week, a new line');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
