import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import {
  SCAN_TOOLS, scanArgs, scanWindow, probeDue, scanPrompt, toEpoch, checkScan, readEnvelope, usageTuples, usd, isFiling, filingsIn,
  targetFolder, fileSubject, mergeScan, runScan, parseHours, slotOf, nextScan, inboxView, ingestCommand, scanUsageFiles, localDate, blankState,
} from '../lib/scan.mjs';
import { usageReport } from '../lib/usage.mjs';

const projects = [
  { name: 'acme-rollout', category: 'strategic', path: 'C:/dev/strategic/acme-rollout', description: 'Company-wide rollout.\nWeekly standups.' },
  { name: 'acme-web', category: 'product', path: 'C:/dev/product/acme-web', description: 'The web app.' },
];
const H = 3600e3, D = 24 * H;
const NOW = Date.parse('2026-11-06T18:00:00Z');
const meeting = (o = {}) => ({ id: 'AAkBOQAICN86z7wzAAAuAAAAAB2E=', subject: 'Weekly StandUp', organizer: 'Pat Example',
  start: '2026-11-05T16:00:00.0000000', end: '2026-11-05T16:30:00.0000000', timeZone: 'UTC',
  link: 'https://outlook.office365.com/owa/?itemid=AAk&path=/calendar/item', project: 'strategic/acme-rollout', why: 'standups are filed there', ...o });
const reply = (o = {}) => JSON.stringify({ meetings: [meeting()], transcripts: 'disabled', transcriptError: 'GraphAccessToTranscriptsDisabled', complete: true, ...o });

test('scanArgs: read-only by construction — only ToolSearch built in, only Microsoft 365 read tools allowed, dontAsk', () => {
  const a = scanArgs({ model: 'sonnet', budget: 1 });
  assert.equal(a[a.indexOf('--tools') + 1], 'ToolSearch');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(a.includes('--no-session-persistence'));
  assert.deepEqual(a.slice(a.indexOf('--allowedTools') + 1), [...SCAN_TOOLS]);
  for (const t of SCAN_TOOLS) assert.match(t, /^mcp__claude_ai_Microsoft_365__(outlook_calendar_search|read_resource)$/);
  // Nothing that can change anything: no shell, file, web or agent tool, and no permission bypass anywhere.
  for (const x of a) assert.doesNotMatch(x, /^(Bash|PowerShell|Edit|Write|Read|Glob|Grep|NotebookEdit|WebFetch|WebSearch|Agent|Task)\b|bypass|acceptEdits/i, x);
  assert.throws(() => scanArgs({ model: 'sonnet --dangerously-skip-permissions' }), /not a model name/);
  assert.throws(() => scanArgs({ budget: 0 }), /not a budget/);
  assert.throws(() => scanArgs({ budget: NaN }), /not a budget/);
});

test('scanWindow: 7 days the first time, then since the last good scan less 6 hours, never more than 30 days', () => {
  assert.deepEqual(scanWindow(null, NOW), { since: NOW - 7 * D, until: NOW });
  assert.deepEqual(scanWindow(NOW - 4 * H, NOW), { since: NOW - 10 * H, until: NOW });
  assert.equal(scanWindow(NOW - 90 * D, NOW).since, NOW - 30 * D);
  assert.equal(probeDue({ lastProbe: null }, NOW), true);
  assert.equal(probeDue({ lastProbe: NOW - 5 * H }, NOW), false);
  assert.equal(probeDue({ lastProbe: NOW - 21 * H }, NOW), true);
});

test('scanPrompt: the window, the projects by category/name with their filed transcripts, and the probe only when due', () => {
  const p = scanPrompt({ since: NOW - D, until: NOW, projects, filings: { 'C:/dev/strategic/acme-rollout': [{ name: '2026-10-26_Weekly_StandUp.vtt' }] }, probe: false });
  assert.match(p, /afterDateTime "2026-11-05T18:00:00Z", beforeDateTime "2026-11-06T18:00:00Z"/);
  assert.match(p, /^- strategic\/acme-rollout: Company-wide rollout\. Weekly standups\. \| transcripts filed: 2026-10-26_Weekly_StandUp\.vtt$/m);
  assert.match(p, /^- product\/acme-web: The web app\.$/m);
  assert.match(p, /Read no event and no transcript/);
  assert.doesNotMatch(p, /meetingTranscriptUrl/);
  assert.match(scanPrompt({ since: 0, until: NOW, projects, probe: true }), /meetingTranscriptUrl/);
});

