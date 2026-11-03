import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { firstParagraph, findProject, listProjects, parseStatus } from '../lib/projects.mjs';
import { CATEGORIES } from '../lib/config.mjs';

test('parseStatus reads the branch and counts changed files from porcelain v2', () => {
  const out = '# branch.oid 1a2b\n# branch.head main\n# branch.upstream origin/main\n1 .M N... 100644 100644 100644 a b src/x.js\n? notes.md';
  assert.deepEqual(parseStatus(out), { branch: 'main', dirty: 2 });
  assert.deepEqual(parseStatus('# branch.oid 1a2b\n# branch.head (detached)'), { branch: 'HEAD', dirty: 0 });
  assert.deepEqual(parseStatus(null), { branch: null, dirty: 0 });
});

test('listProjects tells repos from plain folders without asking git, and reads their state', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'cleon-list-'));
  const cat = CATEGORIES?.[0] ?? 'tools';
  try {
    await mkdir(join(root, cat, 'acme'), { recursive: true });
    await mkdir(join(root, cat, 'plain'));
    await new Promise((ok, fail) => execFile('git', ['init', '-q', '-b', 'trunk', join(root, cat, 'acme')], e => (e ? fail(e) : ok())));
    await writeFile(join(root, cat, 'acme', 'a.txt'), 'a');
    await writeFile(join(root, cat, 'acme', 'b.txt'), 'b');
    const byName = Object.fromEntries((await listProjects(root)).map(p => [p.name, p]));
    assert.deepEqual([byName.acme.repo, byName.acme.branch, byName.acme.dirty, byName.acme.lastCommitAt], [true, 'trunk', 2, null]);
    assert.equal(byName.plain.repo, false);
    assert.equal(byName.plain.branch, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findProject finds a project folder by its exact path, and nothing else', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'cleon-proj-'));
  const cat = CATEGORIES?.[0] ?? 'tools'; // MC_CATEGORIES, when set, names the folders searched
  try {
    await mkdir(join(root, cat, 'acme', 'sub'), { recursive: true });
    await mkdir(join(root, cat, '.hidden'));
    await writeFile(join(root, cat, 'notes.md'), '');
    assert.deepEqual(await findProject(join(root, cat, 'acme'), root), { name: 'acme', category: cat, path: join(root, cat, 'acme') });
    for (const p of [join(root, cat), join(root, cat, 'acme', 'sub'), join(root, cat, '.hidden'), join(root, cat, 'notes.md'),
      join(root, cat, 'missing'), `${join(root, cat, 'acme')}\\`, `${join(root, cat)}\\x\\..\\acme`]) {
      assert.equal(await findProject(p, root), null, p);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('firstParagraph skips headings, badges, notes in parentheses and code, and strips link markup', () => {
  const md = '---\ntitle: x\n---\n# Acme\n\n[![ci](b.svg)](u)\n\n(Named after a thing.)\n\n```bash\nnpm i\n```\n\nA tool that [tracks](https://x.io) *widgets*\nacross `teams`.\n\nSecond paragraph.';
  assert.equal(firstParagraph(md), 'A tool that tracks widgets across teams.');
});

test('firstParagraph skips lists, quotes and tables, and returns null when there is no prose', () => {
  assert.equal(firstParagraph('# T\n\n- a\n- b\n\n> quote\n\n| a | b |\n|---|---|'), null);
  assert.equal(firstParagraph(''), null);
});

test('firstParagraph shortens long paragraphs', () => {
  const r = firstParagraph('word '.repeat(200), 50);
  assert.ok(r.length <= 50 && r.endsWith('…'));
});
