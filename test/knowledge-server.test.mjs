import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// An acme-* tree and home folder of its own, set before the server's modules read their settings (an existing
// env var wins over .env, and static imports would load first), so nothing here reads this machine's files.
const tmp = mkdtempSync(join(os.tmpdir(), 'cleon-kms-'));
const root = join(tmp, 'dev'), proj = join(root, 'tools', 'acme-portal');
const put = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
put(join(proj, 'README.md'), '# acme portal');
put(join(proj, 'docs', 'acme-private-notes.md'), 'keep out');
put(join(proj, 'docs', 'spec.pdf'), '%PDF');
put(join(proj, 'docs', 'page.html'), '<p>acme</p><script>document.title = "ran"</script>');
put(join(proj, 'docs', 'acme-export.htm'), '<html><head><meta http-equiv=Content-Type content="text/html; charset=windows-1252"></head><p>acme</p>');
put(join(proj, 'docs', 'logo.png'), 'not really a png');
put(join(proj, 'docs', 'call.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ann Acme>Hello</v>\n');
put(join(proj, 'docs', 'brief.docx'), 'PK');
put(join(proj, 'docs', 'acme-note-2026-09-01.md'), 'first');
put(join(proj, 'docs', 'acme-note-2026-09-03.md'), 'second');
put(join(root, 'tools', 'acme-secret', 'README.md'), 'keep out');
// Indexed, then swapped for links by the last tests: to a file outside every indexed folder, or to one MC_EXCLUDE matches.
for (const d of ['acme-moved-out', 'acme-moved-ex', 'acme-moved-locked']) put(join(proj, 'docs', d, 'swapped.md'), 'as indexed');
for (const f of ['acme-swap-out.md', 'acme-swap-ex.md']) put(join(proj, 'docs', f), 'as indexed');
put(join(proj, 'docs', 'acme-kept.md'), 'still plain');
const elsewhere = join(tmp, 'elsewhere'), secret = join(root, 'tools', 'acme-secret');
put(join(elsewhere, 'swapped.md'), 'outside the root');
put(join(secret, 'swapped.md'), 'kept out by MC_EXCLUDE');
const locked = join(root, 'tools', 'acme-locked'); // MC_EXCLUDE matches this folder only, not the files in it
put(join(locked, 'swapped.md'), 'kept out by MC_EXCLUDE on its folder');
put(join(root, 'CLAUDE.md'), '# acme workspace, kept out'); // the map's centre, which MC_EXCLUDE matches below
// Claude memory stores under the temp home: the project's own, a nested folder's (holding a note of the same name), and
// one no project claims. Their folder names spell out real paths, so none may reach the page.
const memRoot = join(tmp, '.claude', 'projects'), storeOf = p => p.replace(/[^a-zA-Z0-9]/g, '-');
const stores = [storeOf(proj), storeOf(join(proj, 'docs')), 'C--acme-gone-elsewhere'];
put(join(memRoot, stores[0], 'memory', 'acme_note.md'), 'acme-portal: own store.');
put(join(memRoot, stores[1], 'memory', 'acme_note.md'), 'acme-portal: nested store.');
put(join(memRoot, stores[2], 'memory', 'acme_stray.md'), 'acme-portal: a store no project claims.');
const vault = join(tmp, 'vault');
put(join(vault, 'wiki', 'portal-login.md'), 'How acme-portal signs people in.');
put(join(vault, 'wiki', 'loose.md'), 'Names no project.');
put(join(vault, 'wiki', 'acme-private-page.md'), 'acme-portal, kept out.');
// Pages that name an excluded project (acme-secret, a project folder MC_EXCLUDE matches) in their own text.
const SYNC = 'acme-portal syncs with ACME Secret every night.';
put(join(vault, 'wiki', 'portal-sync.md'), SYNC);
put(join(proj, 'docs', 'sync-notes.md'), 'The nightly job calls acme_secret for rates.');
// Documents named after it (spellings MC_EXCLUDE misses), and another project whose own such document links to them.
const NAMED = { 'acme_secret-notes.md': 'notes body', 'acme_secret-review-2026-09-01.md': 'review one', 'acme_secret-review-2026-09-03.md': 'review two' };
for (const [f, text] of Object.entries(NAMED)) put(join(proj, 'docs', f), text);
put(join(root, 'tools', 'acme-zeta', 'docs', 'acme_secret-plan.md'),
  '[notes](../../acme-portal/docs/acme_secret-notes.md) [review](../../acme-portal/docs/acme_secret-review-2026-09-03.md)');
Object.assign(process.env, {
  MC_ROOT: root, MC_CATEGORIES: 'tools', MC_EXCLUDE: String.raw`acme-secret|acme-private|[\\/]dev[\\/]CLAUDE\.md$|[\\/]acme-locked$`, USERPROFILE: tmp, HOME: tmp, MC_VAULT: vault,
  MC_KNOWLEDGE_MATCH: '0', // set here, so a .env that turns the Haiku pass on can't start a claude run from a test
  MC_KNOWLEDGE_FOLDERS: 'docs=docs;comms=communications;outputs=outputs',
  MC_HEADLESS: '1', // so Open in default app passes every check on a real Office file, then opens nothing
});
const { server } = await import('../server.mjs');
const { fileId } = await import('../lib/knowledge.mjs');

let BASE; // the server's address
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });

