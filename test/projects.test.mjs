import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { firstParagraph, findProject } from '../lib/projects.mjs';
import { CATEGORIES } from '../lib/config.mjs';

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
