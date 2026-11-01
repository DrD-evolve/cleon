import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdLinks, wikiLinks, memoryName } from '../lib/graph.mjs';
import { excludePattern } from '../lib/config.mjs';

test('mdLinks resolves relative .md links and skips URLs', () => {
  const links = mdLinks('[a](b.md) [c](../d/e.md#x) [w](https://x.io/y.md) [img](p.png)', 'C:/v/notes/n.md');
  assert.deepEqual(links, ['C:/v/notes/b.md', 'C:/v/d/e.md']);
});

test('wikiLinks and memoryName read memory-store conventions', () => {
  assert.deepEqual(wikiLinks('see [[keep-answers-short]] and [[a|alias]]'), ['keep-answers-short', 'a']);
  assert.equal(memoryName('---\nname: keep-answers-short\n---'), 'keep-answers-short');
});

test('excludePattern: a configured pattern keeps matching paths out; unset excludes nothing', () => {
  const EXCLUDE = excludePattern(String.raw`tax[\s_-]?records|home[\s_-]?reno`);
  for (const p of ['C:/dev/Development/Tax Records/docs', 'projects/tax-records', 'project_tax_records.md',
    'C--dev-Personal-Home-Reno-Budget', 'C:/dev/Personal/Home Reno Budget/CLAUDE.md']) {
    assert.ok(EXCLUDE.test(p), p);
  }
  assert.ok(!EXCLUDE.test('C:/dev/Development/Side Project/docs'));
  assert.ok(!excludePattern(null).test('anything at all'));
  assert.ok(!excludePattern(null).test(''));
});
