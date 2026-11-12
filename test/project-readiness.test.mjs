import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { walkActivity, memoryFolder, mcpCommands, mcpMatches, mcpReader, mentions, mentionFlags, readMentionTexts, gitExtra, matchLinear, matchPrs } from '../lib/project-readiness.mjs';

const d = (name, kind) => ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' });
// A fs that records every method asked of it and refuses any but readdir and lstat: no way to open a file.
const recorder = tree => {
  const calls = [];
  const fs = new Proxy({}, { get: (_, m) => {
    calls.push(m);
    if (m === 'readdir') return async p => { calls.push(`readdir:${p}`); if (!tree[p]) throw new Error('ENOENT'); return tree[p]; };
    if (m === 'lstat') return async p => ({ isFile: () => true, isDirectory: () => false, mtimeMs: tree.mtimes?.[p] ?? 1000 });
    throw new Error(`fs.${String(m)} must not be called`);
  } });
  return { fs, calls };
};
const seen = calls => calls.filter(c => !c.startsWith('readdir:'));

test('walkActivity, memoryFolder take only readdir and lstat: nothing opens a file', async () => {
  const { fs, calls } = recorder({
    mtimes: { [join('/p', 'a.txt')]: 5000, [join('/p', 'src', 'b.js')]: 9000, [join('/p', '.env')]: 7000 },
    '/p': [d('a.txt', 'file'), d('.env', 'file'), d('src', 'dir'), d('.git', 'dir'), d('node_modules', 'dir'), d('lnk', 'link')],
    [join('/p', 'src')]: [d('b.js', 'file')],
    [join('/h', '.claude', 'projects')]: [d('-p', 'dir')],
    [join('/h', '.claude', 'projects', '-p', 'memory')]: [],
  });
  const r = await walkActivity('/p', fs);
  assert.deepEqual(r, { at: 9000, partial: false, env: true });
  await memoryFolder('/p', '/h', fs);
  assert.ok(seen(calls).length > 0);
  assert.ok(seen(calls).every(m => m === 'readdir' || m === 'lstat'), seen(calls).join());
  assert.ok(!calls.includes(`readdir:${join('/p', '.git')}`) && !calls.includes(`readdir:${join('/p', 'node_modules')}`));
});