test('/api/knowledge holds no excluded path', async () => {
  const r = await fetch(`${BASE}/api/knowledge`);
  assert.equal(r.status, 200);
  const body = await r.json(), json = JSON.stringify(body);
  assert.equal(body.root, root);
  assert.equal(body.tree.children[0].children[0].name, 'acme-portal');
  for (const word of ['acme-secret', 'acme-private']) assert.ok(!json.includes(word), word);
  assert.equal((await (await fetch(`${BASE}/api/knowledge?refresh=1`)).json()).tree.count, 2); // acme-portal, acme-zeta
});

test("/api/file and /api/file-info refuse the workspace CLAUDE.md's id when MC_EXCLUDE matches it", async () => {
  const centre = join(root, 'CLAUDE.md'), id = fileId(centre);
  assert.ok(new RegExp(process.env.MC_EXCLUDE, 'i').test(centre)); // the file is there, and excluded
  const { tree } = await (await fetch(`${BASE}/api/knowledge`)).json();
  assert.equal(tree.file, undefined);
  assert.ok(!JSON.stringify(tree).includes(id));
  assert.equal((await fetch(`${BASE}/api/file?id=${id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/file-info?id=${id}`)).status, 404);
});

const docsGroup = async () => (await (await fetch(`${BASE}/api/knowledge`)).json()).tree.children[0].children[0].children.find(g => g.group === 'docs');
const item = async name => (await docsGroup()).children.find(i => i.name === name);

test('/api/file serves an indexed file by id, and refuses excluded and unknown ids', async () => {
  const { tree } = await (await fetch(`${BASE}/api/knowledge`)).json();
  const docs = tree.children[0].children[0].children.find(g => g.group === 'docs');
  const readme = docs.children.find(i => i.name === 'README.md');
  const r = await fetch(`${BASE}/api/file?id=${readme.file}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '# acme portal');
  assert.equal((await fetch(`${BASE}/api/file?id=${fileId(join(proj, 'docs', 'acme-private-notes.md'))}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/file?id=${fileId(join(root, 'tools', 'acme-secret', 'README.md'))}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/file?id=f0000000000000000`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/file?id=${encodeURIComponent(join(proj, 'README.md'))}`)).status, 404);
  const pdf = await fetch(`${BASE}/api/file?id=${docs.children.find(i => i.name === 'spec.pdf').file}`);
  assert.deepEqual([pdf.status, pdf.headers.get('content-type'), pdf.headers.get('content-security-policy')], [200, 'application/pdf', 'sandbox']);
});

