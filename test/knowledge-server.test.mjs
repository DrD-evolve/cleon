import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
put(join(proj, 'docs', 'logo.png'), 'not really a png');
put(join(proj, 'docs', 'call.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ann Acme>Hello</v>\n');
put(join(proj, 'docs', 'brief.docx'), 'PK');
put(join(proj, 'docs', 'acme-note-2026-09-01.md'), 'first');
put(join(proj, 'docs', 'acme-note-2026-09-03.md'), 'second');
put(join(root, 'tools', 'acme-secret', 'README.md'), 'keep out');
Object.assign(process.env, {
  MC_ROOT: root, MC_CATEGORIES: 'tools', MC_EXCLUDE: 'acme-secret|acme-private', USERPROFILE: tmp, HOME: tmp,
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
  assert.equal((await (await fetch(`${BASE}/api/knowledge?refresh=1`)).json()).tree.count, 1);
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