test('toEpoch: UTC as UTC, a named mailbox zone as local wall-clock time, junk as null', () => {
  assert.equal(toEpoch('2026-11-05T21:00:00.0000000', 'UTC'), Date.parse('2026-11-05T21:00:00Z'));
  assert.equal(toEpoch('2026-11-05T21:00:00Z', 'Pacific Standard Time'), Date.parse('2026-11-05T21:00:00Z'));
  assert.equal(toEpoch('2026-11-05T13:00:00.0000000', 'Pacific Standard Time'), new Date(2026, 10, 5, 13).getTime());
  for (const bad of ['tomorrow', '', null, '2026-11-05', '2026-13-45T99:00:00']) assert.equal(toEpoch(bad, 'UTC'), null, String(bad));
});

test('checkScan: the promised shape or nothing — malformed replies fail the whole scan', () => {
  const ok = checkScan(reply(), { projects, now: NOW });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.meetings[0], { id: 'AAkBOQAICN86z7wzAAAuAAAAAB2E=', subject: 'Weekly StandUp', organizer: 'Pat Example',
    start: Date.parse('2026-11-05T16:00:00Z'), end: Date.parse('2026-11-05T16:30:00Z'), date: localDate(Date.parse('2026-11-05T16:00:00Z')),
    link: 'https://outlook.office365.com/owa/?itemid=AAk&path=/calendar/item', project: 'strategic/acme-rollout', why: 'standups are filed there' });
  assert.equal(ok.transcripts, 'disabled');
  assert.equal(checkScan('```json\n' + reply() + '\n```', { projects, now: NOW }).ok, true, 'a fenced reply is still read');
  for (const [bad, why] of [
    ['Here are your meetings!', /not JSON/], ['[]', /no meetings list/], [JSON.stringify({ meetings: {} }), /no meetings list/],
    [reply({ transcripts: 'maybe' }), /transcripts must be/],
    [reply({ meetings: [meeting({ id: 'x' })] }), /valid event id/], [reply({ meetings: [meeting({ id: 'a b c d e f g h' })] }), /valid event id/],
    [reply({ meetings: [meeting({ subject: 7 })] }), /without a subject/], [reply({ meetings: [meeting({ start: 'soon' })] }), /unreadable times/],
    [reply({ meetings: [meeting({ end: '2026-11-05T15:00:00' })] }), /unreadable times/], [reply({ meetings: [meeting({ project: ['x'] })] }), /not a name/],
    [reply({ meetings: ['x'] }), /not an object/],
  ]) { const r = checkScan(bad, { projects, now: NOW }); assert.equal(r.ok, false, bad); assert.match(r.reason, why); }
});

