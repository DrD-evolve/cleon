import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { groomQueue, snoozeUntil, pruneGroom, ticketCommand, readGroom, writeGroom, blankGroom, KINDS } from '../lib/groom.mjs';

const H = 36e5, D = 24 * H;
const NOW = new Date(2026, 10, 6, 12).getTime(); // a Friday
const projects = [{ id: 'tooling/acme-web', name: 'acme-web' }, { id: 'strategic/acme-rollout', name: 'acme-rollout' }];
const inbox = transcripts => ({ transcripts, flags: [
  { id: 'EV1', subject: 'Weekly StandUp', organizer: 'Pat Example', start: NOW - 4 * D, end: NOW - 4 * D + H, date: '2026-11-02',
    link: 'https://outlook.office365.com/owa/?itemid=1', why: null, project: 'acme-rollout', projectId: 'strategic/acme-rollout', folder: 'Communications', file: '2026-11-02_Weekly_StandUp.vtt' },
] });
const waiting = [
  { id: 'w1', what: 'Staging credentials', who: 'IT Helpdesk', project: 'tooling/acme-web', due: '2026-11-04', added: NOW - 6 * D, overdue: true, maybe: null },
  { id: 'w2', what: 'Signed SOW', who: 'Sam Vendor', project: null, due: null, added: NOW - 3 * D, overdue: false,
    maybe: { at: NOW - H, link: 'https://outlook.office365.com/owa/?itemid=2', from: 'Sam Vendor' } },
  { id: 'w3', what: 'Budget numbers', who: 'Finance', project: null, due: null, added: NOW - D, overdue: false, maybe: null }, // neither: not groomed
];
const reviews = [
  { url: 'https://github.com/acme/acme-web/pull/7', title: 'Add retries', number: 7, updatedAt: new Date(NOW - 2 * D).toISOString(), repository: { name: 'acme-web' }, author: { login: 'sam' } },
  { url: 'https://evil.example/acme/x/pull/8', title: 'Other repo', number: 8, updatedAt: new Date(NOW - 5 * D).toISOString(), repository: { name: 'unknown-repo' }, author: {} },
];
const linear = [
  { identifier: 'ACME-1', title: 'Write the runbook', url: 'https://linear.app/acme/issue/ACME-1', updatedAt: new Date(NOW - 9 * D).toISOString(), description: '', state: { name: 'Backlog', type: 'backlog' }, project: { name: 'Ops' } },
  { identifier: 'ACME-2', title: 'Fully written', url: 'https://linear.app/acme/issue/ACME-2', updatedAt: new Date(NOW - 9 * D).toISOString(), description: 'A real description that says what done means and why.', state: { name: 'Backlog', type: 'backlog' } },
  { identifier: 'ACME-3', title: 'Just arrived', url: 'https://linear.app/acme/issue/ACME-3', updatedAt: new Date(NOW - D).toISOString(), description: 'A real description that says what done means and why.', state: { name: 'Triage', type: 'triage' } },
];
const q = (o = {}) => groomQueue({ inbox: inbox('disabled'), waiting, reviews, linear, projects, now: NOW, ...o });

test('groomQueue: every source, in order (waiting on, reviews, meetings, Linear), oldest first within each', () => {
  assert.deepEqual(q().map(i => i.key), ['waiting:w1', 'waiting:w2', 'review:https://evil.example/acme/x/pull/8', 'review:https://github.com/acme/acme-web/pull/7',
    'transcript:EV1', 'linear:ACME-1', 'linear:ACME-3']);
  assert.deepEqual(Object.keys(KINDS), ['waiting', 'review', 'transcript', 'linear']);
});

