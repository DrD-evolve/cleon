import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { buildIndex, parseFolders, fileId } from '../lib/knowledge.mjs';
import { textOf, buildText, search } from '../lib/search.mjs';
import { excludePattern } from '../lib/config.mjs';

// A tmp tree of acme-* projects, built here so nothing depends on this machine or its .env.
let base, root, portal, idx;
const at = (y, m, d) => new Date(y, m - 1, d, 12);
async function put(p, text = '', mtime) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
  if (mtime) await utimes(p, mtime, mtime);
}
const EXCLUDE = excludePattern('acme-private');
const NOTHING = excludePattern(null);
const index = exclude => buildIndex({ root, categories: ['tools'], exclude, memoryRoot: join(base, 'none'), folders: parseFolders(null), vault: null });
const HTML = `<!doctype html><html><head><title>Briefing</title>
<style>.acme-style-only { color: red }</style><script>var acmeScriptOnly = "acme script phrase";</script></head>
<body><p class="acme-attr-only" data-x='acme attr phrase'>The <b>quarterly acme</b>
rollout is on track</p><!-- acme comment phrase --><p>Use &lt;b&gt;acme bold&lt;/b&gt; here &amp; now</p></body></html>`;
const VTT = `WEBVTT

NOTE acme note phrase

1
00:00:01.000 --> 00:00:04.000
<v Pat Example>We agreed the acme cutover date</v>

2
00:00:05.000 --> 00:00:07.000 align:start
<v.loud Lee>Sounds &amp; good</v>
`;

before(async () => {
  base = await mkdtemp(join(os.tmpdir(), 'cleon-ks-'));
  root = join(base, 'dev'); portal = join(root, 'tools', 'acme-portal');
  const comms = join(portal, 'communications'), docs = join(portal, 'docs');
  await Promise.all([
    put(join(portal, 'README.md'), '# acme portal'),
    put(join(comms, 'acme-briefing.html'), HTML, at(2026, 9, 1)),
    put(join(comms, 'call.vtt'), VTT, at(2026, 9, 2)),
    put(join(comms, 'acme-recap-2026-08-17.md'), 'Notes: kickoff decisions were made', at(2026, 8, 17)),
    put(join(comms, 'acme-recap-2026-08-24.md'), 'Notes: nothing new', at(2026, 8, 24)),
    put(join(comms, 'acme-private-memo.md'), 'acme hidden phrase. The quarterly acme rollout is on track', at(2026, 10, 9)),
    put(join(docs, 'acme-rollout-plan.md'), 'the plan', at(2026, 1, 1)),
    put(join(docs, 'acme-decisions-log.md'), 'the log', at(2026, 2, 1)),
    put(join(docs, 'notes.md'), 'The rollout starts Monday', at(2026, 10, 1)),
    put(join(docs, 'patterns.md'), 'pattern (a+)+$ literal, and the acme\nbudget   review', at(2026, 6, 1)),
  ]);
  idx = await buildText(await index(EXCLUDE), { exclude: EXCLUDE });
});
after(() => rm(base, { recursive: true, force: true }));

const names = r => r.hits.map(h => h.name);

test('textOf: HTML keeps what a reader sees, VTT keeps cue text with its speaker', () => {
  const h = textOf('html', HTML);
  assert.match(h, /The quarterly acme rollout is on track/);
  assert.match(h, /Use <b>acme bold<\/b> here & now/);
  for (const hidden of ['acme-style-only', 'acmeScriptOnly', 'acme script phrase', 'acme-attr-only', 'acme attr phrase', 'acme comment phrase', 'doctype'])
    assert.ok(!h.includes(hidden), hidden);
  assert.equal(textOf('vtt', VTT), 'Pat Example: We agreed the acme cutover date Lee: Sounds & good');
  assert.equal(textOf('md', '# a\n\n  b'), '# a b');
  // A "<!--" inside a script is script text, not the start of a comment that hides the rest of the page.
  assert.equal(textOf('html', "<script>if (s.startsWith('<!--')) go()</script><p>after the script</p>"), 'after the script');
  assert.equal(textOf('html', '<!-- <script> -->shown<style>p{}'), 'shown');
  // Named entities are decoded by their exact (case-sensitive) name.
  assert.equal(textOf('html', 'Phase 1 &mdash; don&rsquo;t &rarr; &rArr; &AMP; &bogus;'), 'Phase 1 — don’t → ⇒ & &bogus;');
});

test('a phrase only in an HTML body is found, across a tag and a line break', () => {
  const r = search(idx, 'quarterly acme rollout');
  assert.deepEqual(names(r), ['acme-briefing.html']);
  assert.equal(r.hits[0].where, 'body');
  assert.equal(r.hits[0].snippet.hit, 'quarterly acme rollout');
});

test('a phrase only in a VTT cue is found', () => {
  const r = search(idx, 'ACME cutover');
  assert.deepEqual(names(r), ['call.vtt']);
  assert.equal(r.hits[0].snippet.pre, 'Pat Example: We agreed the ');
  for (const q of ['acme note phrase', '00:00:01', 'align:start']) assert.deepEqual(search(idx, q).hits, [], q);
});

test('text inside HTML tags, attributes, comments, scripts or styles is not matched', () => {
  for (const q of ['acme-style-only', 'acmeScriptOnly', 'acme script phrase', 'acme-attr-only', 'acme attr phrase', 'acme comment phrase', 'class=', 'doctype'])
    assert.deepEqual(search(idx, q).hits, [], q);
});

