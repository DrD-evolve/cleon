import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import os from 'node:os';
import { buildIndex, parseFolders, fileId, threadOf, adrStatus } from '../lib/knowledge.mjs';
import { excludePattern } from '../lib/config.mjs';

// A tmp tree of acme-* projects and Claude memory stores, built here so nothing depends on this machine or its .env.
let base, root, mem, portal, portalX, secret, billing;
const at = (y, m, d) => new Date(y, m - 1, d, 12); // noon local, so no time zone moves the day
const slug = p => p.replace(/[^a-zA-Z0-9]/g, '-'); // Claude Code's folder name for a project path
async function put(p, text = '', mtime) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
  if (mtime) await utimes(p, mtime, mtime);
}
const EXCLUDE = excludePattern('acme-secret|acme-private');
const options = extra => ({ root, categories: ['tools', 'work'], exclude: EXCLUDE, memoryRoot: mem, folders: parseFolders(null), ...extra });

before(async () => {
  base = await mkdtemp(join(os.tmpdir(), 'cleon-km-'));
  root = join(base, 'dev'); mem = join(base, 'claude-projects');
  portal = join(root, 'tools', 'acme-portal'); portalX = join(root, 'tools', 'acme-portal-x');
  secret = join(root, 'tools', 'acme-secret'); billing = join(root, 'work', 'acme-billing');
  const adrs = join(portal, 'docs', 'adrs'), comms = join(portal, 'Communications');
  await Promise.all([
    put(join(portal, 'CLAUDE.md'), '# acme'), put(join(portal, 'README.md'), '# acme'),
    put(join(portal, 'notes.md')), put(join(portal, 'src', 'index.js')), // top level, but not a project note; code
    put(join(portal, 'docs', 'guide.md'), '**Status:** not an ADR folder'),
    put(join(portal, 'docs', 'handbook.md'), '', at(2026, 9, 1)), put(join(portal, 'docs', 'handbook.html'), '', at(2026, 9, 3)),
    put(join(portal, 'docs', 'diagram.png')), put(join(portal, 'docs', 'logo.svg')), // a raster image counts; SVG can carry script
    put(join(adrs, '0001-use-acme.md'), '# ADR 1\n\n- **Status:** Accepted\n- **Date:** 2026-06-01\n'),
    put(join(adrs, '0002-cache.md'), '# ADR 2\n**Created:** 2026-06-23 · **Status:** In Progress · **Assignee:** X\n'),
    put(join(adrs, '0003-front.md'), '---\ntitle: x\nstatus: accepted\n---\n# ADR 3\n'),
    put(join(adrs, '0004-heading.md'), '# ADR 4\n\n## Status\n\nProposed\n\n## Context\n'),
    put(join(adrs, '0005-prose.md'), "# ADR 5\n\nTo change it, update only the old one's Status line.\n\n| ADR | Decision | Status |\n|---|---|---|\n"),
    put(join(portal, 'docs', 'meetings', '2026-07-01-kickoff.md')), // the nearest group folder decides: comms
    put(join(comms, 'acme-reply-2026-08-11.md')), put(join(comms, 'acme-reply-2026-08-11b.md')),
    put(join(comms, 'acme-reply-2026-08-11c.html')), put(join(comms, 'acme-reply-2026-09-08.md')),
    put(join(comms, 'call.vtt'), 'WEBVTT', at(2026, 8, 20)),
    put(join(portal, 'outputs', 'report.pdf'), '%PDF'), put(join(portal, 'outputs', 'data.xml'), '<x/>'),
    put(join(portal, 'exports', 'summary.pdf'), '%PDF'),
    put(join(portal, 'node_modules', 'pkg', 'docs', 'readme.md')), put(join(portal, '.cache', 'docs', 'cached.md')),
    put(join(portal, 'deep', '1', '2', '3', '4', '5', '6', 'docs', 'ok-deep.md')),
    put(join(portal, 'deep', '1', '2', '3', '4', '5', '6', '7', 'docs', 'too-deep.md')),
    put(join(portalX, 'README.md')),
    put(join(secret, 'README.md')), put(join(secret, 'docs', 'plan.md')),
    put(join(billing, 'docs', 'plan.md')), put(join(billing, 'docs', 'acme-private-notes.md')),
    put(join(billing, 'communications', 'acme-memo-2026-09-01.md')), put(join(billing, 'communications', 'acme-memo-2026-09-02-draft.md')),
    put(join(billing, 'communications', 'acme-plan-2026-09-01.md')), put(join(billing, 'communications', 'acme-plan-2026-09-01_draft.md')),
    put(join(billing, 'communications', '2026-08-17_Standup_Recap.md')), put(join(billing, 'communications', '2026-08-24_Standup_Recap.md')),
    put(join(mem, slug(portal), 'memory', 'feedback_one.md')), put(join(mem, slug(portal), 'memory', 'MEMORY.md')),
    put(join(portal, 'sub-repo', 'src', 'main.js')), put(join(mem, slug(join(portal, 'sub-repo')), 'memory', 'nested_note.md')),
    put(join(mem, slug(portalX), 'memory', 'sibling_note.md')),
    put(join(mem, slug(secret), 'memory', 'secret_note.md')),
    put(join(mem, slug(billing), 'memory', 'acme-private-memo.md')), put(join(mem, slug(billing), 'memory', 'billing_note.md')),
    put(join(mem, 'C--elsewhere-unclaimed', 'memory', 'stray.md')),
  ]);
});
after(() => rm(base, { recursive: true, force: true }));