test('checkScan: markup stays plain text, links only to Microsoft 365 hosts, unknown projects read as none, unfinished meetings wait', () => {
  const r = checkScan(reply({ meetings: [
    meeting({ subject: '<img src=x onerror="alert(1)"> Plan\nreview', organizer: '<b>Mallory</b>', link: 'https://evil.example/owa', why: '<script>x</script>' }),
    meeting({ id: 'BBkBOQAICN86z7wzAAAuAAAAAB2E=', project: 'Not-A-Project' }),
    meeting({ id: 'CCkBOQAICN86z7wzAAAuAAAAAB2E=', link: 'javascript:alert(1)' }),
    meeting({ id: 'DDkBOQAICN86z7wzAAAuAAAAAB2E=', end: '2026-11-06T19:00:00Z' }), // still going at NOW
  ] }), { projects, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.meetings.length, 3);
  assert.equal(r.meetings[0].subject, '<img src=x onerror="alert(1)"> Plan review'); // kept as text; the page escapes it
  assert.equal(r.meetings[0].link, null);
  assert.equal(r.meetings[1].project, null);
  assert.equal(r.meetings[1].why, 'named Not-A-Project, not a known project');
  assert.equal(r.meetings[2].link, null);
  assert.equal(checkScan(reply({ meetings: [meeting({ project: 'STRATEGIC/ACME-ROLLOUT' })] }), { projects, now: NOW }).meetings[0].project, 'strategic/acme-rollout');
  assert.equal(checkScan(reply({ meetings: [meeting({ subject: 'x'.repeat(500) })] }), { projects, now: NOW }).meetings[0].subject.length, 200);
});

test('readEnvelope and usageTuples: success, a stop (budget cap), and token counts in the Usage panel\'s shape', () => {
  const modelUsage = { 'claude-sonnet-5-5': { inputTokens: 26, outputTokens: 5875, cacheReadInputTokens: 625744, cacheCreationInputTokens: 79290,
    cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 79290, canonicalModel: 'claude-sonnet-5-5' } };
  assert.deepEqual(usageTuples(modelUsage), { 'claude-sonnet-5-5': [26, 5875, 0, 79290, 625744] });
  assert.ok(Math.abs(usd(usageTuples(modelUsage)) - 0.5011108) < 1e-6);
  const good = readEnvelope(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{}', num_turns: 3, modelUsage, permission_denials: [{ tool_name: 'Bash' }] }));
  assert.deepEqual([good.ok, good.result, good.turns, good.denied], [true, '{}', 3, 1]);
  const capped = readEnvelope(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, num_turns: 9, modelUsage }));
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /error_max_budget_usd/);
  assert.deepEqual(capped.models, usageTuples(modelUsage), 'a stopped run still cost something');
  assert.equal(readEnvelope('not json').ok, false);
});