test('groomQueue: each item\'s actions are only the ones it can take', () => {
  const by = Object.fromEntries(q().map(i => [i.key, i]));
  assert.deepEqual(by['waiting:w1'].actions, ['ticket', 'snooze', 'dismiss'], 'no message to open, but a project');
  assert.deepEqual([by['waiting:w2'].actions, by['waiting:w2'].doLabel], [['do', 'snooze', 'dismiss'], 'Message']);
  assert.deepEqual([by['review:https://github.com/acme/acme-web/pull/7'].actions, by['review:https://github.com/acme/acme-web/pull/7'].project],
    [['do', 'ticket', 'wait', 'snooze', 'dismiss'], 'tooling/acme-web']);
  const other = by['review:https://evil.example/acme/x/pull/8'];
  assert.deepEqual([other.link, other.actions], [null, ['snooze', 'dismiss']], 'a link to another host is dropped; no project, no author');
  assert.deepEqual([by['transcript:EV1'].doLabel, by['transcript:EV1'].who, by['transcript:EV1'].actions], ['Outlook', 'Pat Example', ['do', 'ticket', 'wait', 'snooze', 'dismiss']]);
  assert.equal(q({ inbox: inbox('ok') }).find(i => i.kind === 'transcript').doLabel, 'Ingest');
  assert.deepEqual(by['linear:ACME-1'].actions, ['do', 'snooze', 'dismiss']);
  assert.match(by['linear:ACME-1'].sub, /no description yet/);
});

test('groomQueue: snoozed items wait until their time; hidden ones stay hidden', () => {
  const state = { ...blankGroom(), snoozed: { 'waiting:w1': NOW + H, 'linear:ACME-1': NOW - 1 }, hidden: { 'transcript:EV1': NOW - D } };
  const keys = q({ state }).map(i => i.key);
  assert.ok(!keys.includes('waiting:w1') && !keys.includes('transcript:EV1'));
  assert.ok(keys.includes('linear:ACME-1'), 'its snooze is over');
  assert.deepEqual(groomQueue({ projects, now: NOW }), [], 'no sources, no items');
});

test('snoozeUntil: 8:00 tomorrow, or 8:00 next Monday (a week on from a Monday)', () => {
  assert.equal(snoozeUntil('tomorrow', NOW), new Date(2026, 10, 7, 8).getTime());
  assert.equal(snoozeUntil('monday', NOW), new Date(2026, 10, 9, 8).getTime());
  assert.equal(snoozeUntil('monday', new Date(2026, 10, 9, 7).getTime()), new Date(2026, 10, 16, 8).getTime());
  assert.equal(snoozeUntil('monday', new Date(2026, 10, 8, 20).getTime()), new Date(2026, 10, 9, 8).getTime(), 'from a Sunday');
  assert.equal(snoozeUntil('forever', NOW), null);
});

test('pruneGroom: ended snoozes go; a hide goes 30 days after its item left every source', () => {
  const s = { ...blankGroom(), snoozed: { a: NOW - 1, b: NOW + H }, hidden: { live: NOW - 90 * D, gone: NOW - 31 * D, recent: NOW - D } };
  assert.deepEqual(pruneGroom(s, new Set(['live']), NOW), { ...blankGroom(), snoozed: { b: NOW + H }, hidden: { live: NOW - 90 * D, recent: NOW - D } });
});

test('ticketCommand: built from the kind and date only, and refused for anything else', () => {
  assert.equal(ticketCommand('review', '2026-11-04'),
    'claude "/new-task A ticket about a review request from 2026-11-04 in this project. Ask me what it should cover."');
  assert.match(ticketCommand('transcript', '2026-11-02'), /about the meeting on 2026-11-02 in this project/);
  assert.match(ticketCommand('waiting', '2026-10-31'), /about a waiting-on item added 2026-10-31 in this project/);
  assert.equal(ticketCommand('linear', '2026-10-31'), null, 'a Linear issue is a ticket already');
  assert.doesNotMatch(ticketCommand('transcript', '2026-11-02').slice(8, -1), /["$`\\!]/);
  for (const [kind, date] of [['other', '2026-11-04'], ['review', '2026-11-04"; calc; "'], ['review', null], ['review', '$(calc)']])
    assert.equal(ticketCommand(kind, date), null, `${kind} ${date}`);
});

test('readGroom and writeGroom: a round trip, and a missing file reads as empty', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-groom-'));
  try {
    const file = join(dir, 'data', 'groom-4318.json');
    assert.deepEqual(await readGroom(file), blankGroom());
    const s = { ...blankGroom(), snoozed: { a: 1 }, hidden: { b: 2 } };
    await writeGroom(file, s);
    assert.deepEqual(await readGroom(file), s);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
