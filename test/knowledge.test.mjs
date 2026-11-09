import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm, symlink, realpath } from 'node:fs/promises';
import { join, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { buildIndex, parseFolders, fileId, threadOf, adrStatus, stillIndexed, redactor } from '../lib/knowledge.mjs';
import { excludePattern } from '../lib/config.mjs';
import { buildText } from '../lib/search.mjs';

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
const options = extra => ({ root, categories: ['tools', 'work'], exclude: EXCLUDE, memoryRoot: mem, folders: parseFolders(null), vault: null, ...extra });

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
  for (const left of ['notes.md', 'index.js', 'logo.svg', 'data.xml', 'summary.pdf', 'node_modules', 'cached.md', 'too-deep.md', 'MEMORY.md'])
    assert.ok(!json.includes(left), left);
  // A note in a store no project claims is in no group: it orbits the root, since nothing names it.
  assert.ok(!JSON.stringify(tree.children).includes('stray.md'));
  assert.deepEqual(tree.belt.map(b => b.name), ['stray.md']);
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

test("the workspace's own CLAUDE.md is the root's file, in the file index, unless it isn't there or MC_EXCLUDE matches it", async () => {
  const ws = join(base, 'acme-ws'), centre = join(ws, 'CLAUDE.md'), opts = extra => options({ root: ws, categories: ['tools'], ...extra });
  await put(join(ws, 'tools', 'acme-one', 'README.md'));
  const none = await buildIndex(opts());
  assert.equal(none.tree.file, undefined);
  assert.ok(!none.files.has(fileId(centre)));
  await put(centre, '# acme workspace', at(2026, 9, 2));
  const { tree, files } = await buildIndex(opts());
  assert.equal(tree.file, fileId(centre));
  assert.equal(files.get(tree.file), centre);
  assert.equal(tree.mtime, at(2026, 9, 2).getTime());
  // Matched as written, or with forward slashes (a pattern written for C:/dev/… still keeps C:\dev\CLAUDE.md out).
  for (const src of [String.raw`acme-ws[\\/]CLAUDE\.md$`, String.raw`acme-ws/CLAUDE\.md$`]) {
    const out = await buildIndex(opts({ exclude: excludePattern(src) }));
    assert.equal(out.tree.file, undefined, src);
    assert.ok(!out.files.has(fileId(centre)), src);
    assert.equal(out.tree.children[0].children[0].name, 'acme-one', src); // only the centre is left out
  }
});

test("a workspace CLAUDE.md that's a link isn't followed, so it can't lead to a file MC_EXCLUDE matches", async t => {
  const ws = join(base, 'acme-ws-link'), hidden = join(ws, 'tools', 'acme-secret', 'notes.md');
  await put(join(ws, 'tools', 'acme-one', 'README.md'));
  await put(hidden, 'kept out');
  try { await symlink(hidden, join(ws, 'CLAUDE.md'), 'file'); } catch (e) {
    if (e.code === 'EPERM') return t.skip('this account may not make symbolic links');
    throw e;
  }
  const { tree, files } = await buildIndex(options({ root: ws, categories: ['tools'] }));
  assert.equal(tree.file, undefined);
  assert.ok(![...files.values()].includes(join(ws, 'CLAUDE.md')));
  assert.ok(![...files.values()].includes(hidden));
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
  const { tree, files } = await buildIndex({ root: dir, categories: ['cat'], exclude: EXCLUDE, memoryRoot: mem, folders: parseFolders(null), vault: null });
  const docs = group(tree, proj, 'docs');
  assert.deepEqual([docs.count, docs.more, [...files.values()].filter(p => p.startsWith(proj)).length], [400, true, 400]);
  assert.equal(group(tree, proj, 'comms').more, undefined);
});

test('past 400, a group keeps its newest items, whatever order the folder lists them in', async () => {
  const dir = join(base, 'big-comms'), proj = join(dir, 'cat', 'acme-calls'), day = i => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10);
  await Promise.all(Array.from({ length: 402 }, (_, i) => put(join(proj, 'meetings', `${day(i)}_Call_${i}.md`))));
  const { tree, files } = await buildIndex({ root: dir, categories: ['cat'], exclude: EXCLUDE, memoryRoot: mem, folders: parseFolders(null), vault: null });
  const comms = group(tree, proj, 'comms');
  assert.deepEqual([comms.count, comms.more, comms.children[0].name, comms.children.at(-1).name], [400, true, `${day(401)}_Call_401.md`, `${day(2)}_Call_2.md`]);
  assert.equal([...files.values()].filter(p => p.startsWith(proj)).length, 400);
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

// Links between projects' own documents: a workspace of its own, so the other tests' fixtures stay as they are.
test("links between projects' documents: an edge per pair, naming the linking file; excluded, internal, URL, missing and root links don't count", async t => {
  const ws = join(base, 'acme-ws-links'), portalL = join(ws, 'tools', 'acme-portal'), ops = join(ws, 'tools', 'acme-ops');
  const billingL = join(ws, 'work', 'acme-billing'), hidden = join(ws, 'work', 'acme-private-area'), wsMem = join(base, 'acme-ws-links-memory');
  await Promise.all([
    put(join(ws, 'CLAUDE.md'), '# workspace'),
    put(join(portalL, 'README.md'), [
      '[plan](../../work/acme-billing/docs/plan.md#goals)', // another project's document: an edge
      '[again](../../work/acme-billing/docs/plan.md)', // the same document: still one
      '[secret](../acme-secret/docs/plan.md)', // an excluded project
      '[private](../../work/acme-billing/docs/acme-private-notes.md)', // an excluded file in an allowed project
      '[through a link](../../work/acme-billing/docs/linked/hidden.md)', // a junction into an excluded folder
      '[own](docs/guide.md)', // inside the project
      '[web](https://example.com/acme-billing/docs/plan.md)', '[gone](../../work/acme-billing/docs/missing.md)',
      '[root](../../CLAUDE.md)', '[folder](../../work/acme-billing/)', '[html](../../work/acme-billing/docs/page.html)',
    ].join('\n')),
    put(join(portalL, 'docs', 'guide.md')),
    put(join(portalL, 'docs', 'notes.md'), 'See [[runbook]], [[shared]], [[guide]] and [[docs/plan]].'),
    put(join(ops, 'docs', 'runbook.md')), put(join(ops, 'docs', 'shared.md')),
    put(join(billingL, 'README.md'), '[see](../../tools/acme-portal/docs/guide.md)'),
    put(join(billingL, 'docs', 'plan.md')), put(join(billingL, 'docs', 'shared.md')), put(join(billingL, 'docs', 'guide.md')),
    put(join(billingL, 'docs', 'acme-private-notes.md')), put(join(billingL, 'docs', 'page.html')),
    put(join(ws, 'tools', 'acme-secret', 'docs', 'plan.md')), put(join(hidden, 'hidden.md'), 'kept out'),
    // Claude memory notes are the project's own documents too, named memory/<file> rather than by their store's folder.
    put(join(wsMem, slug(ops), 'memory', 'ops_note.md'), 'See [[portal_note]].'), put(join(wsMem, slug(portalL), 'memory', 'portal_note.md')),
  ]);
  let junction = true;
  try { await symlink(hidden, join(billingL, 'docs', 'linked'), 'junction'); } catch (e) {
    if (e.code !== 'EPERM') throw e;
    junction = false;
  }
  const { tree } = await buildIndex(options({ root: ws, categories: ['tools', 'work'], memoryRoot: wsMem }));
  const edges = [...tree.links].sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  assert.deepEqual(edges, [
    { from: 'tools/acme-ops', to: 'tools/acme-portal', file: 'memory/ops_note.md', target: 'memory/portal_note.md', n: 1 },
    { from: 'tools/acme-portal', to: 'tools/acme-ops', file: 'docs/notes.md', target: 'docs/runbook.md', n: 1 }, // [[shared]] is in two: neither
    // [[docs/plan]] by its path's end, and the Markdown link: the same document, once
    { from: 'tools/acme-portal', to: 'work/acme-billing', file: 'README.md', target: 'docs/plan.md', n: 1 },
    { from: 'work/acme-billing', to: 'tools/acme-portal', file: 'README.md', target: 'docs/guide.md', n: 1 },
  ]);
  const dump = JSON.stringify(tree.links);
  for (const s of ['secret', 'private', 'hidden', 'CLAUDE', 'missing', 'page.html', 'example.com']) assert.ok(!dump.includes(s), s);
  if (!junction) t.diagnostic('no junction made: that case was not checked');
});

test('links between projects: links to two dated versions of one document count it once, named by its newest', async () => {
  const ws = join(base, 'acme-ws-versions'), a = join(ws, 'tools', 'acme-portal'), b = join(ws, 'work', 'acme-billing');
  await Promise.all([
    put(join(a, 'README.md'), '[old](../../work/acme-billing/docs/reply-2026-08-11.md) [new](../../work/acme-billing/docs/reply-2026-09-08.md)'),
    put(join(b, 'docs', 'reply-2026-08-11.md'), '# a', at(2026, 8, 11)), put(join(b, 'docs', 'reply-2026-09-08.md'), '# b', at(2026, 9, 8)),
  ]);
  const { tree } = await buildIndex(options({ root: ws, memoryRoot: join(base, 'acme-ws-versions-memory') }));
  assert.deepEqual(tree.links, [{ from: 'tools/acme-portal', to: 'work/acme-billing', file: 'README.md', target: 'docs/reply-2026-09-08.md', n: 1 }]);
});

test('links between projects: two memory stores\' notes of one name are two linked documents', async () => {
  const ws = join(base, 'acme-ws-two-stores'), a = join(ws, 'tools', 'acme-portal'), b = join(ws, 'work', 'acme-billing');
  const wsMem = join(base, 'acme-ws-two-stores-memory');
  const own = join(wsMem, slug(b), 'memory', 'acme_note.md'), nested = join(wsMem, slug(join(b, 'sub')), 'memory', 'acme_note.md');
  const fwd = p => p.replace(/\\/g, '/');
  await Promise.all([put(join(b, 'sub', 'README.md'), '# sub'), put(own, 'own'), put(nested, 'nested'),
    put(join(a, 'README.md'), `[own](${fwd(own)}) [nested](${fwd(nested)})`)]);
  const { tree } = await buildIndex(options({ root: ws, memoryRoot: wsMem }));
  assert.deepEqual(tree.links, [{ from: 'tools/acme-portal', to: 'work/acme-billing', file: 'README.md', target: 'memory/acme_note.md', n: 2 }]);
});

test("an excluded project's name in a document's own name is hidden in its name, rel, versions and link ends, not in its id", async () => {
  // MC_EXCLUDE (acme-secret) misses these spellings; the redactor reads them alike. Two notes redact to one name.
  const ws = join(base, 'acme-ws-names'), a = join(ws, 'tools', 'acme-portal'), b = join(ws, 'work', 'acme-billing');
  await Promise.all([
    put(join(ws, 'tools', 'acme-secret', 'README.md'), 'kept out'),
    put(join(a, 'docs', 'acme_secret-plan.md'), '[one](../../../work/acme-billing/docs/acme_secret.md) [two](../../../work/acme-billing/docs/acme.secret.md)'),
    put(join(b, 'docs', 'acme_secret.md'), 'one'), put(join(b, 'docs', 'acme.secret.md'), 'two'),
    put(join(b, 'docs', 'acme_secret-review-2026-09-01.md'), 'old', at(2026, 9, 1)), put(join(b, 'docs', 'acme_secret-review-2026-09-03.md'), 'new', at(2026, 9, 3)),
  ]);
  const idx = await buildIndex(options({ root: ws, memoryRoot: join(base, 'acme-ws-names-memory') }));
  assert.deepEqual(idx.hidden, ['acme-secret']);
  const docs = idx.tree.children[1].children[0].children.find(g => g.group === 'docs').children;
  assert.deepEqual(docs.map(d => [d.name, d.rel]).sort(), [['(excluded)-review', 'docs/(excluded)-review-2026-09-03.md'],
    ['(excluded).md', 'docs/(excluded).md'], ['(excluded).md', 'docs/(excluded).md']]);
  // Still two items, each its own file id over its real path.
  const notes = docs.filter(d => d.name === '(excluded).md');
  assert.notEqual(notes[0].id, notes[1].id);
  assert.deepEqual(notes.map(n => parse(idx.files.get(n.file)).base).sort(), ['acme.secret.md', 'acme_secret.md']);
  assert.deepEqual(docs.find(d => d.versions).versions.map(v => v.name), ['(excluded)-review-2026-09-03.md', '(excluded)-review-2026-09-01.md']);
  // Both notes linked: counted as two documents although their rels now read alike.
  assert.deepEqual(idx.tree.links, [{ from: 'tools/acme-portal', to: 'work/acme-billing', file: 'docs/(excluded)-plan.md', target: 'docs/(excluded).md', n: 2 }]);
  assert.ok(!/acme.secret/i.test(JSON.stringify(idx.tree)));
  const { names } = await buildText(idx, { exclude: EXCLUDE });
  assert.ok(!names.some(n => /acme.secret/i.test(n.flat)));
});

// A file of the index read again by id (stillIndexed): links buildIndex itself reads through stay readable, a swap after
// indexing doesn't. Junctions need no privilege on Windows (elsewhere they're folder links), so this runs on every runner.
test('stillIndexed serves what buildIndex read through a link, and refuses a later swap', async () => {
  const ws = join(base, 'acme-ws-still'), out = join(base, 'acme-ws-still-out'), wmem = join(base, 'acme-ws-still-memory');
  const vault = join(ws, 'knowledge', 'vault'), excl = excludePattern(String.raw`acme-secret|[\\/]acme-locked$`);
  await Promise.all([
    put(join(ws, 'tools', 'acme-portal', 'README.md'), '# portal'),
    put(join(ws, 'tools', 'acme-portal', 'docs', 'notes', 'plan.md'), 'plan'),
    put(join(ws, 'tools', 'acme-locked', 'plan.md'), 'locked'), // never indexed: MC_EXCLUDE matches its folder
    // The vault, under the root through a junction to a folder MC_EXCLUDE matches only where it really is: the index
    // reads it as written, so it stays readable.
    put(join(out, 'acme-secret-sync', 'vault', 'acme-page.md'), 'page'),
    put(join(out, 'linked', 'acme-billing', 'README.md'), '# billing'), // a listed category that's a junction
    put(join(out, 'memory', 'acme-note.md'), 'note'), // a memory store's folder that's a junction
    put(join(out, 'swapped', 'plan.md'), 'elsewhere'),
    mkdir(join(ws, 'knowledge'), { recursive: true }), mkdir(join(wmem, 'acme-stray'), { recursive: true }),
  ]);
  await symlink(join(out, 'acme-secret-sync', 'vault'), vault, 'junction');
  await symlink(join(out, 'linked'), join(ws, 'linked'), 'junction');
  await symlink(join(out, 'memory'), join(wmem, 'acme-stray', 'memory'), 'junction');
  const index = await buildIndex({ root: ws, categories: ['tools', 'linked'], exclude: excl, memoryRoot: wmem,
    folders: parseFolders(null), vault }), { files, roots } = index;
  const paths = [...files.values()], at = (...p) => paths.find(x => x === join(...p));
  const still = p => stillIndexed(p, { roots, exclude: excl });
  for (const p of [at(vault, 'acme-page.md'), at(ws, 'linked', 'acme-billing', 'README.md'), at(wmem, 'acme-stray', 'memory', 'acme-note.md'),
    at(ws, 'tools', 'acme-portal', 'docs', 'notes', 'plan.md')]) assert.equal(await still(p), true, p);
  const plan = at(ws, 'tools', 'acme-portal', 'docs', 'notes', 'plan.md'), notes = dirname(plan);
  // A folder on the way swapped for a junction into a folder MC_EXCLUDE matches only as a folder, then to one outside.
  for (const to of [join(ws, 'tools', 'acme-locked'), join(out, 'swapped')]) {
    await rm(notes, { recursive: true, force: true });
    await symlink(to, notes, 'junction');
    assert.equal(await still(plan), false, to);
  }
  // The folder the file was read from itself re-pointed: the listed category's junction now leads elsewhere.
  await rm(join(ws, 'linked'), { recursive: true, force: true });
  await put(join(out, 'other', 'acme-billing', 'README.md'), '# not billing');
  await symlink(join(out, 'other'), join(ws, 'linked'), 'junction');
  assert.equal(await still(at(ws, 'linked', 'acme-billing', 'README.md')), false);
  // Search reads text under the same check: the swapped files' text is left out, a plain file's is kept.
  const text = (await buildText(index, { exclude: excl })).docs.map(d => d.text).join('\n');
  assert.ok(text.includes('portal'));
  for (const gone of ['elsewhere', 'not billing']) assert.ok(!text.includes(gone), gone);
});

test('stillIndexed reads a root that is a whole drive', async () => {
  const self = fileURLToPath(import.meta.url), drive = parse(self).root;
  assert.equal(await stillIndexed(self, { roots: [{ dir: drive, real: await realpath(drive) }], exclude: excludePattern(null) }), true);
});

test("buildIndex names what MC_EXCLUDE kept out (hidden): an excluded project, or an excluded category but not what's in it", async () => {
  assert.deepEqual((await buildIndex(options())).hidden, ['acme-secret']);
  const { hidden } = await buildIndex(options({ exclude: excludePattern(String.raw`acme-secret|[\\/]work$`) }));
  assert.deepEqual(hidden, ['acme-secret', 'work']); // the excluded category's folder is never listed, so acme-billing isn't named
});

test("a belt row's topic hides an excluded name: a vault folder named for a project MC_EXCLUDE matches only where it is", async () => {
  const vault = join(base, 'acme-topic-vault');
  await put(join(vault, 'clients', 'acme-secret', 'a.md'), 'A page.');
  await put(join(vault, 'other', 'b.md'), 'Another.');
  const { tree, hidden } = await buildIndex(options({ vault, exclude: excludePattern(String.raw`[\\/]tools[\\/]acme-secret$`) }));
  assert.deepEqual(hidden, ['acme-secret']);
  assert.deepEqual(tree.belt.filter(b => b.src === 'vault').map(b => b.topic).sort(), ['vault · clients/(excluded)', 'vault · other']);
});

test('redactor: whole words in any case, with separators read alike; nothing else touched', () => {
  const r = redactor(['acme-secret', 'hr']);
  assert.equal(r('ACME Secret, acme_secret and Acme.Secret/notes'), '(excluded), (excluded) and (excluded)/notes');
  assert.equal(r('acme-secret-notes, acme-secretary, three hr. HR'), '(excluded)-notes, acme-secretary, three (excluded). (excluded)');
  assert.equal(redactor(['a+b(c'])('A+B(C here'), '(excluded) here'); // the name is literal, not a pattern
  assert.equal(redactor([])('acme-secret'), 'acme-secret');
  assert.equal(r(null), null);
  // A converted document's non-breaking hyphen, en dash, soft hyphen or zero-width space reads as "-".
  assert.equal(r('acme‑secret, acme–secret, acme­secret, acme​secret'), '(excluded), (excluded), (excluded), (excluded)');
  assert.deepEqual(r.spans('see acme-secret.'), [[4, 15]]);
  assert.deepEqual(redactor([]).spans('acme-secret'), []);
});

test("redactor: a shown name holding a hidden one stays whole where it's written in full, and only there", () => {
  const r = redactor(['acme-secret'], ['acme-secret-tools', 'acme-portal', 'tools', 'acme-secret']);
  assert.equal(r('acme-secret-tools-roadmap.md, ACME Secret Tools, acme-secret-toolsmith, acme_secret.md'),
    'acme-secret-tools-roadmap.md, ACME Secret Tools, (excluded)-toolsmith, (excluded).md');
  assert.deepEqual(r.spans('acme-secret-tools and acme-secret'), [[22, 33]]);
  assert.equal(redactor(['acme-secret'], ['acme-secret'])('acme-secret'), '(excluded)'); // a hidden name is never kept
});

test("an ADR's status hides an excluded name before it's cut short", () => {
  const r = redactor(['acme-secret']);
  assert.equal(adrStatus('**Status:** Superseded by acme_secret gateway', r), 'Superseded by (excluded) gateway');
  assert.equal(adrStatus('## Status\n\nReplaced by the long-named acme_secret service', r), 'Replaced by the long-named (excluded) s…');
});

test("a shown project whose name holds an excluded one keeps its name in its documents' names; ADR statuses hide it", async () => {
  const ws = join(base, 'acme-ws-own'), tools = join(ws, 'tools', 'acme-secret-tools'), portal = join(ws, 'tools', 'acme-portal');
  await Promise.all([
    put(join(ws, 'tools', 'acme-secret', 'README.md'), 'kept out'),
    put(join(tools, 'docs', 'acme-secret-tools-roadmap.md'), 'See acme-secret-tools and acme_secret.'),
    put(join(portal, 'docs', 'decisions', '0001-auth.md'), '# Auth\n\n**Status:** Superseded by acme_secret gateway\n'),
  ]);
  const exclude = excludePattern(String.raw`[\\/]acme-secret$|[\\/]acme-secret[\\/]`);
  const idx = await buildIndex(options({ root: ws, categories: ['tools'], memoryRoot: join(base, 'acme-ws-own-memory'), exclude }));
  assert.deepEqual(idx.hidden, ['acme-secret']);
  const [portalNode, toolsNode] = idx.tree.children[0].children, docsOf = n => n.children.find(g => g.group === 'docs').children;
  assert.deepEqual(docsOf(toolsNode).map(d => [d.name, d.rel]), [['acme-secret-tools-roadmap.md', 'docs/acme-secret-tools-roadmap.md']]);
  assert.equal(docsOf(portalNode)[0].status, 'Superseded by (excluded) gateway');
  const { docs } = await buildText(idx, { exclude });
  assert.ok(docs.some(d => d.text.includes('acme-secret-tools and (excluded).')));
});
