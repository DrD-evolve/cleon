import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import os from 'node:os';
import { buildIndex, parseFolders, readings } from '../lib/knowledge.mjs';
import { mdLinks, wikiLinks, memoryName, titleOf, projectNames, isPlainWord, matchItems, topicOf, commonDirs, linkEdges } from '../lib/belts.mjs';
import { excludePattern } from '../lib/config.mjs';

// A world of acme-* projects, a vault and Claude memory stores, built here so nothing depends on this machine or its .env.
let w, r, vault, mem, p, exclude;
const slug = x => x.replace(/[^a-zA-Z0-9]/g, '-'); // Claude Code's folder name for a project path
async function put(f, text = '') { await mkdir(dirname(f), { recursive: true }); await writeFile(f, text); }
const opts = extra => ({ root: r, categories: ['tools', 'work'], exclude, memoryRoot: mem, folders: parseFolders(null), vault, ...extra });
const find = (n, id) => n.id === id ? n : n.children?.map(c => find(c, id)).find(Boolean) ?? null;
const beltOf = (tree, path) => find(tree, `p:${path}`)?.belt ?? [];
const beltNames = (tree, path) => beltOf(tree, path).map(b => b.name).sort();

before(async () => {
  w = await mkdtemp(join(os.tmpdir(), 'cleon-belts-'));
  r = join(w, 'dev'); vault = join(w, 'vault'); mem = join(w, 'claude-projects');
  p = { portal: join(r, 'tools', 'acme-portal'), docs: join(r, 'tools', 'acme-docs'), hidden: join(r, 'tools', 'acme-hidden'),
    billing: join(r, 'work', 'acme-billing'), marketing: join(r, 'work', 'marketing') };
  await Promise.all([
    put(join(p.portal, 'README.md'), '# ACME Portal — the customer site\n\nThe site customers sign in to.\n'),
    put(join(p.docs, 'README.md'), '# acme-docs\n'), put(join(p.hidden, 'README.md'), '# hidden\n'),
    put(join(p.billing, 'CLAUDE.md'), '# Billing\n\nSee the [billing spec](../../../vault/wiki/billing-spec.md).\n'),
    put(join(p.marketing, 'README.md'), '# marketing\n'),
    put(join(mem, slug(p.docs), 'memory', 'own.md'), '---\nname: own\n---\nSee [[orphan-note]] for the old layout.\n'),
    put(join(vault, 'wiki', 'engineering', 'portal-notes.md'), "# Login\n\nWe changed acme-portal's login flow.\n"),
    put(join(vault, 'wiki', 'engineering', 'portal-x.md'), 'Notes on acme-portal-x, a sibling.\n'),
    put(join(vault, 'wiki', 'billing-spec.md'), '# Spec\n\nInvoices go out monthly.\n'),
    put(join(vault, 'wiki', 'both.md'), 'acme-portal and acme-billing share one login.\n'),
    put(join(vault, 'wiki', 'titled.md'), 'The customer site, ACME   Portal, moved.\n'),
    put(join(vault, 'research', 'market.md'), 'Our marketing team liked the demo.\n'),
    put(join(vault, 'research', 'campaigns.md'), 'Filed under work/marketing for now.\n'),
    put(join(vault, 'research', 'marketing-plan.md'), 'Q3 plan.\n'),
    put(join(vault, 'research', 'many.md'), 'marketing, then marketing, and more marketing.\n'),
    put(join(vault, 'research', 'unrelated.md'), 'Nothing here names a project.\n'),
    put(join(vault, 'research', 'acme-private-page.md'), 'acme-portal, but private.\n'),
    put(join(vault, '.obsidian', 'hidden.md'), 'acme-portal'),
    put(join(mem, 'C--elsewhere-unclaimed', 'memory', 'stray_portal.md'), '---\nname: stray-portal\nmetadata:\n  type: feedback\n---\nacme-portal deploys need a restart.\n'),
    put(join(mem, 'C--elsewhere-unclaimed', 'memory', 'MEMORY.md'), '- [x](stray_portal.md)'),
    put(join(mem, 'C--old-place', 'memory', 'orphan.md'), '---\nname: orphan-note\n---\nThe old layout.\n'),
    // Stores of excluded folders, under patterns written for paths: one folder since deleted, one still there.
    put(join(mem, slug(join(r, 'work', 'Some Secret')), 'memory', 'deleted_secret.md'), 'acme-portal secrets.\n'),
    put(join(mem, slug(p.hidden), 'memory', 'hidden_note.md'), 'acme-portal, hidden.\n'),
    // Outside MC_ROOT: a deleted folder, and deleted folders on a path through a link (a junction on Windows).
    put(join(mem, slug(join(w, 'outside', 'Gone Project')), 'memory', 'outside_gone.md'), 'acme-portal, gone.\n'),
    put(join(w, 'real-place', 'keep.txt')),
    put(join(mem, slug(join(w, 'linked-place', 'Gone Two')), 'memory', 'linked_gone.md'), 'acme-portal, via a link.\n'),
    put(join(mem, slug(join(w, 'linked-place', 'Gone Three')), 'memory', 'real_gone.md'), 'acme-portal, via a link, by its real path.\n'),
  ]);
  await symlink(join(w, 'real-place'), join(w, 'linked-place'), 'junction');
  exclude = excludePattern(String.raw`acme-private|work[\\/]Some Secret|tools[\\/]acme-hidden|outside[\\/]Gone Project|linked-place[\\/]Gone Two|real-place[\\/]Gone Three`);
});
after(() => rm(w, { recursive: true, force: true }));