test('filingsIn: dated .vtt or transcript files up to four folders down, skipping dependency and hidden folders', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'cleon-scan-test-'));
  try {
    const put = async (rel, body = 'x') => { await mkdir(join(root, rel, '..'), { recursive: true }); await writeFile(join(root, rel), body); };
    await put('Communications/2026-10-26_Weekly_StandUp.vtt');
    await put('Communications/2026-10-19_Weekly_StandUp.vtt');
    await put('docs/notes/2026-10-20-review-transcript.md');
    await put('docs/2026-10-20-review-notes.md'); // dated, but neither .vtt nor a transcript
    await put('Communications/Undated meeting.vtt');
    await put('node_modules/pkg/2026-10-01_x.vtt');
    await put('.git/2026-10-01_x.vtt');
    await put('a/b/c/d/e/2026-10-01_too_deep.vtt');
    const f = await filingsIn(root);
    assert.deepEqual(f.map(x => `${x.dir}|${x.name}`), [
      'Communications|2026-10-26_Weekly_StandUp.vtt', 'docs/notes|2026-10-20-review-transcript.md', 'Communications|2026-10-19_Weekly_StandUp.vtt']);
    assert.equal(targetFolder(f), 'Communications');
    assert.equal(targetFolder([]), 'communications');
    assert.deepEqual(await filingsIn(join(root, 'missing')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.equal(isFiling('2026-09-30_1on1_Transcript.txt'), true);
  assert.equal(isFiling('notes-2026-09-30.vtt'), false);
});

test('fileSubject: the subject the way transcripts are named', () => {
  assert.equal(fileSubject('AI Champions: Weekly StandUp'), 'AI_Champions_Weekly_StandUp');
  assert.equal(fileSubject('Q4 plan / review — draft?'), 'Q4_plan_review_draft');
  assert.equal(fileSubject('???'), 'meeting');
});

test('mergeScan: a meeting is flagged once — re-listing keeps its first match and its dismissal; month-old meetings drop', () => {
  const scan = m => ({ meetings: [{ id: 'A', project: 'strategic/acme-rollout', why: 'first', end: NOW - D, ...m }] });
  let s = mergeScan(blankState(), scan(), NOW);
  assert.deepEqual([s.meetings.A.seen, s.meetings.A.dismissed], [NOW, false]);
  s.meetings.A.dismissed = true;
  s = mergeScan(s, scan({ project: 'product/acme-web', why: 'second' }), NOW + H);
  assert.deepEqual([s.meetings.A.project, s.meetings.A.why, s.meetings.A.seen, s.meetings.A.dismissed], ['strategic/acme-rollout', 'first', NOW, true]);
  s = mergeScan({ meetings: { B: { id: 'B', project: null, end: NOW - D } } }, scan({ id: 'B', project: 'product/acme-web', why: 'now matched' }), NOW);
  assert.equal(s.meetings.B.project, 'product/acme-web', 'an unmatched meeting can still be matched later');
  assert.deepEqual(Object.keys(mergeScan({ meetings: { Old: { id: 'Old', end: NOW - 31 * D } } }, { meetings: [] }, NOW).meetings), []);
});

test('runScan: a good scan moves the window and records the probe; a failed or incomplete one keeps them, but still records the cost', async () => {
  const modelUsage = { 'claude-sonnet-5-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
  const envelope = result => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 2, modelUsage });
  let asked;
  const run = stdout => async (args, input) => { asked = { args, input }; return { stdout, reason: null, ms: 1200 }; };
  const s1 = await runScan({ state: blankState(), projects, filings: {}, now: NOW, model: 'sonnet', budget: 1, run: run(envelope(reply())) });
  assert.match(asked.input, /meetingTranscriptUrl/, 'the first scan checks transcripts');
  assert.deepEqual([s1.lastOk, s1.lastProbe, s1.transcripts, s1.last.ok, s1.last.found, s1.runs.length], [NOW, NOW, 'disabled', true, 1, 1]);
  const s2 = await runScan({ state: s1, projects, filings: {}, now: NOW + H, model: 'sonnet', budget: 1, run: run(envelope('nope')) });
  assert.doesNotMatch(asked.input, /meetingTranscriptUrl/, 'not again within 20 hours');
  assert.deepEqual([s2.lastOk, s2.last.ok, s2.runs.length], [NOW, false, 2]);
  assert.match(s2.last.reason, /failed the check: the reply was not JSON/);
  assert.deepEqual(s2.meetings, s1.meetings);
  const s3 = await runScan({ state: s1, projects, filings: {}, now: NOW + H, model: 'sonnet', budget: 1, run: run(envelope(reply({ complete: false }))) });
  assert.deepEqual([s3.lastOk, s3.last.ok, s3.last.complete], [NOW, true, false], 'never moves the window back');
  const fresh = await runScan({ state: blankState(), projects, filings: {}, now: NOW, model: 'sonnet', budget: 1, run: run(envelope(reply({ complete: false }))) });
  assert.equal(fresh.lastOk, Date.parse('2026-11-05T16:00:00Z'), 'an incomplete first scan picks up from the latest meeting it returned');
  const none = await runScan({ state: blankState(), projects, filings: {}, now: NOW, model: 'sonnet', budget: 1, run: run(envelope(reply({ complete: false, meetings: [] }))) });
  assert.equal(none.lastOk, null);
  const s4 = await runScan({ state: s1, projects, filings: {}, now: NOW + H, model: 'sonnet', budget: 1, run: async () => ({ stdout: '', reason: 'claude is not on PATH', ms: 5 }) });
  assert.deepEqual([s4.last.ok, s4.last.reason, s4.runs.length], [false, 'claude is not on PATH', 1]);
});

test('schedule: the scan hours, the slot an hour falls in, and when the next scan runs', () => {
  assert.deepEqual(parseHours(undefined), [8, 12, 16]);
  assert.deepEqual(parseHours('17, 9,9,x,24,-1'), [9, 17]);
  const at = h => new Date(2026, 10, 6, h, 20).getTime();
  assert.equal(slotOf(at(12), [8, 12, 16]), '2026-11-06 12');
  assert.equal(slotOf(at(13), [8, 12, 16]), null);
  assert.equal(nextScan(at(12), [8, 12, 16], null), at(12), 'this hour\'s, not run yet: now');
  assert.equal(nextScan(at(12), [8, 12, 16], '2026-11-06 12'), new Date(2026, 10, 6, 16).getTime());
  assert.equal(nextScan(at(17), [8, 12, 16], '2026-11-06 16'), new Date(2026, 10, 7, 8).getTime());
  assert.equal(nextScan(at(17), [], null), null);
});

