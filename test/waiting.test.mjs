import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { cleanItem, saveItem, closeItem, notYet, overdue, toCheck, applyAnswers, waitingView, prune, readWaiting, writeWaiting, blankWaiting } from '../lib/waiting.mjs';
import { scanPrompt, checkScan, runScan, blankState } from '../lib/scan.mjs';

const H = 36e5, D = 24 * H;
const NOW = new Date(2026, 10, 6, 12).getTime();
const ids = ['tooling/acme-web'];
let n = 0;
const newId = () => `w${++n}`;
const add = (s, f, at = NOW) => saveItem(s, null, { what: 'Staging credentials', who: 'Pat Example', project: null, due: null, ...f }, at, newId);

test('cleanItem: what and who required, a known project, a real due date; text becomes one line', () => {
  assert.deepEqual(cleanItem({ what: ' Staging\ncredentials ', who: 'pat@acme.example', project: 'tooling/acme-web', due: '2026-11-10' }, ids),
    { ok: true, fields: { what: 'Staging credentials', who: 'pat@acme.example', project: 'tooling/acme-web', due: '2026-11-10' } });
  assert.deepEqual(cleanItem({ what: 'x', who: 'y', project: '', due: '' }, ids).fields, { what: 'x', who: 'y', project: null, due: null });
  for (const [bad, why] of [[{ who: 'y' }, /what you are waiting for/], [{ what: 'x' }, /who it is from/],
    [{ what: 'x', who: 'y', project: 'other/thing' }, /not a known project/], [{ what: 'x', who: 'y', due: '2026-02-30' }, /YYYY-MM-DD/],
    [{ what: 'x', who: 'y', due: 'Friday' }, /YYYY-MM-DD/], [null, /what you are waiting for/]])
    assert.match(cleanItem(bad, ids).reason, why);
  assert.equal(cleanItem({ what: 'x'.repeat(300), who: 'y' }, ids).fields.what.length, 200);
});

test('saveItem, closeItem, notYet: add, edit an open item, close it; closed ones can\'t be edited', () => {
  let r = add(blankWaiting());
  assert.equal(r.ok, true);
  const id = r.id;
  assert.deepEqual(r.state.items[id], { id, what: 'Staging credentials', who: 'Pat Example', project: null, due: null, added: NOW, closed: null, maybe: null, checked: null, after: null });
  r = saveItem(r.state, id, { what: 'Prod credentials', who: 'Pat Example', project: 'tooling/acme-web', due: '2026-11-09' }, NOW + H);
  assert.deepEqual([r.state.items[id].what, r.state.items[id].due, r.state.items[id].added], ['Prod credentials', '2026-11-09', NOW]);
  const closed = closeItem(r.state, id, NOW + 2 * H);
  assert.equal(closed.state.items[id].closed, NOW + 2 * H);
  assert.equal(saveItem(closed.state, id, { what: 'x' }).ok, false);
  assert.equal(closeItem(closed.state, id).ok, false);
  assert.equal(saveItem(blankWaiting(), 'nope', { what: 'x' }).ok, false);
  assert.equal(notYet(r.state, id).ok, false, 'nothing to clear');
});

test('overdue: only once the whole due day has gone by', () => {
  assert.equal(overdue({ due: '2026-11-06' }, NOW), false);
  assert.equal(overdue({ due: '2026-11-05' }, NOW), true);
  assert.equal(overdue({ due: null }, NOW), false);
});

test('toCheck: open, unanswered items, from when each was added, a "not yet", or the last check less 6 hours', () => {
  let s = add(blankWaiting(), {}, NOW - 3 * D).state;
  const [a] = Object.keys(s.items);
  s = add(s, { what: 'Answered' }, NOW - D).state;
  const b = Object.keys(s.items)[1];
  s.items[b].maybe = { at: NOW - H, found: NOW, link: null, from: 'Pat', why: 'sent them' };
  s = add(s, { what: 'Closed' }).state;
  s = closeItem(s, Object.keys(s.items)[2], NOW).state;
  assert.deepEqual(toCheck(s, NOW), [{ id: a, what: 'Staging credentials', who: 'Pat Example', since: NOW - 3 * D }]);
  s.items[a].checked = NOW - H;
  assert.equal(toCheck(s, NOW)[0].since, NOW - 7 * H);
  s.items[a].after = NOW - 30 * 60e3;
  assert.equal(toCheck(s, NOW)[0].since, NOW - 30 * 60e3);
  s.items[a] = { ...s.items[a], added: NOW - 60 * D, checked: null, after: null };
  assert.equal(toCheck(s, NOW)[0].since, NOW - 30 * D, 'never more than 30 days back');
});