test('walkActivity skips what it should and says so when a cap ends it', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'cleon-rd-'));
  try {
    const put = async (rel, mtime) => { const p = join(root, rel); await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, 'x'); await utimes(p, mtime, mtime); };
    await put('old.txt', 1000);
    await put('sub/new.txt', 3000);
    await put('.git/obj', 9000);
    await put('a/node_modules/x.js', 9000);
    await put('a/.venv/y.py', 9000);
    await put('.claude/settings.json', 9000);
    await put('.claude/keep.md', 2000);
    await put('acme-hidden/z.txt', 9000);
    const r = await walkActivity(root, undefined, { exclude: /acme-hidden/i });
    assert.deepEqual(r, { at: 3_000_000, partial: false, env: false });
    await put('deep/1/2/3.txt', 4000);
    assert.equal((await walkActivity(root, undefined, { maxDepth: 1 })).partial, true);
    assert.equal((await walkActivity(root, undefined, { maxEntries: 2 })).partial, true);
    let t = 0;
    assert.equal((await walkActivity(root, undefined, { now: () => (t += 3000), budgetMs: 2000 })).partial, true);
  // One flat folder: the walk starts and enters it at 0 ms, then each entry costs 1500 ms; the budget ends it inside the folder.
  let u = 0;
  const flat = recorder({ '/f': ['a', 'b', 'c', 'd'].map(n => d(n, 'file')) });
  assert.equal((await walkActivity('/f', flat.fs, { now: () => Math.max(0, u++ - 1) * 1500, budgetMs: 2000 })).partial, true);
    assert.equal((await walkActivity(join(root, 'nothing'))).at, null);
    await put('.env.local', 5000);
    assert.equal((await walkActivity(root)).env, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('walkActivity does not follow a link or junction', async () => {
  const tmp = await mkdtemp(join(os.tmpdir(), 'cleon-rd-'));
  try {
    const root = join(tmp, 'p');
    await mkdir(join(tmp, 'outside'), { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(join(tmp, 'outside', 'new.txt'), 'x');
    await writeFile(join(root, 'old.txt'), 'x');
    await utimes(join(root, 'old.txt'), 1000, 1000);
    try { await symlink(join(tmp, 'outside'), join(root, 'link'), 'junction'); } catch { return; } // an account that may not link
    assert.equal((await walkActivity(root)).at, 1_000_000);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('memoryFolder: a memory folder under the project slug, found whatever the case', async () => {
  const home = await mkdtemp(join(os.tmpdir(), 'cleon-rd-'));
  try {
    const proj = join(home, 'dev', 'tools', 'acme-app');
    assert.equal(await memoryFolder(proj, home), false);
    const slug = proj.replace(/[^a-zA-Z0-9]/g, '-');
    await mkdir(join(home, '.claude', 'projects', slug), { recursive: true });
    assert.equal(await memoryFolder(proj, home), false, 'a store with no memory folder');
    await writeFile(join(home, '.claude', 'projects', slug, 'memory'), 'a file');
    assert.equal(await memoryFolder(proj, home), false, 'a file is not a folder');
    await rm(join(home, '.claude', 'projects', slug, 'memory'));
    await mkdir(join(home, '.claude', 'projects', slug, 'memory'), { recursive: true });
    assert.equal(await memoryFolder(proj, home), true);
    assert.equal(await memoryFolder(proj, home, undefined, /acme-app/), false, 'MC_EXCLUDE');
  } finally { await rm(home, { recursive: true, force: true }); }
});

const TOKEN = 'acme-tok-0123456789';
const claudeJson = JSON.stringify({
  mcpServers: { a: { command: 'node', args: ['C:\\dev\\tools\\acme-app\\mcp\\index.js'], env: { ACME_TOKEN: TOKEN }, headers: { authorization: TOKEN } } },
  projects: { 'C:/x': { mcpServers: { b: { command: 'npx', args: ['acme-server'], env: { ACME_TOKEN: TOKEN } } }, history: [{ display: TOKEN }] } },
});

test('mcpCommands keeps only command and args, and drops every env and headers key', () => {
  const cmds = mcpCommands(claudeJson);
  assert.deepEqual(cmds, [{ command: 'node', args: ['C:\\dev\\tools\\acme-app\\mcp\\index.js'] }, { command: 'npx', args: ['acme-server'] }]);
  assert.ok(!JSON.stringify(cmds).includes(TOKEN));
  assert.deepEqual(mcpCommands('{"mcpServers":{"a":{"command":5,"args":[1,"x"]}}}'), [{ command: '', args: ['x'] }]);
  assert.deepEqual(mcpCommands('{}'), []);
});

test('mcpCommands swallows a parse error: null, and nothing of the input escapes', () => {
  const bad = `{"mcpServers": {"a": {"env": {"ACME_TOKEN": "${TOKEN}"`; // truncated
  assert.equal(mcpCommands(bad), null);
  assert.equal(mcpCommands(undefined), null);
  assert.equal(mcpCommands(null), null);
});

test('mcpMatches: the project path as a prefix, any slash, any case; a bare name matches nothing', () => {
  const cmds = mcpCommands(claudeJson);
  assert.equal(mcpMatches(cmds, 'C:/dev/tools/acme-app'), true);
  assert.equal(mcpMatches(cmds, 'c:\\DEV\\tools\\acme-app'), true);
  assert.equal(mcpMatches(cmds, 'C:/dev/tools/acme'), false, 'a longer name is not a prefix');
  assert.equal(mcpMatches([{ command: 'npx', args: ['acme-server'] }], 'C:/dev/tools/acme-server'), false);
  assert.equal(mcpMatches([{ command: 'node', args: ['--dir "C:/dev/tools/acme-app" x'] }], 'C:/dev/tools/acme-app'), true);
  assert.equal(mcpMatches(null, 'C:/x'), false);
});

test('mcpReader: null when absent, too big or unreadable; re-reads only when the file changes', async () => {
  let reads = 0, st = { isFile: () => true, size: 10, mtimeMs: 1 };
  const read = mcpReader('/h/.claude.json', { stat: async () => st, readFile: async () => { reads++; return claudeJson; } });
  assert.equal((await read()).length, 2);
  await read();
  assert.equal(reads, 1);
  st = { ...st, mtimeMs: 2 };
  await read();
  assert.equal(reads, 2);
  assert.equal(await mcpReader('/x', { stat: async () => { throw new Error('ENOENT'); } })(), null);
  assert.equal(await mcpReader('/x', { stat: async () => ({ isFile: () => true, size: 33 * 1024 * 1024, mtimeMs: 1 }), readFile: async () => { throw new Error('big'); } })(), null);
  assert.equal(await mcpReader('/x', { stat: async () => st, readFile: async () => { throw new Error(TOKEN); } })(), null);
});

const P = { path: 'C:/dev/tools/acme-app', category: 'tools', name: 'acme-app' };
test('mentions: the path, <category>/<name> or the name as a whole token; short and common names only by path', () => {
  assert.equal(mentions('see C:\\dev\\tools\\acme-app\\src', P), true);
  assert.equal(mentions('see tools/acme-app.', P), true);
  assert.equal(mentions('The Acme-App project', P), true);
  assert.equal(mentions('acme-application and my-acme-app', P), false, 'not a whole token');
  assert.equal(mentions('nothing here', P), false);
  const short = { path: 'C:/dev/tools/app', category: 'tools', name: 'app' };
  assert.equal(mentions('an app that does things', short), false, 'a common word');
  assert.equal(mentions('see tools/app', short), true);
  const tiny = { path: 'C:/dev/tools/ab', category: 'tools', name: 'ab' };
  assert.equal(mentions('ab', tiny), false);
  assert.equal(mentions('C:/dev/tools/ab/x', tiny), true);
  const dotted = { path: 'C:/dev/tools/a.b+c1', category: 'tools', name: 'a.b+c1' };
  assert.equal(mentions('xaxb+c1 and a-b+c1', dotted), false, 'the name is escaped');
  assert.equal(mentions('We moved acme-app.', P), true, 'a sentence-final dot ends the name');
  assert.equal(mentions('We moved acme-app.bak and tools/acme-app.v2 and C:/dev/tools/acme-app.old', P), false, 'a sibling with a dotted suffix is another folder');
});

test('mentionFlags: booleans per kind, projectList null when the setting is off', () => {
  const texts = [{ kind: 'claudeMd', text: 'tools/acme-app' }, { kind: 'workspace', text: 'unrelated' }, { kind: 'projectList', text: 'acme-app' }];
  assert.deepEqual(mentionFlags(texts, P, true), { claudeMd: true, workspace: false, projectList: true });
  assert.deepEqual(mentionFlags(texts, P, false), { claudeMd: true, workspace: false, projectList: null });
  assert.deepEqual(mentionFlags([], P, true), { claudeMd: false, workspace: false, projectList: false });
});

test('readMentionTexts reads the fixed files only, and skips an excluded, huge or missing one', async () => {
  const tmp = await mkdtemp(join(os.tmpdir(), 'cleon-rd-'));
  try {
    const root = join(tmp, 'dev'), home = join(tmp, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'root md');
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'home md');
    await writeFile(join(root, 'a.code-workspace'), 'ws');
    await writeFile(join(root, 'notes.md'), 'not read');
    await writeFile(join(tmp, 'list.json'), 'list');
    const got = await readMentionTexts({ root, home, projectList: join(tmp, 'list.json') });
    assert.deepEqual(got.map(x => `${x.kind}:${x.text}`).sort(), ['claudeMd:home md', 'claudeMd:root md', 'projectList:list', 'workspace:ws']);
    assert.deepEqual((await readMentionTexts({ root, home, projectList: join(tmp, 'nope.json') })).map(x => x.kind).sort(), ['claudeMd', 'claudeMd', 'workspace']);
    const ex = await readMentionTexts({ root, home, projectList: null }, undefined, /a\.code-workspace|home[\\/]\.claude/);
    assert.deepEqual(ex.map(x => x.text), ['root md']);
    const big = await readMentionTexts({ root, home }, { lstat: async () => ({ isFile: () => true, size: 2 * 1024 * 1024 }) });
    assert.deepEqual(big, []);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('gitExtra counts commits no remote has and sees whether there is a remote; a failure is null', async () => {
  const calls = [];
  const run = async (p, args) => { calls.push(args[0]); return args[0] === 'remote' ? 'origin\n' : '3\n'; };
  assert.deepEqual(await gitExtra('acme-x1', { run }), { unpushed: 3, remote: true });
  await gitExtra('acme-x1', { run });
  assert.equal(calls.length, 2, 'shared for ten seconds');
  assert.deepEqual(await gitExtra('acme-x2', { run: async (p, a) => (a[0] === 'remote' ? '' : '7\n') }), { unpushed: 7, remote: false });
  assert.equal(await gitExtra('acme-x3', { run: async () => { throw new Error('no'); } }), null);
});

test('matchLinear and matchPrs: by repository name, capped, null when not loaded', () => {
  const linear = { online: true, issues: [{ identifier: 'ACME-1', url: 'https://x/1', project: { name: 'Acme App' } }, { identifier: 'ACME-2', url: 'https://x/2', project: { name: 'Other' } }, { identifier: 'ACME-3', url: 'https://x/3', project: null }] };
  assert.deepEqual(matchLinear(linear, 'acme-app'), { open: 1, items: [{ id: 'ACME-1', url: 'https://x/1' }] });
  assert.deepEqual(matchLinear(linear, 'nothing'), { open: 0, items: [] });
  assert.equal(matchLinear(undefined, 'acme-app'), null);
  assert.equal(matchLinear({ online: false }, 'acme-app'), null);
  const pr = (n, repo, url = `https://x/pr/${n}`) => ({ number: n, url, repository: { name: repo } });
  const scm = { online: true, myPrs: [pr(1, 'acme-app'), pr(2, 'other')], reviewRequests: [pr(1, 'acme-app'), ...[3, 4, 5, 6, 7, 8].map(n => pr(n, 'Acme_App'))] };
  const r = matchPrs(scm, 'acme-app');
  assert.equal(r.open, 7, 'deduped by url');
  assert.equal(r.items.length, 5);
  assert.equal(r.items[0].ref, 'acme-app#1');
  assert.equal(matchPrs(undefined, 'x'), null);
  assert.equal(matchPrs({ online: false }, 'x'), null);
  assert.deepEqual(matchPrs({ online: true }, 'x'), { open: 0, items: [] });
  const bare = { online: true, myPrs: [pr(1, 'acme-app', null), pr(2, 'acme-app', null)] };
  assert.equal(matchPrs(bare, 'acme-app').open, 2, 'two PRs without a url are two PRs');
});
