import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { scanUsage } from '../lib/usage.mjs';

const reply = (id, ts, o) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: `r${id}`,
  message: { id: `m${id}`, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] } });
const user = (ts, content, cwd) => JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content } });

// A ledger scan over one transcript, in a temporary folder, with console.error collected.
async function withLedger(fn) {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-usage-'));
  const store = join(dir, 'ledger.json'), tdir = join(dir, 'projects', 'C--dev-repo'), file = join(tdir, 's1.jsonl');
  await mkdir(tdir, { recursive: true });
  await writeFile(file, `${user('2026-11-03T10:00:00Z', 'hi', 'C:/dev/repo')}\n${reply(1, '2026-11-03T10:01:00Z', 1000)}\n`);
  const orig = console.error, logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try { await fn({ dir, store, file, projects: join(dir, 'projects'), logged }); } finally { console.error = orig; await rm(dir, { recursive: true, force: true }); }
}

test('a ledger save that fails leaves the old ledger whole, is logged once with its reason, and is tried again', async () => {
  await withLedger(async ({ store, file, projects, logged, dir }) => {
    await scanUsage({ dir: projects, store });
    const before = await readFile(store, 'utf8');
    await appendFile(file, `${reply(2, '2026-11-03T10:02:00Z', 500)}\n`);
    const half = async (p, data) => { await writeFile(p, data.slice(0, 10)); throw new Error('disk full'); };
    await scanUsage({ dir: projects, store, io: { writeFile: half } });
    await scanUsage({ dir: projects, store, io: { writeFile: half } });
    assert.equal(await readFile(store, 'utf8'), before);
    JSON.parse(await readFile(store, 'utf8'));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /disk full/);
    await scanUsage({ dir: projects, store }); // nothing changed since, but the last save failed
    assert.notEqual(await readFile(store, 'utf8'), before);
    assert.deepEqual((await readdir(dir)).filter(n => n.endsWith('.tmp')), []);
  });
});

test('a ledger that does not parse is moved aside under a dated name, not overwritten', async () => {
  await withLedger(async ({ store, projects, logged, dir }) => {
    await writeFile(store, '{"version":4,"files":{"C--dev-gone/old.jsonl":{"offset":9');
    await scanUsage({ dir: projects, store });
    const aside = (await readdir(dir)).filter(n => /^ledger\.corrupt-\d{4}-\d{2}-\d{2}\.json$/.test(n));
    assert.equal(aside.length, 1);
    assert.ok((await readFile(join(dir, aside[0]), 'utf8')).includes('C--dev-gone'));
    assert.deepEqual(Object.keys(JSON.parse(await readFile(store, 'utf8')).files), ['C--dev-repo/s1.jsonl']);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /did not parse/);
  });
});

test("a missing ledger starts blank without comment, and a crash's old temporary file beside it is cleaned up", async () => {
  await withLedger(async ({ store, projects, logged, dir }) => {
    const stale = join(dir, 'ledger.json.1.1.tmp');
    await writeFile(stale, 'x');
    const past = new Date(Date.now() - 10 * 60e3);
    await utimes(stale, past, past);
    await scanUsage({ dir: projects, store });
    assert.deepEqual(logged, []);
    assert.deepEqual((await readdir(dir)).sort(), ['ledger.json', 'projects']);
  });
});
