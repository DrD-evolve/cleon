import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

// An acme-* tree and home folder of its own, set before the server's modules read their settings (an existing env var
// wins over .env, and static imports would load first), so nothing here reads this machine's files.
const tmp = mkdtempSync(join(os.tmpdir(), 'cleon-pts-'));
const root = join(tmp, 'dev'), proj = join(root, 'tools', 'acme-app'), KEY = 'tools/acme-app';
const put = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
put(join(proj, 'README.md'), '# acme app');
put(join(proj, 'src', 'main.mjs'), 'export const acme = 1;\n');
put(join(proj, 'src', 'deep', 'x.txt'), 'deep');
put(join(proj, 'page.html'), '<p>acme</p><script>document.title = "ran"</script>');
put(join(proj, 'logo.png'), 'not really a png');
put(join(proj, 'blob.txt'), 'a\0b');
put(join(proj, 'big.txt'), 'x'.repeat(512 * 1024 + 1));
put(join(proj, 'ok-limit.txt'), 'y'.repeat(512 * 1024));
const BLOCKED = ['.env', '.env.local', 'acme.pem', 'acme.key', 'acme.pfx', 'acme.p12', 'id_rsa', 'sheet.xlsx', 'old.xls', 'data.csv', 'REPORT.CSV'];
for (const f of BLOCKED) put(join(proj, 'secrets', f), 'top secret acme');
for (const d of ['.git', 'node_modules', '.venv', '.aws-sam']) put(join(proj, d, 'inner.txt'), 'inner');
put(join(root, 'tools', 'acme-secret', 'README.md'), 'kept out by MC_EXCLUDE');
put(join(root, 'tools', 'acme-plain', 'README.md'), 'not in git');
put(join(root, 'tools', 'acme-nogit', 'README.md'), 'not in git');
for (const d of ['acme-swapped', 'acme-moved']) put(join(proj, d, 'note.md'), 'as listed');
put(join(tmp, 'elsewhere', 'note.md'), 'outside the root');
put(join(proj, 'many', 'seed.txt'), '');
for (let i = 0; i < 2005; i++) writeFileSync(join(proj, 'many', `f${String(i).padStart(5, '0')}.txt`), '');
put(join(root, 'tools', 'acme-repo', 'tracked.txt'), 'one\n');
put(join(root, 'tools', 'acme-repo', 'clean.txt'), 'one\n');
put(join(root, 'tools', 'acme-repo', '.gitignore'), 'out/\n*.log\n');
put(join(root, 'tools', 'acme-clean', 'a.txt'), 'one\n');

Object.assign(process.env, {
  MC_ROOT: root, MC_CATEGORIES: 'tools', MC_EXCLUDE: String.raw`acme-secret`, USERPROFILE: tmp, HOME: tmp,
  MC_KNOWLEDGE_MATCH: '0', MC_HEADLESS: '1', MC_TODAY: '0',
});
const { server } = await import('../server.mjs');
const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=acme', '-c', 'user.email=acme@example.invalid', ...a], { stdio: 'pipe' });
for (const d of ['acme-repo', 'acme-clean']) {
  const dir = join(root, 'tools', d);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
}

let BASE;
before(() => new Promise(r => server.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });

const q = o => new URLSearchParams(o).toString();
const tree = (key, path = '', init) => fetch(`${BASE}/api/project/tree?${q({ key, path })}`, init);
const file = (key, path, init) => fetch(`${BASE}/api/project/file?${q({ key, path })}`, init);
const names = async (key, path) => (await (await tree(key, path)).json()).entries.map(e => e.name);

