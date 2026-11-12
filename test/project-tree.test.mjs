import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { parseKey, checkRel, listFolder, parseGitStatus, markOf, previewClass, resolveIn, gitMarks, TREE_CAP } from '../lib/project-tree.mjs';
import { CATEGORIES } from '../lib/config.mjs';
import { findProjectByKey } from '../lib/projects.mjs';

test('parseKey takes exactly <category>/<name>', () => {
  assert.deepEqual(parseKey('tools/acme'), { category: 'tools', name: 'acme' });
  for (const k of ['', 'tools', 'tools/', '/acme', 'a/b/c', '../acme', 'tools/..', './x', 'tools\\acme', 'C:/acme', 'tools/a:b', 'tools/a\0b', null, undefined, 5])
    assert.equal(parseKey(k), null, String(k));
});

test('checkRel refuses every spelling that leaves the folder or aliases another name', () => {
  assert.deepEqual(checkRel(''), []);
  assert.deepEqual(checkRel('src/lib'), ['src', 'lib']);
  for (const r of ['..', '../x', 'a/../b', 'a/./b', '/abs', 'a//b', 'a/', '..\\x', '\\\\host\\share\\x', 'C:', 'C:/x', 'a.txt:stream', 'a\0b', 'dir.', 'dir /x', 'a/b ', null, 7])
    assert.equal(checkRel(r), null, String(r));
});

test('listFolder lists dirs first then A-Z, using only readdir and lstat', async () => {
  const calls = [], d = (name, kind) => ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' });
  const fs = {
    readdir: async (dir, o) => { calls.push('readdir'); assert.deepEqual(o, { withFileTypes: true }); return [d('b.txt', 'file'), d('Zed', 'dir'), d('alpha', 'dir'), d('A.md', 'file'), d('lnk', 'link')]; },
    lstat: async () => { calls.push('lstat'); return { size: 8 * 1024 * 1024, mtimeMs: 5 }; },
  };
  const { entries, more } = await listFolder('x', fs);
  assert.deepEqual(entries.map(e => e.name), ['alpha', 'Zed', 'A.md', 'b.txt', 'lnk']);
  assert.deepEqual(entries.map(e => e.type), ['dir', 'dir', 'file', 'file', 'link']);
  assert.equal(entries.find(e => e.name === 'A.md').size, 8 * 1024 * 1024);
  assert.equal(more, 0);
  assert.deepEqual([...new Set(calls)].sort(), ['lstat', 'readdir']);
});