const find = (n, id) => n.id === id ? n : n.children?.map(c => find(c, id)).find(Boolean) ?? null;
const group = (tree, proj, g) => find(tree, `g:${proj}#${g}`);
const names = n => n.children.map(c => c.name);

test('buildIndex: root → category → project → the four groups, each holding the right documents', async () => {
  const { tree } = await buildIndex(options());
  assert.deepEqual([tree.kind, tree.name, tree.count], ['root', 'dev', 3]);
  assert.deepEqual(tree.children.map(c => [c.id, c.kind, c.count]), [['c:tools', 'cat', 2], ['c:work', 'cat', 1]]);
  assert.deepEqual(names(find(tree, 'c:tools')), ['acme-portal', 'acme-portal-x']);
  const p = find(tree, `p:${portal}`);
  assert.deepEqual([p.kind, p.name, p.category, p.path], ['proj', 'acme-portal', 'tools', portal]);
  assert.deepEqual(p.children.map(g => [g.id, g.group, g.name]), [
    [`g:${portal}#docs`, 'docs', 'Docs & decisions'], [`g:${portal}#comms`, 'comms', 'Comms & meetings'],
    [`g:${portal}#outputs`, 'outputs', 'Outputs'], [`g:${portal}#memory`, 'memory', 'Claude memory']]);
  assert.deepEqual(names(group(tree, portal, 'docs')), ['0001-use-acme.md', '0002-cache.md', '0003-front.md', '0004-heading.md',
    '0005-prose.md', 'CLAUDE.md', 'diagram.png', 'guide.md', 'handbook', 'ok-deep.md', 'README.md']);
  // Comms newest first: a folded thread by its newest date, an undated file by its modified day.
  assert.deepEqual(names(group(tree, portal, 'comms')), ['acme-reply', 'call.vtt', '2026-07-01-kickoff.md']);
  assert.deepEqual(names(group(tree, portal, 'outputs')), ['report.pdf']);
  assert.deepEqual(names(group(tree, portal, 'memory')), ['feedback_one.md', 'nested_note.md']);
  assert.equal(p.count, 11 + 3 + 1 + 2);
  const x = find(tree, `p:${portalX}`);
  assert.deepEqual(x.children.map(g => g.count), [1, 0, 0, 1]); // empty groups are still there
  assert.deepEqual(names(group(tree, portalX, 'memory')), ['sibling_note.md']);
  const json = JSON.stringify(tree);
  for (const left of ['notes.md', 'index.js', 'logo.svg', 'data.xml', 'summary.pdf', 'node_modules', 'cached.md', 'too-deep.md', 'MEMORY.md', 'stray.md'])
    assert.ok(!json.includes(left), left);
});

test('items carry the newest file, its path in the project, type and time; ADRs carry their status', async () => {
  const { tree, files } = await buildIndex(options());
  const docs = Object.fromEntries(group(tree, portal, 'docs').children.map(i => [i.name, i]));
  const guide = docs['guide.md'];
  assert.deepEqual([guide.kind, guide.file, guide.rel, guide.ext, typeof guide.mtime], ['item', fileId(join(portal, 'docs', 'guide.md')), 'docs/guide.md', 'md', 'number']);
  assert.equal(guide.status, undefined); // a Status field outside a decisions folder isn't a status
  assert.equal(files.get(guide.file), join(portal, 'docs', 'guide.md'));
  assert.deepEqual(['0001-use-acme.md', '0002-cache.md', '0003-front.md', '0004-heading.md', '0005-prose.md'].map(n => docs[n].status),
    ['Accepted', 'In Progress', 'accepted', 'Proposed', undefined]);
  assert.equal(docs['0001-use-acme.md'].rel, 'docs/adrs/0001-use-acme.md');
  // Undated versions go by the day they were modified.
  assert.deepEqual(docs.handbook.versions.map(v => v.name), ['handbook.html', 'handbook.md']);
  assert.equal(docs.handbook.ext, 'html');
});

