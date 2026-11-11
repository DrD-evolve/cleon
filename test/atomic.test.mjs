import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, utimes, rename } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { writeFileAtomic, sweepTemps } from '../lib/atomic.mjs';
import { writeGroom, readGroom } from '../lib/groom.mjs';
import { writeWaiting, readWaiting } from '../lib/waiting.mjs';
import { writeState, readState } from '../lib/scan.mjs';

const tmpDir = () => mkdtemp(join(os.tmpdir(), 'cleon-atomic-'));
const err = code => Object.assign(new Error(`${code}: busy`), { code });

test('writeFileAtomic: a write that fails partway leaves the old file whole, and no temporary file behind', async () => {
  const dir = await tmpDir(), file = join(dir, 'x.json');
  try {
    await writeFileAtomic(file, '{"v":1}');
    const half = async (p, data) => { await writeFile(p, data.slice(0, 3)); throw new Error('disk full'); };
    await assert.rejects(writeFileAtomic(file, '{"v":2,"more":true}', { writeFile: half }), /disk full/);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { v: 1 });
    assert.deepEqual(await readdir(dir), ['x.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic: a rename that is busy is tried again; any other error, or too many busy ones, is not', async () => {
  const dir = await tmpDir(), file = join(dir, 'x.json');
  try {
    let calls = 0;
    const flaky = async (a, b) => { if (++calls < 3) throw err('EPERM'); return rename(a, b); };
    await writeFileAtomic(file, '1', { rename: flaky });
    assert.equal(await readFile(file, 'utf8'), '1');
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(writeFileAtomic(file, '2', { rename: async () => { calls++; throw err('EBUSY'); } }), /EBUSY/);
    assert.equal(calls, 5);
    calls = 0;
    await assert.rejects(writeFileAtomic(file, '3', { rename: async () => { calls++; throw err('ENOSPC'); } }), /ENOSPC/);
    assert.equal(calls, 1);
    assert.equal(await readFile(file, 'utf8'), '1');
    assert.deepEqual(await readdir(dir), ['x.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic: saves at once each use their own temporary file, and the folder is made if missing', async () => {
  const dir = await tmpDir(), file = join(dir, 'sub', 'x.json');
  try {
    const names = new Set();
    const spy = async (p, d) => { names.add(p); await writeFile(p, d); };
    await Promise.all([1, 2, 3, 4].map(n => writeFileAtomic(file, JSON.stringify({ n }), { writeFile: spy })));
    assert.equal(names.size, 4);
    assert.ok([1, 2, 3, 4].includes(JSON.parse(await readFile(file, 'utf8')).n));
    assert.deepEqual(await readdir(join(dir, 'sub')), ['x.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the groom, waiting and scan state files: two saves at once both finish, with a valid file', async () => {
  const dir = await tmpDir();
  try {
    for (const [write, read, name] of [[writeGroom, readGroom, 'groom.json'], [writeWaiting, readWaiting, 'waiting.json'], [writeState, readState, 'scan.json']]) {
      const file = join(dir, name);
      const a = { v: 1, snoozed: { 'ACME-1': 1 }, items: {}, hidden: {} }, b = { v: 1, snoozed: { 'ACME-2': 2 }, items: {}, hidden: {} };
      await Promise.all([write(file, a), write(file, b)]);
      JSON.parse(await readFile(file, 'utf8'));
      await read(file);
    }
    assert.deepEqual((await readdir(dir)).sort(), ['groom.json', 'scan.json', 'waiting.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("sweepTemps removes a crash's old temporary files beside a file, and nothing else", async () => {
  const dir = await tmpDir(), file = join(dir, 'ledger.json');
  try {
    const old = join(dir, 'ledger.json.123.1.tmp'), fresh = join(dir, 'ledger.json.456.2.tmp'), other = join(dir, 'other.json.1.1.tmp');
    for (const p of [file, old, fresh, other]) await writeFile(p, 'x');
    const past = new Date(Date.now() - 10 * 60e3);
    await utimes(old, past, past);
    await utimes(other, past, past);
    await sweepTemps(file);
    assert.deepEqual((await readdir(dir)).sort(), ['ledger.json', 'ledger.json.456.2.tmp', 'other.json.1.1.tmp']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
