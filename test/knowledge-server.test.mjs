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
put(join(root, 'tools', 'acme-secret', 'README.md'), 'keep out');
Object.assign(process.env, {
  MC_ROOT: root, MC_CATEGORIES: 'tools', MC_EXCLUDE: 'acme-secret|acme-private', USERPROFILE: tmp, HOME: tmp,
  MC_KNOWLEDGE_FOLDERS: 'docs=docs;comms=communications;outputs=outputs',
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

test('/api/file serves an indexed text file by id, and refuses excluded, unknown and non-text ids', async () => {
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
  const pdf = docs.children.find(i => i.name === 'spec.pdf');
  assert.equal((await fetch(`${BASE}/api/file?id=${pdf.file}`)).status, 415);
});
