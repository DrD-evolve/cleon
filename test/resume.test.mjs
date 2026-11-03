import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { parseWorktrees, worktreeFor, epicRepo, lastMode, restartOrchestrator } from '../lib/resume.mjs';

const porcelain = [
  'worktree C:/dev/tooling/acme-web', 'HEAD 1111111', 'branch refs/heads/master', '',
  'worktree C:/wt/acme-web-wt-ACME-588', 'HEAD 2222222', 'branch refs/heads/acme-588-client-not-found', '',
  'worktree C:/wt/scratch', 'HEAD 3333333', 'detached', '',
].join('\n');

test('parseWorktrees reads each worktree\'s path and branch (none when detached)', () => {
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: 'C:/dev/tooling/acme-web', branch: 'master' },
    { path: 'C:/wt/acme-web-wt-ACME-588', branch: 'acme-588-client-not-found' },
    { path: 'C:/wt/scratch', branch: null },
  ]);
  assert.deepEqual(parseWorktrees(porcelain.replace(/\n/g, '\r\n')).length, 3, 'Windows line endings');
  assert.deepEqual(parseWorktrees(''), []);
});

test('a worktree belongs to a ticket whose id its folder or branch carries whole, in any case', () => {
  assert.ok(worktreeFor({ path: 'C:/wt/acme-web-wt-ACME-588', branch: null }, ['ACME-588']));
  assert.ok(worktreeFor({ path: 'C:\\wt\\other', branch: 'acme-588-fix' }, ['ACME-1', 'ACME-588']), 'by branch, lowercased');
  assert.ok(!worktreeFor({ path: 'C:/wt/acme-web-wt-ACME-5880', branch: 'acme-5880' }, ['ACME-588']), 'a longer id');
  assert.ok(!worktreeFor({ path: 'C:/wt/acme-web-wt-XACME-588', branch: null }, ['ACME-588']), 'a longer prefix');
  assert.ok(!worktreeFor({ path: 'C:/wt/ACME-588/web', branch: 'master' }, ['ACME-588']), 'only the folder\'s own name counts');
});

test('epicRepo finds the one repo with a worktree for the epic or a ticket, and says why when it can\'t', async () => {
  const trees = { 'C:/dev/a': parseWorktrees(porcelain), 'C:/dev/b': [{ path: 'C:/wt/b-wt-ACME-600', branch: 'acme-600-x' }], 'C:/dev/c': [] };
  const of = async repo => trees[repo];
  assert.deepEqual(await epicRepo(['ACME-100', 'ACME-588'], Object.keys(trees), of), { repo: 'C:/dev/a' });
  assert.match((await epicRepo(['ACME-700'], Object.keys(trees), of)).reason, /no repo has a worktree/);
  assert.match((await epicRepo(['ACME-588', 'ACME-600'], Object.keys(trees), of)).reason, /more than one repo \(a, b\)/);
});