test('applyAnswers: a resolved answer marks the item maybe answered; Not yet clears it and keeps that message from coming back', () => {
  let s = add(blankWaiting(), {}, NOW - D).state;
  const [id] = Object.keys(s.items);
  const answer = { id, resolved: true, at: NOW - H, link: 'https://outlook.office365.com/owa/?itemid=x', from: 'Pat Example', why: 'sent the credentials' };
  s = applyAnswers(s, [id], [{ ...answer, resolved: false }], NOW);
  assert.deepEqual([s.items[id].checked, s.items[id].maybe], [NOW, null]);
  s = applyAnswers(s, [id], [answer], NOW + H);
  assert.deepEqual(s.items[id].maybe, { at: NOW - H, found: NOW + H, link: answer.link, from: 'Pat Example', why: 'sent the credentials' });
  s = notYet(s, id).state;
  assert.deepEqual([s.items[id].maybe, s.items[id].after], [null, NOW - H + 1000]);
  assert.equal(applyAnswers(s, [id], [answer], NOW + 2 * H).items[id].maybe, null, 'the same message again is ignored');
  assert.notEqual(applyAnswers(s, [id], [{ ...answer, at: NOW }], NOW + 2 * H).items[id].maybe, null, 'a later one counts');
  const closed = closeItem(s, id, NOW).state;
  assert.equal(applyAnswers(closed, [id], [{ ...answer, at: NOW }], NOW + 2 * H).items[id].maybe, null);
});

test('waitingView and prune: overdue first, then maybe answered, then longest waiting; closed items hidden, then dropped after 90 days', () => {
  let s = blankWaiting();
  s = add(s, { what: 'Old' }, NOW - 5 * D).state;
  s = add(s, { what: 'Due yesterday', due: '2026-11-05' }, NOW - D).state;
  s = add(s, { what: 'Answered' }, NOW - 2 * D).state;
  s.items[Object.keys(s.items)[2]].maybe = { at: NOW, found: NOW };
  s = add(s, { what: 'Done' }, NOW - 9 * D).state;
  s = closeItem(s, Object.keys(s.items)[3], NOW - 100 * D).state;
  const v = waitingView(s, NOW);
  assert.deepEqual(v.map(i => [i.what, i.overdue, i.days]), [['Due yesterday', true, 1], ['Answered', false, 2], ['Old', false, 5]]);
  assert.equal(Object.keys(prune(s, NOW).items).length, 3);
});

test('readWaiting and writeWaiting: a round trip, and a missing file reads as empty', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-waiting-'));
  try {
    const file = join(dir, 'data', 'waiting-4318.json');
    assert.deepEqual(await readWaiting(file), blankWaiting());
    const s = add(blankWaiting()).state;
    await writeWaiting(file, s);
    assert.deepEqual(await readWaiting(file), s);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the scan asks about waiting items, quoted, and its answers are checked', async () => {
  const items = [{ id: 'w9', what: 'Creds "now"\nplease', who: 'Pat <pat@acme.example>', since: NOW - D }];
  const p = scanPrompt({ since: NOW - D, until: NOW, projects: [], waiting: items });
  assert.match(p, /^- id w9: "Creds \\"now\\" please" from "Pat <pat@acme.example>", since /m);
  assert.match(p, /outlook_email_search with sender/);
  assert.match(scanPrompt({ since: NOW - D, until: NOW, projects: [] }), /no waiting-on items/);
  const reply = waiting => JSON.stringify({ meetings: [], transcripts: 'not-checked', waiting, complete: true });
  const ok = checkScan(reply([{ id: 'w9', resolved: true, at: '2026-11-06T15:00:00Z', link: 'https://teams.microsoft.com/l/message/1', from: 'Pat', why: 'sent them' }]),
    { projects: [], now: NOW, asked: ['w9'] });
  assert.deepEqual(ok.waiting, [{ id: 'w9', resolved: true, at: Date.parse('2026-11-06T15:00:00Z'), link: 'https://teams.microsoft.com/l/message/1', from: 'Pat', why: 'sent them' }]);
  assert.equal(checkScan(reply([{ id: 'w9', resolved: true, link: 'https://evil.example/x' }]), { projects: [], now: NOW, asked: ['w9'] }).waiting[0].link, null);
  for (const [w, why] of [[[{ id: 'w8', resolved: true }], /not asked about/], [[{ id: 'w9' }], /resolved true or false/],
    [[{ id: 'w9', resolved: true, at: 'soon' }], /unreadable time/], [{ id: 'w9' }, /must be a list/]])
    assert.match(checkScan(reply(w), { projects: [], now: NOW, asked: ['w9'] }).reason, why);
  const envelope = result => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 2, modelUsage: {} });
  const r = await runScan({ state: blankState(), projects: [], filings: {}, waiting: items, now: NOW, model: 'haiku', budget: 1,
    run: async () => ({ stdout: envelope(reply([{ id: 'w9', resolved: false }])), reason: null, ms: 1 }) });
  assert.deepEqual([r.answers, r.state.last.waiting], [[{ id: 'w9', resolved: false, at: null, link: null, from: null, why: null }], 1]);
  const failed = await runScan({ state: blankState(), projects: [], filings: {}, waiting: items, now: NOW, model: 'haiku', budget: 1,
    run: async () => ({ stdout: envelope(reply([{ id: 'other', resolved: true }])), reason: null, ms: 1 }) });
  assert.equal(failed.answers, null);
});
