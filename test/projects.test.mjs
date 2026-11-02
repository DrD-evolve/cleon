import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstParagraph } from '../lib/projects.mjs';

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