test('adrStatus reads each way a status is written, and not prose or a table header', () => {
  assert.equal(adrStatus('# T\n\n- **Status:** Accepted'), 'Accepted');
  assert.equal(adrStatus('**Status:** Proposed'), 'Proposed');
  assert.equal(adrStatus('**Status**: Superseded by [ADR-2](0002.md)'), 'Superseded by ADR-2');
  assert.equal(adrStatus('**Created:** 2026-06-23 · **Status:** In Progress · **Assignee:** X'), 'In Progress');
  assert.equal(adrStatus('---\nstatus: "accepted"\n---'), 'accepted');
  assert.equal(adrStatus('# T\n\n## Status\n\nAccepted\n'), 'Accepted');
  assert.equal(adrStatus("Update only the old one's Status line.\n\n| ADR | Decision | Status |"), null);
  assert.equal(adrStatus(`${'line\n'.repeat(40)}Status: Accepted`), null); // only the first 40 lines
  assert.equal(adrStatus(`Status: ${'x'.repeat(60)}`).length, 40);
  assert.equal(adrStatus(''), null);
});

test('dated versions of one document fold into one thread, newest first', async () => {
  const { tree, files } = await buildIndex(options());
  const reply = group(tree, portal, 'comms').children.find(i => i.name === 'acme-reply');
  const comms = join(portal, 'Communications');
  assert.equal(reply.file, fileId(join(comms, 'acme-reply-2026-09-08.md')));
  assert.equal(reply.rel, 'Communications/acme-reply-2026-09-08.md');
  assert.deepEqual(reply.versions.map(v => v.name), ['acme-reply-2026-09-08.md', 'acme-reply-2026-08-11c.html', 'acme-reply-2026-08-11b.md', 'acme-reply-2026-08-11.md']);
  for (const v of reply.versions) assert.equal(files.get(v.file), join(comms, v.name)); // every version can be opened
  assert.equal(reply.draft, undefined);
  const billingComms = Object.fromEntries(group(tree, billing, 'comms').children.map(i => [i.name, i]));
  assert.deepEqual(Object.keys(billingComms).sort(), ['Standup_Recap', 'acme-memo', 'acme-plan']);
  // A later draft is the newest version, marked draft; on the same day the final outranks it.
  assert.equal(billingComms['acme-memo'].draft, true);
  assert.deepEqual(billingComms['acme-memo'].versions.map(v => [v.name, v.draft ?? false]), [['acme-memo-2026-09-02-draft.md', true], ['acme-memo-2026-09-01.md', false]]);
  assert.equal(billingComms['acme-plan'].draft, undefined);
  assert.equal(billingComms['acme-plan'].versions[0].name, 'acme-plan-2026-09-01.md');
  assert.equal(billingComms.Standup_Recap.versions.length, 2);
});

test('threadOf: what is left of a name once its date, day letter, draft marker and text type are set aside', () => {
  assert.deepEqual(threadOf('acme-reply-2026-08-11b.md'), { key: 'acme-reply.doc', rest: 'acme-reply', date: '2026-08-11', suffix: 'b', draft: false });
  assert.equal(threadOf('acme-reply-2026-08-11c.html').key, 'acme-reply.doc');
  assert.deepEqual(threadOf('2026-08-17_AI_Standup_Recap.md'), { key: 'ai_standup_recap.doc', rest: 'AI_Standup_Recap', date: '2026-08-17', suffix: '', draft: false });
  assert.equal(threadOf('acme-plan-2026-09-01_DRAFT.md').draft, true);
  assert.equal(threadOf('acme-plan-2026-09-01_DRAFT.md').key, 'acme-plan.doc');
  assert.equal(threadOf('drafting-notes.md').draft, false);
  assert.equal(threadOf('acme-2026-08-11.pdf').key, 'acme.pdf'); // other types fold only with their own type
  assert.equal(threadOf('2026-08-11.md').key, '=2026-08-11.md'); // nothing left: folds with nothing
  assert.equal(threadOf('report-2026-08-11bx.md').suffix, ''); // a word after the date isn't a day letter
});

test('MC_EXCLUDE keeps a project, a file and a memory store out of the tree and the file index', async () => {
  const { tree, files } = await buildIndex(options());
  const json = JSON.stringify(tree);
  for (const word of ['acme-secret', 'acme-private', 'secret_note']) assert.ok(!json.includes(word), word);
  for (const p of files.values()) assert.ok(!EXCLUDE.test(p), p);
  assert.ok(![...files.values()].some(p => p.startsWith(secret)));
  assert.deepEqual(names(group(tree, billing, 'docs')), ['plan.md']);
  assert.deepEqual(names(group(tree, billing, 'memory')), ['billing_note.md']);
  assert.ok(!files.has(fileId(join(billing, 'docs', 'acme-private-notes.md'))));
});