test('lastMode takes the newest recorded permission mode among the tickets, ignoring anything not a CLI choice', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-mode-'));
  try {
    const put = async (ticket, text, at) => {
      await mkdir(join(dir, 'ACME-1', ticket), { recursive: true });
      const p = join(dir, 'ACME-1', ticket, 'ORCHESTRATOR_PERMISSION_MODE');
      await writeFile(p, text);
      await utimes(p, at, at);
    };
    await put('ACME-2', 'acceptEdits\n', 1000);
    await put('ACME-3', 'auto', 2000);
    await put('ACME-4', 'rm -rf ~', 3000);
    assert.equal(await lastMode(dir, 'ACME-1', ['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4']), 'auto');
    assert.equal(await lastMode(dir, 'ACME-1', ['ACME-2']), 'acceptEdits');
    assert.equal(await lastMode(dir, 'ACME-1', ['ACME-4', 'ACME-9']), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const run = { epic: 'ACME-588', root: 'C:/no-such-runs', tickets: [{ ticket: 'ACME-588', step: 'self-review' }] };
const deps = (calls, over = {}) => ({
  runs: async () => ({ runs: [run, { epic: 'ACME-1', root: 'C:/x', tickets: [{ ticket: 'ACME-2', step: 'done' }] }] }),
  orchestrators: async () => [],
  repos: async () => ['C:/dev/tooling/acme-web', 'C:/dev/tooling/other'],
  worktreesOf: async repo => (repo.endsWith('acme-web') ? parseWorktrees(porcelain) : []),
  findProject: async path => ({ name: path.split('/').pop(), path }),
  start: async (project, how) => { calls.push({ project: project.name, ...how }); return { ok: true, ran: true, session: 'acme-web', raised: project.name, attached: false }; },
  started: new Map(),
  ...over,
});

test('restartOrchestrator starts orchestrate-work for the epic in its repo, beside its workers when their workspace is recorded', async () => {
  const calls = [];
  const r = await restartOrchestrator('ACME-588', deps(calls));
  assert.deepEqual(calls, [{ project: 'acme-web', command: 'claude "/orchestration:orchestrate-work ACME-588"', label: 'ACME-588 orchestrator', tab: undefined }],
    'no permission mode recorded, so none is passed; no workspace recorded, so a workspace of its own');
  assert.deepEqual(r, { ok: true, ran: true, session: 'acme-web', raised: 'acme-web', attached: false, epic: 'ACME-588', project: 'acme-web', mode: null });
  const beside = [];
  await restartOrchestrator('ACME-588', deps(beside, { runs: async () => ({ runs: [{ ...run, workspace: 'wM', label: 'ACME-588 accept loop' }] }) }));
  assert.deepEqual(beside[0].tab, { workspace: { id: 'wM', label: 'ACME-588 accept loop' }, label: 'orchestrator' });
  const unlabelled = [];
  await restartOrchestrator('ACME-588', deps(unlabelled, { runs: async () => ({ runs: [{ ...run, workspace: 'wM', label: null }] }) }));
  assert.equal(unlabelled[0].tab, undefined, 'an id alone could be any workspace after a restart');
});

test('restartOrchestrator passes the last orchestrator\'s permission mode', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-mode-'));
  try {
    await mkdir(join(dir, 'ACME-588', 'ACME-588'), { recursive: true });
    await writeFile(join(dir, 'ACME-588', 'ACME-588', 'ORCHESTRATOR_PERMISSION_MODE'), 'bypassPermissions');
    const calls = [];
    const r = await restartOrchestrator('ACME-588', deps(calls, { runs: async () => ({ runs: [{ ...run, root: dir }] }) }));
    assert.equal(calls[0].command, 'claude --permission-mode bypassPermissions "/orchestration:orchestrate-work ACME-588"');
    assert.equal(r.mode, 'bypassPermissions');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restartOrchestrator refuses a bad id, an unlisted or finished run, a live orchestrator, and an unknown repo', async () => {
  const calls = [];
  assert.equal((await restartOrchestrator('acme-588; rm -rf ~', deps(calls))).reason, 'not an epic id');
  assert.match((await restartOrchestrator('ACME-999', deps(calls))).reason, /isn't a listed run/);
  assert.match((await restartOrchestrator('ACME-1', deps(calls))).reason, /every ticket in ACME-1 is done/);
  assert.match((await restartOrchestrator('ACME-588', deps(calls, { orchestrators: async () => [{ epic: 'ACME-588' }] }))).reason, /already has a live orchestrator/);
  assert.match((await restartOrchestrator('ACME-588', deps(calls, { worktreesOf: async () => [] }))).reason, /can't tell which repo ACME-588 runs in: no repo has a worktree/);
  assert.match((await restartOrchestrator('ACME-588', deps(calls, { findProject: async () => null }))).reason, /isn't a known project/);
  assert.deepEqual(calls, [], 'nothing was started');
});

test('a second restart is refused while the first orchestrator comes up, but not after a failed start', async () => {
  const calls = [], started = new Map();
  assert.equal((await restartOrchestrator('ACME-588', deps(calls, { started, now: 0 }))).ok, true);
  assert.match((await restartOrchestrator('ACME-588', deps(calls, { started, now: 30_000 }))).reason, /was started 30s ago/);
  assert.equal((await restartOrchestrator('ACME-588', deps(calls, { started, now: 200_000 }))).ok, true, 'after the settle window');
  assert.equal(calls.length, 2);

  const failed = new Map();
  await restartOrchestrator('ACME-588', deps([], { started: failed, start: async () => ({ ok: false, reason: 'herdr not found' }) }));
  assert.equal((await restartOrchestrator('ACME-588', deps([], { started: failed }))).ok, true, 'a failed start doesn\'t block a retry');
  const unrun = new Map();
  await restartOrchestrator('ACME-588', deps([], { started: unrun, start: async () => ({ ok: true, ran: false, session: 's' }) }));
  assert.equal(unrun.size, 0, 'nor does a command herdr didn\'t take');
});