test('/api/file serves each type as itself: HTML in a sandbox that lets only its scripts run, everything else in a plain sandbox', async () => {
  const get = async name => fetch(`${BASE}/api/file?id=${(await item(name)).file}`);
  const html = await get('page.html');
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(html.headers.get('content-security-policy'), 'sandbox allow-scripts');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.equal(html.headers.get('content-disposition'), null);
  assert.match(await html.text(), /<script>/);
  // HTML that names its own charset (as Word and Outlook exports do) is served without one, so its own is the one read.
  assert.equal((await get('acme-export.htm')).headers.get('content-type'), 'text/html');
  const expect = {
    'README.md': ['text/markdown; charset=utf-8', null], 'call.vtt': ['text/vtt; charset=utf-8', null], 'logo.png': ['image/png', null],
    'spec.pdf': ['application/pdf', null],
    'brief.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'attachment'],
  };
  for (const [name, [type, disposition]] of Object.entries(expect)) {
    const r = await get(name);
    assert.deepEqual([r.status, r.headers.get('content-type'), r.headers.get('content-disposition')], [200, type, disposition], name);
    assert.equal(r.headers.get('content-security-policy'), 'sandbox', name);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', name);
  }
  assert.equal(Buffer.from(await (await get('logo.png')).arrayBuffer()).toString(), 'not really a png'); // the bytes as they are
});

test('an action asked for from a sandboxed file (Origin: null, even with JSON) is refused', async () => {
  const r = await fetch(`${BASE}/api/project/open`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' },
    body: JSON.stringify({ path: proj, app: 'vscode' }) });
  assert.equal(r.status, 403);
});

test('/view is the standalone viewer page, and the modules it loads are served as JavaScript', async () => {
  const r = await fetch(`${BASE}/view?id=${(await item('README.md')).file}`);
  assert.deepEqual([r.status, r.headers.get('content-type')], [200, 'text/html']);
  const page = await r.text();
  assert.match(page, /class="view-page"/);
  assert.match(page, /import \{ showFile \} from '\/viewer\.mjs'/);
  for (const path of ['/viewer.mjs', '/view-lib.mjs']) {
    const m = await fetch(`${BASE}${path}`);
    assert.deepEqual([m.status, m.headers.get('content-type')], [200, 'text/javascript'], path);
  }
});

test("the knowledge map's layout and side panel modules are served as JavaScript", async () => {
  for (const [path, fn] of [['/radial-layout.mjs', 'radialLayout'], ['/knowledge-panel.mjs', 'relatedProjects']]) {
    const m = await fetch(`${BASE}${path}`);
    assert.deepEqual([m.status, m.headers.get('content-type')], [200, 'text/javascript'], path);
    assert.match(await m.text(), new RegExp(`export function ${fn}`), path);
  }
});