test('listFolder over a real folder with an 8 MB file reads no bytes', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-tree-'));
  try {
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(8 * 1024 * 1024));
    const seen = [], real = await import('node:fs/promises');
    const rec = name => async (...a) => { seen.push(name); return real[name](...a); };
    const { entries } = await listFolder(dir, { readdir: rec('readdir'), lstat: rec('lstat') });
    assert.equal(entries[0].size, 8 * 1024 * 1024);
    assert.deepEqual([...new Set(seen)].sort(), ['lstat', 'readdir']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('listFolder sorts first, then keeps the first cap entries and counts the rest', async () => {
  const names = Array.from({ length: TREE_CAP + 5 }, (_, i) => `f${String(i).padStart(5, '0')}`).reverse();
  const fs = { readdir: async () => names.map(name => ({ name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false })), lstat: async () => ({ size: 0, mtimeMs: 0 }) };
  const { entries, more } = await listFolder('x', fs);
  assert.equal(entries.length, TREE_CAP);
  assert.equal(entries[0].name, 'f00000');
  assert.equal(more, 5);
});

test('parseGitStatus and markOf', () => {
  const marks = parseGitStatus(' M src/a.js\0?? new.txt\0!! build/\0R  moved.js\0old.js\0!! tmp/x/\0?? dir/\0 M dir2/f.txt\0');
  assert.equal(marks.get('src/a.js'), 'modified');
  assert.equal(marks.get('build'), 'ignored');
  assert.equal(marks.get('moved.js'), 'modified');
  assert.ok(!marks.has('old.js'));
  assert.equal(markOf(marks, 'src/a.js', false), 'modified');
  assert.equal(markOf(marks, 'src', true), 'modified');
  assert.equal(markOf(marks, 'build/out.js', false), 'ignored');
  assert.equal(markOf(marks, 'dir/inner.txt', false), 'untracked');
  assert.equal(markOf(marks, 'tmp', true), 'ignored');
  assert.equal(markOf(marks, 'README.md', false), null);
  assert.equal(markOf(new Map(), 'a', false), null);
  assert.equal(markOf(parseGitStatus(''), 'a', true), null);
});

test('gitMarks shares one run for ten seconds and treats a failure as no marks', async () => {
  let n = 0;
  const run = async () => { n++; return ' M a.txt\0'; };
  const [a, b] = await Promise.all([gitMarks('acme-share', { run }), gitMarks('acme-share', { run })]);
  assert.equal(n, 1);
  assert.equal(a.get('a.txt'), 'modified');
  assert.equal(b, a);
  assert.equal((await gitMarks('acme-fail', { run: async () => { throw new Error('not a repo'); } })).size, 0);
});

test('previewClass blocks secrets and data exports, allows listed text types, and nothing else', () => {
  for (const n of ['.env', '.ENV.local', '.env.example', 'a.pem', 'A.KEY', 'x.pfx', 'x.p12', 'id_rsa', 'id_ed25519.pub', 'book.xlsx', 'old.xls', 'data.CSV'])
    assert.equal(previewClass(n).preview, 'blocked', n);
  assert.ok(previewClass('.env').reason);
  for (const n of ['a.md', 'a.JSON', 'x.mjs', '.gitignore', 'Makefile', 'LICENSE', 'README', 'p.ps1', 'page.html', 'i.svg'])
    assert.equal(previewClass(n).preview, 'text', n);
  for (const n of ['a.png', 'a.exe', 'notes', 'a.docx', 'archive.zip', 'a.'])
    assert.equal(previewClass(n).preview, 'none', n);
});

test('findProjectByKey and resolveIn find only a listed project folder and a plain path below it', async t => {
  const root = await mkdtemp(join(os.tmpdir(), 'cleon-res-')), cat = CATEGORIES?.[0] ?? 'tools'; // MC_CATEGORIES, when set, names the folders read
  try {
    await mkdir(join(root, cat, 'acme-app', 'src'), { recursive: true });
    await mkdir(join(root, cat, 'acme-secret'), { recursive: true });
    await mkdir(join(root, 'elsewhere'), { recursive: true });
    await writeFile(join(root, cat, 'acme-app', 'src', 'a.md'), 'a');
    const exclude = /acme-secret/i;
    assert.equal((await findProjectByKey(cat, 'acme-app', root, exclude)).name, 'acme-app');
    assert.equal(await findProjectByKey(cat, 'acme-secret', root, exclude), null);
    assert.equal(await findProjectByKey(cat, 'ACME-APP/..', root, exclude), null);
    const ok = (k, r, w) => resolveIn(k, r, w, { root, exclude });
    assert.ok(await ok(`${cat}/acme-app`, '', 'dir'));
    assert.ok(await ok(`${cat}/acme-app`, 'src', 'dir'));
    assert.ok(await ok(`${cat}/acme-app`, 'src/a.md', 'file'));
    assert.ok(await ok(`${cat}/acme-app`, 'SRC/A.md', 'file'), 'case differs: the same file on Windows');
    assert.equal(await ok(`${cat}/acme-app`, 'src', 'file'), null);
    assert.equal(await ok(`${cat}/acme-app`, '../acme-secret', 'dir'), null);
    assert.equal(await ok(`${cat}/acme-secret`, '', 'dir'), null);
    assert.equal(await ok(`${cat}/acme-app`, 'missing', 'dir'), null);
    try { await symlink(join(root, 'elsewhere'), join(root, cat, 'acme-app', 'src', 'out'), 'junction'); } catch (e) { t.diagnostic(`no junction: ${e.code}`); return t.skip('cannot make a junction'); }
    assert.equal(await ok(`${cat}/acme-app`, 'src/out', 'dir'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