test('the tree lists one folder, dirs first, and marks the collapsed ones', async () => {
  const r = await tree(KEY);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.key, KEY);
  assert.equal(body.path, '');
  assert.equal(body.git, 'repo'); // it has a .git entry, though git can't read this one: no marks, no error
  assert.ok(body.entries.every(e => e.git === null));
  const byName = Object.fromEntries(body.entries.map(e => [e.name, e]));
  assert.ok(byName.src && !('deep' in byName), 'one folder only');
  const firstFile = body.entries.findIndex(e => e.type === 'file');
  assert.ok(body.entries.slice(0, firstFile).every(e => e.type === 'dir') && body.entries.slice(firstFile).every(e => e.type !== 'dir'));
  for (const d of ['.git', 'node_modules', '.venv', '.aws-sam']) assert.equal(byName[d].collapsed, true, d);
  assert.equal(byName.src.collapsed, undefined);
  assert.equal(byName['README.md'].size, 10);
  assert.equal(byName['README.md'].preview, 'index'); // the knowledge index holds it: previewed through /api/file
  assert.match(byName['README.md'].id, /^f[0-9a-f]{16}$/);
  assert.equal((await (await tree(KEY, 'src')).json()).entries[1].preview, 'text');
  assert.equal(byName['logo.png'].preview, 'none');
  assert.deepEqual(await names(KEY, 'src'), ['deep', 'main.mjs']);
  assert.deepEqual(await names(KEY, 'src/deep'), ['x.txt']);
});

test('the tree gives no id to a blocked file and marks it blocked', async () => {
  const body = await (await tree(KEY, 'secrets')).json();
  assert.equal(body.entries.length, BLOCKED.length);
  for (const e of body.entries) { assert.equal(e.preview, 'blocked', e.name); assert.ok(e.reason); assert.equal(e.id, undefined); }
});

test('a folder is not walked: an 8 MB file is listed by size and the answer stays small', async () => {
  put(join(proj, 'weights', 'model.txt'), '');
  writeFileSync(join(proj, 'weights', 'model.txt'), Buffer.alloc(8 * 1024 * 1024, 97));
  const text = await (await tree(KEY, 'weights')).text();
  assert.ok(text.length < 1000);
  assert.equal(JSON.parse(text).entries[0].size, 8 * 1024 * 1024);
});

test('a folder over the cap returns the first 2000 entries and counts the rest', async () => {
  const body = await (await tree(KEY, 'many')).json();
  assert.equal(body.entries.length, 2000);
  assert.equal(body.more, 6); // 2006 files with seed.txt
  assert.equal(body.entries[0].name, 'f00000.txt');
  assert.equal((await (await tree(KEY, 'src')).json()).more, 0);
});

test('an excluded project, an unknown one and a category outside MC_CATEGORIES are not found', async () => {
  for (const key of ['tools/acme-secret', 'tools/acme-nothing', 'other/acme-app']) {
    assert.equal((await tree(key)).status, 404, key);
    assert.equal((await file(key, 'README.md')).status, 404, key);
  }
});

test('keys and paths that leave the project are refused', async () => {
  for (const key of ['', 'tools', 'tools/', '../tools/acme-app', 'tools/..', 'tools/acme-app/src', 'tools\\acme-app', 'C:/acme-app', 'tools/acme-app:x', '/tools/acme-app'])
    assert.equal((await tree(key)).status, 404, key);
  for (const path of ['..', '../acme-plain', 'src/../../acme-plain', '/etc', '/', 'C:', 'C:/Windows', '..\\acme-plain', '\\\\host\\share\\x', 'src\\deep', 'README.md:stream', 'src//deep', 'src/', 'src.', 'src /x', 'nul\0']) {
    assert.equal((await tree(KEY, path)).status, 404, path);
    assert.equal((await file(KEY, path)).status, 404, path);
  }
  assert.equal((await file(KEY, 'src')).status, 404, 'a folder is not a file');
  assert.equal((await tree(KEY, 'README.md')).status, 404, 'a file is not a folder');
  assert.equal((await tree(KEY, 'missing')).status, 404);
});

test('a folder or the project folder swapped for a junction after listing is refused, for tree and preview', async t => {
  assert.deepEqual(await names(KEY, 'acme-swapped'), ['note.md']);
  assert.equal(await (await file(KEY, 'acme-swapped/note.md')).text(), 'as listed');
  rmSync(join(proj, 'acme-swapped'), { recursive: true });
  try { symlinkSync(join(tmp, 'elsewhere'), join(proj, 'acme-swapped'), 'junction'); } catch (e) { t.diagnostic(`no junction: ${e.code}`); return t.skip('cannot make a junction'); }
  assert.equal((await tree(KEY, 'acme-swapped')).status, 404);
  assert.equal((await file(KEY, 'acme-swapped/note.md')).status, 404);
  const listed = (await (await tree(KEY)).json()).entries.find(e => e.name === 'acme-swapped');
  assert.equal(listed.type, 'link');
  assert.equal(listed.preview, 'none');
  // The project folder itself, re-pointed after it was listed.
  const moved = join(root, 'tools', 'acme-plain');
  assert.deepEqual(await names('tools/acme-plain', ''), ['README.md']);
  rmSync(moved, { recursive: true });
  symlinkSync(join(tmp, 'elsewhere'), moved, 'junction');
  assert.equal((await tree('tools/acme-plain')).status, 404);
  assert.equal((await file('tools/acme-plain', 'note.md')).status, 404);
});