test('Open in default app takes only an Office file of the index, from Cleon\'s own page, and refuses when headless', async () => {
  const open = (body, headers = {}, method = 'POST') => fetch(`${BASE}/api/file/open`, { method,
    headers: { origin: BASE, 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  const docx = (await item('brief.docx')).file;
  assert.equal((await open({ id: docx }, { origin: 'null' })).status, 403);
  assert.equal((await open({ id: docx }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await open({ id: docx }, {}, 'GET')).status, 403);
  assert.equal((await open({ id: docx }, { 'content-type': 'text/plain' })).status, 403);
  for (const id of [fileId(join(proj, 'docs', 'acme-private-notes.md')), fileId(join(root, 'tools', 'acme-secret', 'README.md')), 'f0000000000000000',
    join(proj, 'docs', 'brief.docx'), 42, undefined]) {
    const r = await open({ id });
    assert.deepEqual([r.status, (await r.json()).ok], [404, false], String(id));
  }
  // A body that isn't a JSON object is answered (400), never left hanging.
  for (const raw of ['null', 'false', '0', '""', '[]']) {
    const r = await fetch(`${BASE}/api/file/open`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: raw,
      signal: AbortSignal.timeout(3000) });
    assert.equal(r.status, 400, raw);
  }
  const html = await open({ id: (await item('page.html')).file });
  assert.deepEqual([html.status, await html.json()], [409, { ok: false, reason: 'only Office files open in their default app' }]);
  const r = await open({ id: docx });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.deepEqual([body.ok, body.headless], [false, true]);
  assert.match(body.reason, /headless/);
});

test("/api/file-info names a file and its item, with the item's versions newest first, and refuses excluded and unknown ids", async () => {
  const note = await item('acme-note');
  const info = await (await fetch(`${BASE}/api/file-info?id=${note.file}`)).json();
  assert.deepEqual({ ...info, mtime: typeof info.mtime, versions: info.versions.map(v => v.name) }, {
    id: note.file, name: 'acme-note-2026-09-03.md', ext: 'md', size: 6, mtime: 'number', item: note.id, title: 'acme-note', project: 'acme-portal',
    group: 'Docs & decisions', versions: ['acme-note-2026-09-03.md', 'acme-note-2026-09-01.md'] });
  // An older version's id names that file, in the same item (the same item id: ⧉ keeps one window per item).
  const older = await (await fetch(`${BASE}/api/file-info?id=${note.versions[1].file}`)).json();
  assert.deepEqual([older.name, older.item, older.title, older.versions.length], ['acme-note-2026-09-01.md', note.id, 'acme-note', 2]);
  const readme = await (await fetch(`${BASE}/api/file-info?id=${(await item('README.md')).file}`)).json();
  assert.deepEqual([readme.name, readme.size, readme.versions], ['README.md', 13, null]);
  for (const id of [fileId(join(proj, 'docs', 'acme-private-notes.md')), fileId(join(root, 'tools', 'acme-secret', 'README.md')), 'f0000000000000000',
    encodeURIComponent(join(proj, 'README.md')), '']) {
    const r = await fetch(`${BASE}/api/file-info?id=${id}`);
    assert.equal(r.status, 404, id);
    assert.equal(r.headers.get('content-type'), 'application/json');
  }
});

test('/api/knowledge/search finds names and text, never an excluded file, and takes any query as a phrase', async () => {
  const find = async q => { const r = await fetch(`${BASE}/api/knowledge/search?q=${encodeURIComponent(q)}`); assert.equal(r.status, 200); return r.json(); };
  const { hits } = await find('acme portal');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'README.md');
  assert.equal(hits[0].where, 'body');
  assert.deepEqual(hits[0].path, ['root', 'c:tools', `p:${proj}`, `g:${proj}#docs`, hits[0].id]);
  assert.deepEqual(hits[0].snippet, { pre: '# ', hit: 'acme portal', post: '' });
  assert.deepEqual((await find('keep out')).hits, []);
  assert.ok(!JSON.stringify(await find('acme')).match(/acme-secret|acme-private/));
  for (const q of ['(a+)+$', '[', 'a']) assert.deepEqual((await find(q)).hits, [], q);
});

test('a belt item (a vault page outside every project) is served by id, and /api/file-info says what it orbits and why', async () => {
  const { tree } = await (await fetch(`${BASE}/api/knowledge`)).json();
  const proj = tree.children[0].children[0], login = proj.belt.find(b => b.name === 'portal-login.md');
  assert.deepEqual([login.kind, login.topic], ['belt', 'vault']); // every page shares vault/wiki
  assert.equal(await (await fetch(`${BASE}/api/file?id=${login.file}`)).text(), 'How acme-portal signs people in.');
  const info = await (await fetch(`${BASE}/api/file-info?id=${login.file}`)).json();
  assert.deepEqual([info.title, info.project, info.group], ['portal-login.md', 'acme-portal', 'belt · vault']);
  assert.deepEqual(info.orbits, [{ project: 'tools/acme-portal', name: 'acme-portal', how: 'mention', why: '“How acme-portal signs people in.”' }]);
  const loose = tree.belt.find(b => b.name === 'loose.md');
  assert.deepEqual((await (await fetch(`${BASE}/api/file-info?id=${loose.file}`)).json()).orbits, []);
  // A group's item has no orbits; an excluded vault page is nowhere.
  const doc = proj.children.find(g => g.group === 'docs').children[0];
  assert.equal((await (await fetch(`${BASE}/api/file-info?id=${doc.file}`)).json()).orbits, undefined);
  assert.ok(!JSON.stringify(tree).includes('acme-private-page'));
});

test("an excluded project's name is redacted in a belt row's why and in search snippets, and the viewer shows the page as it is", async () => {
  const { tree } = await (await fetch(`${BASE}/api/knowledge`)).json();
  const sync = tree.children[0].children[0].belt.find(b => b.name === 'portal-sync.md');
  assert.equal(sync.why, '“acme-portal syncs with (excluded) every night.”');
  const info = await (await fetch(`${BASE}/api/file-info?id=${sync.file}`)).json();
  assert.deepEqual(info.orbits.map(o => o.why), [sync.why]);
  assert.equal(await (await fetch(`${BASE}/api/file?id=${sync.file}`)).text(), SYNC); // the viewer: unchanged
  const find = async q => (await (await fetch(`${BASE}/api/knowledge/search?q=${encodeURIComponent(q)}`)).json()).hits;
  assert.deepEqual(await find('syncs with'), []); // a belt page isn't searched, so it has no snippet to show
  const [hit] = await find('nightly job');
  assert.equal(hit.name, 'sync-notes.md');
  assert.deepEqual(hit.snippet, { pre: 'The ', hit: 'nightly job', post: ' calls (excluded) for rates.' });
  assert.deepEqual(await find('acme_secret'), []); // nor is the name found by text
  assert.ok(!/acme.secret/i.test(JSON.stringify(tree)));
});

test("an excluded project's name in a document's own name reaches the page nowhere: names, rels, link ends, search, file-info; files still served by id", async () => {
  const body = await (await fetch(`${BASE}/api/knowledge`)).text(), { tree, ...rest } = JSON.parse(body);
  assert.deepEqual(Object.keys(rest), ['root']); // `hidden` itself is never served
  assert.ok(!/acme.secret/i.test(body));
  const portal = tree.children[0].children.find(p => p.name === 'acme-portal'), zeta = tree.children[0].children.find(p => p.name === 'acme-zeta');
  const docs = portal.children.find(g => g.group === 'docs').children;
  const notes = docs.find(d => d.name === '(excluded)-notes.md'), review = docs.find(d => d.name === '(excluded)-review');
  assert.deepEqual([notes.rel, review.rel], ['docs/(excluded)-notes.md', 'docs/(excluded)-review-2026-09-03.md']);
  assert.deepEqual(review.versions.map(v => v.name), ['(excluded)-review-2026-09-03.md', '(excluded)-review-2026-09-01.md']);
  assert.equal(zeta.children.find(g => g.group === 'docs').children[0].name, '(excluded)-plan.md');
  // The link's ends are hidden; both linked documents still count.
  assert.deepEqual(tree.links.filter(l => l.from === 'tools/acme-zeta'),
    [{ from: 'tools/acme-zeta', to: 'tools/acme-portal', file: 'docs/(excluded)-plan.md', target: 'docs/(excluded)-notes.md', n: 2 }]);
  // Search: no name or text hit by the hidden name, and no hit shows it.
  const find = async q => (await (await fetch(`${BASE}/api/knowledge/search?q=${encodeURIComponent(q)}`)).json());
  for (const q of ['acme_secret', 'acme secret', 'acme-secret', 'secret']) assert.deepEqual((await find(q)).hits, [], q);
  for (const q of ['notes', 'review', 'plan', '(excluded)']) {
    const r = await find(q);
    assert.ok(!/acme.secret/i.test(JSON.stringify(r)), q);
  }
  assert.ok((await find('(excluded)-notes')).hits.some(h => h.id === notes.id)); // found by what the page shows
  // Every version is served by its id as written, and the viewer's info hides the name too.
  const served = [...review.versions.map(v => v.file), notes.file];
  const texts = [];
  for (const id of served) {
    const r = await fetch(`${BASE}/api/file?id=${id}`);
    assert.equal(r.status, 200);
    texts.push(await r.text());
    const info = await (await fetch(`${BASE}/api/file-info?id=${id}`)).text();
    assert.ok(!/acme.secret/i.test(info), info);
    assert.match(JSON.parse(info).name, /^\(excluded\)-/);
  }
  assert.deepEqual(texts, ['review two', 'review one', 'notes body']);
});

test("no memory store's folder name reaches the page: a note is memory/<file>, and is still served by id", async () => {
  const body = await (await fetch(`${BASE}/api/knowledge`)).text(), low = body.toLowerCase();
  for (const s of stores) assert.ok(!low.includes(s.toLowerCase()), s);
  const tree = JSON.parse(body).tree, portal = tree.children[0].children.find(p => p.name === 'acme-portal');
  const notes = portal.children.find(g => g.group === 'memory').children;
  assert.deepEqual(notes.map(n => [n.name, n.rel]), [['acme_note.md', 'memory/acme_note.md'], ['acme_note.md', 'memory/acme_note.md']]);
  assert.notEqual(notes[0].file, notes[1].file); // two stores, two notes
  const stray = portal.belt.find(b => b.name === 'acme_stray.md');
  assert.equal(stray.rel, 'memory/acme_stray.md');
  const texts = [];
  for (const id of [...notes.map(n => n.file), stray.file]) {
    const r = await fetch(`${BASE}/api/file?id=${id}`);
    assert.equal(r.status, 200);
    texts.push(await r.text());
    const info = await fetch(`${BASE}/api/file-info?id=${id}`);
    assert.equal(info.status, 200);
    const it = (await info.text()).toLowerCase();
    for (const s of stores) assert.ok(!it.includes(s.toLowerCase()), s);
  }
  assert.deepEqual(texts.sort(), ['acme-portal: a store no project claims.', 'acme-portal: nested store.', 'acme-portal: own store.']);
  for (const q of ['acme_note', 'own store']) {
    const hits = await (await fetch(`${BASE}/api/knowledge/search?q=${encodeURIComponent(q)}`)).text();
    assert.ok(JSON.parse(hits).hits.length, q);
    for (const s of stores) assert.ok(!hits.toLowerCase().includes(s.toLowerCase()), s);
  }
});

// A file swapped for a link after the index was built: every by-id read checks the path again, and answers as for an
// unknown id. These run last, since they change the fixture.
const refused = async id => {
  const open = await fetch(`${BASE}/api/file/open`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  return [(await fetch(`${BASE}/api/file?id=${id}`)).status, (await fetch(`${BASE}/api/file-info?id=${id}`)).status, open.status];
};
const kept = async () => {
  const id = (await item('acme-kept.md')).file;
  assert.equal(await (await fetch(`${BASE}/api/file?id=${id}`)).text(), 'still plain');
  assert.equal((await (await fetch(`${BASE}/api/file-info?id=${id}`)).json()).name, 'acme-kept.md');
};

test('a file whose folder became a junction after indexing is refused, whether it leads outside the root or to an excluded folder', async () => {
  const swapped = d => join(proj, 'docs', d, 'swapped.md');
  const ids = { out: fileId(swapped('acme-moved-out')), ex: fileId(swapped('acme-moved-ex')), locked: fileId(swapped('acme-moved-locked')) };
  for (const id of Object.values(ids)) assert.ok(JSON.stringify((await (await fetch(`${BASE}/api/knowledge`)).json()).tree).includes(id));
  for (const id of Object.values(ids)) assert.equal(await (await fetch(`${BASE}/api/file?id=${id}`)).text(), 'as indexed');
  // A junction needs no privilege on Windows, so this runs everywhere (elsewhere it's a plain folder link).
  for (const [d, to] of [['acme-moved-out', elsewhere], ['acme-moved-ex', secret], ['acme-moved-locked', locked]]) {
    rmSync(join(proj, 'docs', d), { recursive: true });
    symlinkSync(to, join(proj, 'docs', d), 'junction');
  }
  for (const [k, id] of Object.entries(ids)) assert.deepEqual(await refused(id), [404, 404, 404], k);
  await kept();
});

// A file that is now a link is refused before where it leads is looked at (lstat), so its two targets take one path;
// the junction test above covers the checks on where a link leads.
test('a file swapped for a file link after indexing is refused, wherever the link leads', async t => {
  const ids = { out: (await item('acme-swap-out.md')).file, ex: (await item('acme-swap-ex.md')).file };
  for (const id of Object.values(ids)) assert.equal(await (await fetch(`${BASE}/api/file?id=${id}`)).text(), 'as indexed');
  for (const [f, to] of [['acme-swap-out.md', join(elsewhere, 'swapped.md')], ['acme-swap-ex.md', join(secret, 'swapped.md')]]) {
    rmSync(join(proj, 'docs', f));
    try { symlinkSync(to, join(proj, 'docs', f), 'file'); } catch (e) {
      // Windows lets only an elevated account or Developer Mode make a file symbolic link; the junction test covers
      // the same check there.
      if (e.code === 'EPERM') return t.skip('this account may not make symbolic links to files');
      throw e;
    }
  }
  for (const [k, id] of Object.entries(ids)) assert.deepEqual(await refused(id), [404, 404, 404], k);
  await kept();
});