test('a memory store counts toward a project only for a folder that is there in it, and not when MC_EXCLUDE matches that folder', async () => {
  const proj = join(root, 'extra', 'acme-vault'), opts = extra => options({ categories: ['extra'], ...extra });
  await Promise.all([
    put(join(proj, 'README.md')), put(join(proj, 'tool.v2', 'main.js')), put(join(proj, 'keys', 'list.txt')),
    put(join(mem, slug(proj), 'memory', 'own_note.md')),
    put(join(mem, slug(join(proj, 'tool.v2')), 'memory', 'tool_note.md')), // a nested folder, slug "tool-v2"
    put(join(mem, slug(join(proj, 'keys')), 'memory', 'keys_note.md')),
    put(join(mem, slug(join(root, 'extra', 'acme-vault-old')), 'memory', 'old_note.md')), // a sibling since deleted
    put(join(mem, slug(join(proj, 'gone')), 'memory', 'gone_note.md')), // a nested folder since deleted
  ]);
  const all = await buildIndex(opts());
  assert.deepEqual(names(group(all.tree, proj, 'memory')), ['keys_note.md', 'own_note.md', 'tool_note.md']);
  // A pattern written for the folder's path ("\" or "/") doesn't match the store's name, which has "-" there.
  const KEYS = excludePattern(String.raw`acme-vault[\\/]keys`);
  assert.ok(!KEYS.test(join(mem, slug(join(proj, 'keys')), 'memory', 'keys_note.md')));
  const { tree, files } = await buildIndex(opts({ exclude: KEYS }));
  assert.deepEqual(names(group(tree, proj, 'memory')), ['own_note.md', 'tool_note.md']);
  assert.ok(!JSON.stringify(tree).includes('keys_note'));
  assert.ok(![...files.values()].some(p => p.includes('keys_note')));
});

test('ids are the same across two builds', async () => {
  const [a, b] = [await buildIndex(options()), await buildIndex(options())];
  assert.deepEqual(a.tree, b.tree);
  assert.deepEqual([...a.files], [...b.files]);
  assert.match(group(a.tree, portal, 'docs').children[0].id, /^t[0-9a-f]{16}$/);
  assert.match(fileId(join(portal, 'README.md')), /^f[0-9a-f]{16}$/);
  assert.equal(fileId(join(portal, 'README.md')), fileId(`${portal}/./README.md`));
});

test('parseFolders: a group named in MC_KNOWLEDGE_FOLDERS gets exactly its list; the others keep theirs', async () => {
  const defaults = parseFolders(null);
  assert.deepEqual(defaults, { docs: ['docs', 'adrs', 'decisions'], comms: ['communications', 'meetings', 'transcripts'], outputs: ['output', 'outputs', 'reports'] });
  assert.deepEqual(parseFolders(' comms = Mail, Calls ;bogus=x;outputs='), { ...defaults, comms: ['mail', 'calls'], outputs: [] });
  const { tree } = await buildIndex(options({ folders: parseFolders('outputs=Exports') }));
  assert.deepEqual(names(group(tree, portal, 'outputs')), ['summary.pdf']);
});

test('a group stops at 400 items and says there are more', async () => {
  const dir = join(base, 'big'), proj = join(dir, 'cat', 'acme-big');
  await Promise.all(Array.from({ length: 401 }, (_, i) => put(join(proj, 'docs', `note-${String(i).padStart(3, '0')}.md`))));
  const { tree, files } = await buildIndex({ root: dir, categories: ['cat'], exclude: EXCLUDE, memoryRoot: mem, folders: parseFolders(null) });
  const docs = group(tree, proj, 'docs');
  assert.deepEqual([docs.count, docs.more, files.size], [400, true, 400]);
  assert.equal(group(tree, proj, 'comms').more, undefined);
});

test('past 400, a group keeps its newest items, whatever order the folder lists them in', async () => {
  const dir = join(base, 'big-comms'), proj = join(dir, 'cat', 'acme-calls'), day = i => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10);
  await Promise.all(Array.from({ length: 402 }, (_, i) => put(join(proj, 'meetings', `${day(i)}_Call_${i}.md`))));
  const { tree, files } = await buildIndex({ root: dir, categories: ['cat'], exclude: EXCLUDE, memoryRoot: mem, folders: parseFolders(null) });
  const comms = group(tree, proj, 'comms');
  assert.deepEqual([comms.count, comms.more, comms.children[0].name, comms.children.at(-1).name], [400, true, `${day(401)}_Call_401.md`, `${day(2)}_Call_2.md`]);
  assert.equal(files.size, 400);
  assert.ok(!files.has(fileId(join(proj, 'meetings', `${day(0)}_Call_0.md`))));
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
