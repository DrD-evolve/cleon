import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { classifyProcess, classifyRequest, transcriptSession, createRecorder, summarize, recorder, asking, KEEP_MS } from '../lib/activity.mjs';

test('classifyProcess names what each program checks, and never an excluded folder', () => {
  const ex = /secret/i;
  assert.deepEqual(classifyProcess('git', ['-C', String.raw`C:\dev\tooling\acme`, 'status', '--porcelain'], ex),
    { node: 'git', what: 'acme · git status --porcelain' });
  assert.deepEqual(classifyProcess('git', ['-C', String.raw`C:\dev\secret-books`, 'log', '-1'], ex),
    { node: 'git', what: '(excluded folder) · git log -1' });
  assert.deepEqual(classifyProcess('git', ['-C', String.raw`C:\dev\ACME-private`, 'log', '-1'], /C:\/dev\/ACME-private/i),
    { node: 'git', what: '(excluded folder) · git log -1' });
  assert.deepEqual(classifyProcess('herdr', ['--session', 'cleon', 'api', 'snapshot'], ex), { node: 'herdr:cleon', what: 'herdr api snapshot' });
  assert.deepEqual(classifyProcess('herdr', ['session', 'list', '--json'], ex), { node: 'herdr', what: 'herdr session list --json' });
  assert.equal(classifyProcess('gh', ['pr', 'view', 'https://x/1', '--json', 'state'], ex).node, 'github');
  assert.equal(classifyProcess(String.raw`C:\Windows\System32\tasklist.exe`, ['/FO', 'CSV'], ex).node, 'windows');
  assert.deepEqual(classifyProcess('python', ['-I', String.raw`C:\dev\tooling\cleon\lib\proc-stats.py`, '--io', '12'], ex),
    { node: 'windows', what: 'proc-stats.py --io 12' });
  assert.deepEqual(classifyProcess('C:/Program Files/Git/usr/bin/mintty.exe', ['--class', 'x'], ex), { node: 'terminal', what: 'open a Git Bash window' });
  assert.equal(classifyProcess('docker', ['system', 'df'], ex).node, 'docker');
  assert.equal(classifyProcess('something', [], ex).node, 'something');
});

test('classifyRequest names the service and keeps only the path', () => {
  assert.deepEqual(classifyRequest('https://api.linear.app', '/graphql', null), { node: 'linear', what: 'Linear GraphQL' });
  assert.deepEqual(classifyRequest('https://bb.example.com', '/rest/api/1.0/dashboard/pull-requests?state=OPEN&user=me', 'https://bb.example.com/'),
    { node: 'bitbucket', what: '/rest/api/1.0/dashboard/pull-requests' });
  assert.equal(classifyRequest('http://127.0.0.1:11434', '/api/ps', null).node, 'ollama');
  assert.equal(classifyRequest('https://other.example:8443', '/x', null).node, 'web:other.example:8443');
  assert.equal(classifyRequest('https://bb.example.com', '/x', 'not a url').node, 'web:bb.example.com');
});

test('transcriptSession finds the session of a transcript or a subagent transcript', () => {
  assert.equal(transcriptSession('C:/u/.claude/projects/p/abc-123.jsonl'), 'abc-123');
  assert.equal(transcriptSession('C:/u/.claude/projects/p/abc-123/subagents/agent-9.jsonl'), 'abc-123');
});

test('the recorder hands out what changed since a rev, and trims only finished events past the window', () => {
  let t = 1000;
  const r = createRecorder(() => t);
  const a = r.start({ kind: 'program', node: 'git' });
  const b = r.start({ kind: 'web', node: 'linear' });
  const seen = r.rev;
  t += 50;
  r.finish(a, { result: 'no', why: 'exit 128' });
  assert.deepEqual(r.since(seen).map(e => [e.node, e.ms, e.result]), [['git', 50, 'no']]);
  r.finish(a, { result: 'ok' }); // a second finish changes nothing
  assert.equal(a.result, 'no');
  const n = r.note({ kind: 'session', node: 'claude:s1', cached: true }, t - 5);
  assert.deepEqual([n.ms, n.result, n.cached], [5, 'ok', true]);
  assert.deepEqual(r.takeCounts(), { program: 1, web: 1, page: 0, session: 1 });
  assert.deepEqual(r.takeCounts(), { program: 0, web: 0, page: 0, session: 0 });
  t += KEEP_MS + 1;
  r.trim();
  assert.deepEqual(r.events.map(e => e.node), ['linear']); // still running, so kept
});

test('summarize totals each node, its results and which endpoints asked', () => {
  const s = summarize([
    { node: 'git', at: 1, ms: 10, result: 'ok', route: '/api/projects' },
    { node: 'git', at: 2, ms: 30, result: 'no', route: '/api/projects' },
    { node: 'git', at: 3, ms: null, route: null },
    { node: 'claude:s1', at: 4, ms: 1, result: 'ok', cached: true, route: '/api/attention' },
  ]);
  assert.deepEqual(s.git, { calls: 3, running: 1, ok: 1, no: 1, fail: 0, cached: 0, maxMs: 30, last: 3, avgMs: 20,
    routes: { '/api/projects': 2, background: 1 } });
  assert.equal(s['claude:s1'].cached, 1);
});

const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } return null; };

test('programs, web requests and page requests are recorded with the endpoint that asked', async () => {
  const from = recorder.rev;
  const srv = createServer((req, res) => res.end('pong'));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    await asking.run({ route: '/api/test' }, async () => {
      await new Promise(r => execFile(process.execPath, ['-e', 'process.exit(3)'], () => r()));
      await (await fetch(`http://127.0.0.1:${port}/api/ping?x=1`)).text();
    });
    const prog = await until(() => recorder.since(from).find(e => e.kind === 'program' && e.ms != null));
    assert.deepEqual([prog.node, prog.route, prog.result, prog.why], ['node', '/api/test', 'no', 'exit 3']);
    const web = await until(() => recorder.since(from).find(e => e.kind === 'web' && e.ms != null));
    assert.deepEqual([web.node, web.what, web.route, web.result], [`web:127.0.0.1:${port}`, '/api/ping', '/api/test', 'ok']);
    const page = await until(() => recorder.since(from).find(e => e.kind === 'page' && e.ms != null));
    assert.deepEqual([page.what, page.route, page.result], ['GET /api/ping', '/api/ping', 'ok']);
  } finally {
    srv.close();
  }
});

test('proc-stats.py --io reads this process\'s I/O totals', { skip: process.platform !== 'win32' }, async () => {
  const script = fileURLToPath(new URL('../lib/proc-stats.py', import.meta.url));
  const out = await new Promise(r => execFile('python', ['-I', script, '--io', String(process.pid)], (e, o) => r(e ? null : o)));
  const j = JSON.parse(out);
  assert.ok(Number.isInteger(j.read) && j.read > 0 && Number.isInteger(j.write));
});