test('inboxView: flags for matched meetings with no transcript filed that day; filed and dismissed ones drop off; unmatched listed', () => {
  const m = (id, o) => ({ id, subject: 'Weekly StandUp', organizer: 'Pat', start: NOW - 2 * D, end: NOW - 2 * D + H, date: '2026-11-04', link: null, why: null, ...o });
  const state = { meetings: {
    A: m('A', { project: 'strategic/acme-rollout' }),
    B: m('B', { project: 'strategic/acme-rollout', date: '2026-10-26' }), // filed
    C: m('C', { project: 'strategic/acme-rollout', dismissed: true }),
    E: m('E', { project: null, why: 'no clear project' }),
    F: m('F', { project: 'strategic/gone' }),
  } };
  const filings = { 'C:/dev/strategic/acme-rollout': [{ date: '2026-10-26', name: '2026-10-26_Weekly_StandUp.vtt', dir: 'Communications' }] };
  const v = inboxView(state, { projects, filings });
  assert.deepEqual(v.flags.map(f => [f.id, f.project, f.projectId, f.folder, f.file]),
    [['A', 'acme-rollout', 'strategic/acme-rollout', 'Communications', '2026-11-04_Weekly_StandUp.vtt']]);
  assert.deepEqual(v.unmatched.map(u => [u.id, u.why]), [['E', 'no clear project']]);
});

test('ingestCommand: built only from the event id, date and folder, and refused when any piece needs quoting', () => {
  const flag = { folder: 'Communications', file: '2026-11-04_Weekly_StandUp.vtt' };
  const c = ingestCommand(flag, 'AAk+BO/QA=', 'sonnet');
  assert.match(c, /^claude --model sonnet "File a meeting transcript\. Read calendar:\/\/\/events\/AAk%2BBO%2FQA%3D with/);
  assert.match(c, /Save the transcript text as Communications\/2026-11-04_Weekly_StandUp\.vtt in this project/);
  assert.doesNotMatch(c.slice(c.indexOf('"') + 1, -1), /["$`\\!]/);
  assert.equal(ingestCommand({ ...flag, folder: 'a"; rm -rf ~; "' }, 'AAk', 'sonnet'), null);
  assert.equal(ingestCommand({ ...flag, folder: '$(calc)' }, 'AAk', 'sonnet'), null);
  assert.equal(ingestCommand({ ...flag, folder: '../../elsewhere' }, 'AAk', 'sonnet'), null);
  assert.equal(ingestCommand(flag, 'AAk', 'sonnet; calc'), null);
});

test('scanUsageFiles: a scan\'s cost reaches the Usage report, under the project that holds Cleon', () => {
  const at = Date.now() - 3600e3;
  const files = scanUsageFiles([{ at, turns: 3, models: { 'claude-haiku-5-5': [1000, 2000, 0, 30000, 90000] } }], 'C:/dev/tooling/acme-cleon');
  const r = usageReport(files, { projects: [{ name: 'acme-cleon', path: 'C:/dev/tooling/acme-cleon' }], now: Date.now() });
  const expected = usd({ 'claude-haiku-5-5': [1000, 2000, 0, 30000, 90000] });
  assert.ok(expected > 0);
  assert.equal(r.projects[0].project, 'acme-cleon');
  assert.ok(Math.abs(r.projects[0].week - expected) < 1e-9);
  assert.ok(Math.abs(r.tiles.week - expected) < 1e-9);
});

test('scanUsageFiles: each scan as a Usage entry credited to Cleon\'s folder', () => {
  const runs = [{ at: NOW, turns: 4, models: { 'claude-sonnet-5-5': [1, 2, 3, 4, 5] } }];
  assert.deepEqual(scanUsageFiles(runs, 'C:/dev/tooling/cleon')[`cleon-scans/${NOW}.jsonl`], { cwd: 'C:/dev/tooling/cleon', excluded: false, reviewer: null,
    epic: null, requests: 4, first: NOW, last: NOW, days: { [localDate(NOW)]: { 'claude-sonnet-5-5': [1, 2, 3, 4, 5] } }, byEpic: {}, epicAt: {}, head: [], tail: [], recent: [] });
});