test('a name match ranks above a newer body match', () => {
  const r = search(idx, 'rollout');
  assert.equal(r.hits[0].name, 'acme-rollout-plan.md');
  assert.equal(r.hits[0].where, 'name');
  assert.deepEqual(r.hits.slice(1).map(h => h.where), ['body', 'body']);
  assert.deepEqual(names(r).slice(1), ['notes.md', 'acme-briefing.html']); // body hits newest first
  const proj = search(idx, 'acme-portal');
  assert.equal(proj.hits[0].kind, 'proj');
  assert.equal(proj.hits[0].category, 'tools');
});

test('a document name ranks above a group label, and both above a body match', () => {
  const r = search(idx, 'decisions');
  assert.deepEqual(r.hits.map(h => [h.kind, h.where, h.name]),
    [['item', 'name', 'acme-decisions-log.md'], ['group', 'name', 'Docs & decisions'], ['item', 'body', 'acme-recap']]);
});

test('a group is a name hit only when it has something in it, as the map opens only those', () => {
  assert.deepEqual(search(idx, 'comms & meetings').hits.map(h => h.kind), ['group']);
  for (const q of ['Claude memory', 'Outputs']) assert.deepEqual(search(idx, q).hits, [], q); // empty in this fixture
});

test('files under MC_EXCLUDE never appear, in hits or in snippets', async () => {
  assert.deepEqual(search(idx, 'acme hidden phrase').hits, []);
  assert.ok(!JSON.stringify(search(idx, 'acme')).includes('acme-private'));
  assert.ok(!JSON.stringify(search(idx, 'on track')).includes('hidden'));
  // The search index tests each path again, even one the knowledge index it's given still lists.
  const unfiltered = await buildText(await index(NOTHING), { exclude: EXCLUDE });
  assert.deepEqual(search(unfiltered, 'acme hidden phrase').hits, []);
  assert.equal(search(await buildText(await index(NOTHING), { exclude: NOTHING }), 'acme hidden phrase').hits.length, 1);
});

test('a hit carries its chain of ids from the root, and the version that matched', () => {
  const [h] = search(idx, 'kickoff decisions').hits;
  assert.equal(h.name, 'acme-recap');
  assert.deepEqual(h.path, ['root', 'c:tools', `p:${portal}`, `g:${portal}#comms`, h.id]);
  assert.equal(h.group, 'Comms & meetings');
  assert.equal(h.project, 'acme-portal');
  assert.equal(h.version, 'acme-recap-2026-08-17.md');
  assert.equal(h.file, fileId(join(portal, 'communications', 'acme-recap-2026-08-17.md')));
  const [newest] = search(idx, 'nothing new').hits;
  assert.equal(newest.version, undefined);
  assert.equal(newest.file, fileId(join(portal, 'communications', 'acme-recap-2026-08-24.md')));
});

test('the query is one literal phrase: regex characters neither throw, hang nor match as patterns', () => {
  for (const q of ['(a+)+$', '[', '.*', '\\', '?', 'a|b']) assert.doesNotThrow(() => search(idx, q), q);
  assert.deepEqual(names(search(idx, '(a+)+$')), ['patterns.md']);
  assert.deepEqual(search(idx, '.*').hits, []);
  assert.deepEqual(search(idx, '[').hits, []);
  assert.deepEqual(names(search(idx, 'acme  budget review')), ['patterns.md']); // whitespace runs are one space
});

test('snippets are plain text: entities come back decoded, for the page to show as text', () => {
  const [h] = search(idx, 'acme bold').hits;
  assert.ok(h.snippet.pre.endsWith('Use <b>'), h.snippet.pre);
  assert.ok(h.snippet.post.startsWith('</b> here & now'), h.snippet.post);
});

test('a snippet never starts, ends or cuts its match inside a surrogate pair', () => {
  const doc = text => ({ names: [], docs: [{ item: { node: { id: 'x', kind: 'item', name: 'x.md' }, path: ['root', 'x'] }, file: 'f', version: null, mtime: 0, text }] });
  const idx1 = doc(`🙂${'a'.repeat(59)}needle${'b'.repeat(59)}🙂tail`); // each emoji sits across a 60-unit context edge
  const [h] = search(idx1, 'needle').hits;
  assert.equal(h.snippet.pre, `…${'a'.repeat(59)}`);
  assert.equal(h.snippet.post, `${'b'.repeat(59)}…`);
  const [cut] = search(idx1, 'needle\ud83d').hits; // a query ending on half a pair (as the 200-character cut can leave)
  assert.equal(cut.snippet.hit, 'needle');
});

test('short and empty queries find nothing', () => {
  for (const q of ['', ' ', 'a', null, undefined]) assert.deepEqual(search(idx, q).hits, [], String(q));
});

test('name and text matches are capped apart, so names past the cap leave the text matches showing', () => {
  // "acme" names five nodes here (the project and four documents) and is in the text of three more.
  const all = search(idx, 'acme');
  assert.deepEqual([all.hits.filter(h => h.where === 'name').length, all.hits.filter(h => h.where === 'body').length], [5, 3]);
  assert.equal(all.more, false);
  assert.equal(all.moreText, false);
  const r = search(idx, 'acme', 2);
  assert.deepEqual(r.hits.map(h => h.where), ['name', 'name', 'body', 'body']);
  assert.deepEqual(r.hits.slice(2).map(h => h.name), all.hits.filter(h => h.where === 'body').slice(0, 2).map(h => h.name)); // newest first
  assert.equal(r.more, true);
  assert.equal(r.moreText, true);
  // Names over the cap and text under it: only the names are cut, and every text match shows.
  const t = search(idx, 'acme', 4);
  assert.equal(t.hits.filter(h => h.where === 'body').length, 3);
  assert.equal(t.more, true);
  assert.equal(t.moreText, false);
});