test('a vault page that names a project orbits it, quoted; a sibling\'s name and a hidden folder don\'t count', async () => {
  const { tree, files } = await buildIndex(opts());
  assert.deepEqual(beltNames(tree, p.portal), ['both.md', 'portal-notes.md', 'stray_portal.md', 'titled.md']);
  const notes = beltOf(tree, p.portal).find(b => b.name === 'portal-notes.md');
  assert.deepEqual([notes.kind, notes.src, notes.topic, notes.rel, notes.ext], ['belt', 'vault', 'vault · wiki/engineering', 'vault/wiki/engineering/portal-notes.md', 'md']);
  assert.match(notes.why, /^“.*We changed acme-portal's login flow\..*”$/);
  assert.deepEqual(notes.orbits, [{ project: 'tools/acme-portal', name: 'acme-portal', how: 'mention', why: notes.why }]);
  assert.equal(files.get(notes.file), join(vault, 'wiki', 'engineering', 'portal-notes.md'));
  // Its README's title names it too, whatever the spacing.
  assert.match(beltOf(tree, p.portal).find(b => b.name === 'titled.md').why, /ACME Portal/);
  // A memory note in a store no project claims: its type is its topic.
  const stray = beltOf(tree, p.portal).find(b => b.name === 'stray_portal.md');
  assert.deepEqual([stray.src, stray.topic, stray.rel], ['memory', 'memory · feedback', 'C--elsewhere-unclaimed/memory/stray_portal.md']);
  const json = JSON.stringify(tree);
  for (const left of ['hidden.md', 'MEMORY.md']) assert.ok(!json.includes(left), left);
  assert.ok(tree.belt.some(b => b.name === 'portal-x.md')); // acme-portal-x doesn't name acme-portal
});

test('a page linked from a project\'s CLAUDE.md orbits that project, and so does a note [[linked]] from its memory', async () => {
  const { tree } = await buildIndex(opts());
  const spec = beltOf(tree, p.billing).find(b => b.name === 'billing-spec.md');
  assert.deepEqual(spec.orbits, [{ project: 'work/acme-billing', name: 'acme-billing', how: 'link', why: 'linked from acme-billing/CLAUDE.md' }]);
  const orphan = beltOf(tree, p.docs).find(b => b.name === 'orphan.md');
  assert.equal(orphan.orbits[0].how, 'link');
  assert.match(orphan.why, /^linked from acme-docs\/.+\/memory\/own\.md$/);
});

test('a common-word project name doesn\'t match on a single passing mention', async () => {
  const { tree } = await buildIndex(opts());
  // Named in passing, once or three times over: no. By its folder path, or in the item's file name: yes.
  assert.deepEqual(beltNames(tree, p.marketing), ['campaigns.md', 'marketing-plan.md']);
  for (const n of ['market.md', 'many.md']) assert.ok(tree.belt.some(b => b.name === n), n);
  assert.equal(beltOf(tree, p.marketing).find(b => b.name === 'marketing-plan.md').why, 'named in its file name');
  assert.match(beltOf(tree, p.marketing).find(b => b.name === 'campaigns.md').why, /work\/marketing/);
});

test('an unmatched page orbits the root; an item matching two projects is in both belts', async () => {
  const { tree, pending } = await buildIndex(opts());
  // The root's belt, by topic, then name.
  assert.deepEqual(tree.belt.map(b => [b.topic, b.name]), [['vault · research', 'many.md'], ['vault · research', 'market.md'], ['vault · research', 'unrelated.md'],
    ['vault · wiki/engineering', 'portal-x.md']]);
  for (const b of tree.belt) assert.deepEqual([b.why, b.orbits], [null, []]);
  const a = beltOf(tree, p.portal).find(b => b.name === 'both.md'), c = beltOf(tree, p.billing).find(b => b.name === 'both.md');
  assert.ok(a && c);
  assert.notEqual(a.id, c.id);
  assert.equal(a.file, c.file);
  assert.deepEqual(a.orbits.map(o => o.project), ['tools/acme-portal', 'work/acme-billing']);
  assert.deepEqual(c.orbits, a.orbits);
  // Exactly what the first pass leaves unmatched is the second pass's to ask about.
  assert.deepEqual(pending.map(x => x.rel).sort(), tree.belt.map(b => b.rel).sort());
  assert.ok(pending.every(x => /^[0-9a-f]{40}$/.test(x.hash) && typeof x.excerpt === 'string'));
});

test('MC_EXCLUDE keeps a vault page, and the stores of excluded folders (one deleted, one still there), out of belts, files and pending', async () => {
  // The patterns are written for paths, so neither store's own name matches them.
  const deleted = join(mem, slug(join(r, 'work', 'Some Secret')), 'memory', 'deleted_secret.md'), hidden = join(mem, slug(p.hidden), 'memory', 'hidden_note.md');
  for (const f of [deleted, hidden]) assert.ok(!exclude.test(f), f);
  const { tree, files, pending } = await buildIndex(opts());
  const out = JSON.stringify({ tree, pending });
  for (const word of ['acme-private', 'deleted_secret', 'hidden_note', 'acme-hidden']) assert.ok(!out.includes(word), word);
  for (const f of files.values()) assert.ok(!/acme-private|Some-Secret|deleted_secret|hidden_note/.test(f), f);
  // Without the patterns, both stores' notes would orbit acme-portal: the patterns are what keep them out.
  const open = await buildIndex(opts({ exclude: excludePattern('acme-private') }));
  assert.ok(beltNames(open.tree, p.portal).includes('deleted_secret.md'));
});

test('a cached Haiku answer places an unmatched item, with its reason, and it isn\'t asked about again', async () => {
  const first = await buildIndex(opts());
  const hash = first.pending.find(x => x.rel.endsWith('unrelated.md')).hash;
  const { tree, pending } = await buildIndex(opts({ matches: { [hash]: { at: 1, projects: ['tools/acme-docs', 'tools/gone'], why: 'about the docs site' } } }));
  const u = beltOf(tree, p.docs).find(b => b.name === 'unrelated.md');
  assert.deepEqual(u.orbits, [{ project: 'tools/acme-docs', name: 'acme-docs', how: 'haiku', why: 'Haiku: about the docs site' }]);
  assert.ok(!pending.some(x => x.hash === hash));
  assert.ok(!tree.belt.some(b => b.name === 'unrelated.md'));
  assert.deepEqual(first.projects.find(x => x.id === 'tools/acme-portal'), { id: 'tools/acme-portal', name: 'acme-portal', description: 'The site customers sign in to.' });
});

test('MC_EXCLUDE on a project\'s CLAUDE.md keeps its text out of the description the second pass is sent', async () => {
  const described = (await buildIndex(opts())).projects.find(x => x.id === 'work/acme-billing');
  assert.match(described.description, /billing spec/);
  const { projects } = await buildIndex(opts({ exclude: excludePattern(String.raw`acme-billing[\\/]CLAUDE\.md`) }));
  assert.deepEqual(projects.find(x => x.id === 'work/acme-billing'), { id: 'work/acme-billing', name: 'acme-billing', description: null });
});

test('no vault and no stray store: no belt anywhere', async () => {
  const { tree, pending } = await buildIndex(opts({ vault: null, memoryRoot: join(w, 'no-such-store') }));
  assert.equal(tree.belt, undefined);
  for (const c of tree.children) for (const pr of c.children) assert.equal(pr.belt, undefined);
  assert.deepEqual(pending, []);
});

test('MC_EXCLUDE keeps out an excluded folder\'s store beside a folder its name starts with, under an excluded folder, or past what readings can check', async () => {
  const w2 = await mkdtemp(join(os.tmpdir(), 'cleon-stray-')), r2 = join(w2, 'dev'), mem2 = join(w2, 'claude-projects');
  try {
    const store = (folder, note) => put(join(mem2, slug(join(r2, 'work', folder)), 'memory', note), 'acme notes.\n');
    await Promise.all([
      put(join(r2, 'work', 'hr', 'README.md'), '# hr\n'), store('hr-reviews', 'beside_hr.md'), // hr is there, hr-reviews is gone
      put(join(r2, 'work', 'payroll', 'reports', 'README.md'), '# reports\n'), store(join('payroll', 'reports'), 'under_payroll.md'),
      store('ACME-hr private notes 2024-q1 v2', 'long_gone.md'), // six "-" in its slug below work
      store('old-thing', 'kept.md'),
    ]);
    const o = ex => ({ root: r2, categories: ['work'], exclude: ex, memoryRoot: mem2, folders: parseFolders(null), vault: null });
    const names = ({ tree, pending, files }) => JSON.stringify({ tree, pending, files: [...files.values()] });
    const out = names(await buildIndex(o(excludePattern(String.raw`work[\\/]hr-reviews|[\\/]payroll$|ACME-hr private notes`))));
    for (const n of ['beside_hr', 'under_payroll', 'long_gone']) assert.ok(!out.includes(n), n);
    assert.ok(out.includes('kept.md'));
    // With nothing excluded, the long name isn't kept out for being unreadable.
    assert.ok(names(await buildIndex(o(excludePattern(null)))).includes('long_gone.md'));
  } finally { await rm(w2, { recursive: true, force: true }); }
});

test('readings: each way a store name\'s "-" may have been written', () => {
  assert.deepEqual(readings('Some-Secret'), ['Some-Secret', 'Some/Secret', 'Some Secret', 'Some.Secret', 'Some_Secret']);
  assert.equal(readings('a-b-c').length, 25);
  assert.deepEqual(readings('a-b-c-d-e-f-g'), ['a-b-c-d-e-f-g', 'a/b/c/d/e/f/g', 'a b c d e f g', 'a.b.c.d.e.f.g', 'a_b_c_d_e_f_g']);
  assert.deepEqual(readings('plain'), ['plain']);
});

test('mdLinks, wikiLinks and memoryName read the links and names belts match on', () => {
  const from = resolve('/x/acme/CLAUDE.md');
  assert.deepEqual(mdLinks('[a](docs/a.md) [b](../b.md#part) [web](https://e.com/c.md) [img](i.png) [sp](my%20notes.md)', from),
    [resolve('/x/acme/docs/a.md'), resolve('/x/b.md'), resolve('/x/acme/my notes.md')].map(s => s.replace(/\\/g, '/')));
  assert.deepEqual(wikiLinks('see [[one]], [[two|Two]] and [[three#part]]'), ['one', 'two', 'three']);
  assert.equal(memoryName('---\nname: acme-note\ntype: user\n---\nbody'), 'acme-note');
  assert.equal(memoryName('no front matter\nname: not this'), null);
});

test('titleOf and projectNames: a title is a name, not a subtitle or a generic heading', () => {
  assert.equal(titleOf('# ACME Portal — the customer site'), 'ACME Portal');
  assert.equal(titleOf('---\nx: 1\n---\n# Acme: tools'), 'Acme');
  for (const md of ['# CLAUDE.md — context', '# README', 'no heading', '# This heading is a whole sentence long', '## Sub only']) assert.equal(titleOf(md), null, md);
  assert.deepEqual(projectNames({ name: 'acme-portal', title: 'ACME Portal' }), ['acme-portal', 'ACME Portal']);
  assert.deepEqual(projectNames({ name: 'marketing', title: 'Marketing' }), ['marketing']);
  assert.deepEqual(projectNames({ name: 'acme-repo', title: 'Acme' }), ['acme-repo']); // a one-word title is no name
  assert.deepEqual([isPlainWord('marketing'), isPlainWord('acme-portal'), isPlainWord('ui3'), isPlainWord('Acme Team')], [true, false, false, false]);
});

test('matchItems: word boundaries, the common-word rule and links, without touching disk', () => {
  const projects = [{ id: 'tools/acme-portal', name: 'acme-portal', category: 'tools' }, { id: 'work/vendor', name: 'vendor', category: 'work' },
    { id: 'tools/acme-api', name: 'acme-api', category: 'tools', links: { paths: new Map([[resolve('/v/linked.md').replace(/\\/g, '/').toLowerCase(), 'docs/x.md']]), wiki: new Map() } }];
  const item = (name, text) => ({ path: resolve(`/v/${name}`), text });
  const out = matchItems([
    item('a.md', 'ACME-PORTAL is up.'), item('b.md', 'acme-portal2 and xacme-portal and acme-portal-old'), item('c.md', 'A Vendor report said so.'),
    item('d.md', 'vendor, Vendor, VENDOR'), item('e.md', '---\nname: x\ndescription: notes from vendor\n---\nbody'), item('linked.md', 'nothing'),
    item('f.md', 'Filed in work\\vendor.'),
  ], projects);
  // Three passing mentions of a plain word are still passing; its folder path (either slash) or its title names it.
  assert.deepEqual(out.map(o => o.map(m => `${m.project}:${m.how}`)), [['tools/acme-portal:mention'], [], [], [], ['work/vendor:mention'], ['tools/acme-api:link'], ['work/vendor:mention']]);
  assert.equal(out[5][0].why, 'linked from acme-api/docs/x.md');
});

test('topicOf and commonDirs: the clump a belt item sits in', () => {
  const common = commonDirs(['v/kb/wiki/engineering/a.md', 'v/kb/research/b.md', 'v/kb/CLAUDE.md']);
  assert.deepEqual(common, ['v', 'kb']);
  assert.equal(topicOf({ src: 'vault', rel: 'v/kb/wiki/engineering/acme-api/a.md' }, common), 'vault · wiki/engineering');
  assert.equal(topicOf({ src: 'vault', rel: 'v/kb/CLAUDE.md' }, common), 'vault');
  assert.equal(topicOf({ src: 'memory', path: '/m/project_x.md', text: 'no front matter' }), 'memory · project');
  assert.equal(topicOf({ src: 'memory', path: '/m/x.md', text: '---\ntype: Reference\n---\n' }), 'memory · reference');
  assert.equal(topicOf({ src: 'memory', path: '/m/x.md', text: '' }), 'memory · note');
  assert.deepEqual(commonDirs([]), []);
});

test('MC_EXCLUDE keeps out the store of a deleted folder outside MC_ROOT, found from the drive or / however its path is spelled', async () => {
  // The shared patterns are written for paths: one plain, one through a link, one for the link's real target. None
  // matches a store's name.
  for (const f of ['outside/Gone Project', 'linked-place/Gone Two', 'real-place/Gone Three']) assert.ok(!exclude.test(slug(join(w, f))), f);
  const { tree, files, pending } = await buildIndex(opts());
  const out = JSON.stringify({ tree, pending, files: [...files.values()] });
  for (const word of ['outside_gone', 'linked_gone', 'real_gone']) assert.ok(!out.includes(word), word);
  // Without those patterns, all three would orbit acme-portal.
  const open = await buildIndex(opts({ exclude: excludePattern('acme-private') }));
  for (const n of ['outside_gone.md', 'linked_gone.md', 'real_gone.md']) assert.ok(beltNames(open.tree, p.portal).includes(n), n);
});

test('linkEdges: one edge per ordered pair, weighted by distinct documents linked; [[name]] only when one other project has it', () => {
  const doc = (id, rel) => ({ path: `/acme/${id}/${rel}`, rel });
  const lower = rel => resolve(`/acme/${rel}`).replace(/\\/g, '/').toLowerCase();
  const projects = [
    { id: 'tools/acme-a', docs: [doc('tools/acme-a', 'README.md'), doc('tools/acme-a', 'docs/own.md')],
      links: { paths: new Map([[lower('work/acme-b/docs/one.md'), 'README.md'], [lower('work/acme-b/docs/two.md'), 'docs/own.md'],
        [lower('tools/acme-a/docs/own.md'), 'README.md'], [lower('work/acme-b/docs/none.md'), 'README.md']]),
      wiki: new Map([['one', 'docs/own.md'], ['dup', 'README.md'], ['own', 'README.md'], ['nowhere', 'README.md']]) } },
    { id: 'work/acme-b', docs: [doc('work/acme-b', 'docs/one.md'), doc('work/acme-b', 'docs/two.md'), doc('work/acme-b', 'docs/dup.md'), doc('work/acme-b', 'docs/own.md')],
      links: { paths: new Map(), wiki: new Map() } },
    { id: 'work/acme-c', docs: [doc('work/acme-c', 'dup.md')], links: { paths: new Map(), wiki: new Map() } },
  ];
  // one.md by path and by [[one]] is one document; two.md another: n 2. [[dup]] is in b and c, [[own]] is a's own.
  assert.deepEqual(linkEdges(projects), [{ from: 'tools/acme-a', to: 'work/acme-b', file: 'README.md', target: 'docs/one.md', n: 2 }]);
  assert.deepEqual(linkEdges([]), []);
});