test('each blocked type is refused by the route, though the file is there', async () => {
  for (const f of BLOCKED) {
    const r = await file(KEY, `secrets/${f}`);
    assert.equal(r.status, 403, f);
    const body = await r.json();
    assert.equal(body.error, 'blocked');
    assert.ok(body.reason);
    assert.ok(!JSON.stringify(body).includes('top secret'), f);
  }
});

test('a text file is served as plain text in a sandbox, whatever its extension', async () => {
  const r = await file(KEY, 'page.html');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.headers.get('content-security-policy'), 'sandbox');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('content-disposition'), null);
  assert.equal(await r.text(), '<p>acme</p><script>document.title = "ran"</script>');
  assert.equal(await (await file(KEY, 'src/main.mjs')).text(), 'export const acme = 1;\n');
  assert.equal(await (await file(KEY, 'README.md')).text(), '# acme app');
});

test('a file over 512 KB, a binary one and a type off the list are refused', async () => {
  assert.equal((await file(KEY, 'big.txt')).status, 413);
  assert.equal((await file(KEY, 'ok-limit.txt')).status, 200);
  assert.equal((await file(KEY, 'blob.txt')).status, 415);
  assert.equal((await file(KEY, 'logo.png')).status, 415);
});

test('a git repo shows modified, untracked and ignored marks, and an ignored folder as one entry', async () => {
  const dir = join(root, 'tools', 'acme-repo');
  writeFileSync(join(dir, 'tracked.txt'), 'two\n');
  put(join(dir, 'new.txt'), 'new');
  put(join(dir, 'out', 'a.txt'), 'x');
  put(join(dir, 'out', 'b.txt'), 'x');
  put(join(dir, 'sub', 'u.txt'), 'x');
  put(join(dir, 'x.log'), 'x');
  const body = await (await tree('tools/acme-repo')).json();
  assert.equal(body.git, 'repo');
  const m = Object.fromEntries(body.entries.map(e => [e.name, e.git]));
  assert.equal(m['tracked.txt'], 'modified');
  assert.equal(m['new.txt'], 'untracked');
  assert.equal(m.out, 'ignored');
  assert.equal(m['x.log'], 'ignored');
  assert.equal(m['clean.txt'], null);
  assert.equal(m.sub, 'untracked');
  assert.deepEqual(body.entries.filter(e => e.name === 'out').length, 1);
  const inner = Object.fromEntries((await (await tree('tools/acme-repo', 'out')).json()).entries.map(e => [e.name, e.git]));
  assert.deepEqual(inner, { 'a.txt': 'ignored', 'b.txt': 'ignored' });
});

test('a clean repo and a folder outside git show no marks, and neither errors', async () => {
  const clean = await tree('tools/acme-clean');
  assert.equal(clean.status, 200);
  const c = await clean.json();
  assert.equal(c.git, 'repo');
  assert.ok(c.entries.filter(e => e.name !== '.git').every(e => e.git === null));
  const none = await (await tree('tools/acme-nogit')).json();
  assert.equal(none.git, 'none');
  assert.ok(none.entries.every(e => e.git === null));
});

test('the routes answer this page only, and are never forwarded to a peer', async () => {
  assert.equal((await tree(KEY, '', { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await file(KEY, 'README.md', { headers: { origin: 'null' } })).status, 403);
  assert.equal((await tree(KEY, '', { headers: { origin: 'http://example.invalid' } })).status, 403);
  assert.equal((await fetch(`${BASE}/api/project/tree?${q({ key: KEY, machine: 'nobody' })}`)).status, 200);
  const forwarded = src.match(/const FORWARDED = \{[^}]*\}|const FORWARDED_READS = new Set\([^)]*\)/g).join('\n');
  assert.ok(!forwarded.includes('/api/project/tree') && !forwarded.includes('/api/project/file'));
});
