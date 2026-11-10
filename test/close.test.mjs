import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closable, sameProcess, closer, reopenLine, readReopen, writeReopen, notRunning } from '../lib/close.mjs';

const START = '134387216091319326';
const sess = (o = {}) => ({ id: 'acme-1', pid: 101, procStart: START, name: 'acme one', cwd: 'C:\\work\\acme-one',
  status: 'idle', alive: true, entrypoint: 'cli', ...o });
const settle = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 50 && !fn(); i++) await settle(); }

test('closable: this machine, running, not excluded; a VS Code extension session is listed but marked', () => {
  const rows = closable([
    sess(),
    sess({ id: 'peer', machine: 'worker' }),
    sess({ id: 'dead', alive: false }),
    sess({ id: 'hidden', cwd: 'C:\\work\\acme-secret' }),
    sess({ id: 'nopid', pid: undefined }),
    sess({ id: 'ext', entrypoint: 'claude-vscode' }),
  ], /acme-secret/i);
  assert.deepEqual(rows.map(r => [r.id, r.where]), [['acme-1', null], ['ext', 'vscode']]);
});

test('sameProcess: claude started when the session file says; a reused pid is not', () => {
  const s = sess();
  assert.equal(sameProcess(s, { name: 'claude.exe', start: '134387216091319320' }), true); // CIM's microseconds
  assert.equal(sameProcess(s, { name: 'notepad.exe', start: START }), false); // pid reused by another program
  assert.equal(sameProcess(s, { name: 'claude.exe', start: '134387216191319326' }), false); // another claude, 10 s later
  assert.equal(sameProcess(s, null), false);
  assert.equal(sameProcess(sess({ procStart: undefined }), { name: 'claude.exe', start: START }), false);
});

function rig(sessions, { info } = {}) {
  const calls = { kill: [], saved: [], order: [] };
  let timerFn = null;
  const alive = new Map(sessions.map(s => [s.pid, true]));
  const c = closer({
    list: async () => sessions.map(s => ({ ...s, alive: s.alive !== false && alive.get(s.pid) })),
    exclude: /(?!)/,
    save: async rows => { calls.saved.push(rows); calls.order.push('save'); },
    info: info ?? (async pid => (alive.get(pid) ? { name: 'claude.exe', start: sessions.find(s => s.pid === pid).procStart } : null)),
    kill: async pid => { calls.kill.push(pid); calls.order.push(`kill ${pid}`); alive.set(pid, false); return { ok: true }; },
    setTimer: fn => { timerFn = fn; return 1; },
  });
  return { c, calls, tick: async () => { const f = timerFn; timerFn = null; await f?.(); }, pending: () => Boolean(timerFn) };
}

test('an idle session ends at once, after the reopen list is saved', async () => {
  const { c, calls } = rig([sess()]);
  assert.deepEqual(await c.start(['acme-1']), { ok: true });
  await until(() => c.state()[0].state === 'closed');
  assert.deepEqual(c.state().map(r => r.state), ['closed']);
  assert.deepEqual(calls.order, ['save', 'kill 101']);
  assert.deepEqual(calls.saved, [[{ name: 'acme one', id: 'acme-1', cwd: 'C:\\work\\acme-one' }]]);
});

test('a reused pid is never ended: the session is marked failed', async () => {
  const { c, calls } = rig([sess()], { info: async () => ({ name: 'notepad.exe', start: START }) });
  await c.start(['acme-1']);
  await until(() => c.state()[0].state !== 'closing' && c.state()[0].state !== 'waiting');
  assert.equal(c.state()[0].state, 'failed');
  assert.match(c.state()[0].reason, /another process/);
  assert.deepEqual(calls.kill, []);
});

test('a busy session waits until its file says idle, then ends; any other status counts as busy', async () => {
  const s = sess({ status: 'busy' });
  const { c, calls, tick, pending } = rig([s]);
  await c.start(['acme-1']);
  assert.equal(c.state()[0].state, 'waiting');
  assert.ok(pending());
  s.status = 'shell';
  await tick();
  assert.equal(c.state()[0].state, 'waiting');
  assert.deepEqual(calls.kill, []);
  s.status = 'idle';
  await tick();
  assert.equal(c.state()[0].state, 'closed');
  assert.deepEqual(calls.kill, [101]);
  assert.equal(pending(), false); // nothing left to wait for
});

test('Close now ends a waiting session without waiting for idle', async () => {
  const { c, calls } = rig([sess({ status: 'busy' })]);
  await c.start(['acme-1']);
  assert.equal(c.now('nope').ok, false);
  assert.deepEqual(c.now('acme-1'), { ok: true });
  await until(() => c.state()[0].state === 'closed');
  assert.deepEqual(calls.kill, [101]);
});

test('a waiting session that ends on its own is closed, and nothing is killed', async () => {
  const s = sess({ status: 'busy' });
  const { c, calls, tick } = rig([s]);
  await c.start(['acme-1']);
  s.alive = false;
  await tick();
  assert.equal(c.state()[0].state, 'closed');
  assert.deepEqual(calls.kill, []);
});

test('ids the page sends that are not offered here are reported, never acted on; nothing runs without any to end', async () => {
  const { c, calls } = rig([sess(), sess({ id: 'ext', pid: 202, entrypoint: 'claude-vscode' })]);
  assert.equal((await c.start(['made-up', 'ext'])).ok, false);
  assert.deepEqual(calls.saved, []);
  await c.start(['acme-1', 'made-up', 'ext']);
  await until(() => c.state()[0].state === 'closed');
  assert.deepEqual(c.state().map(r => [r.id, r.state, r.reason]), [['acme-1', 'closed', null],
    ['made-up', 'failed', 'not a running session on this machine'], ['ext', 'failed', 'close it in VS Code']]);
  assert.deepEqual(calls.kill, [101]);
});

test('nothing ends when the reopen list cannot be saved, and a second close waits for the first', async () => {
  const kills = [];
  const c = closer({ list: async () => [sess()], exclude: /(?!)/, save: async () => { throw new Error('disk full'); },
    info: async () => ({ name: 'claude.exe', start: START }), kill: async pid => { kills.push(pid); return { ok: true }; }, setTimer: () => 1 });
  assert.match((await c.start(['acme-1'])).reason, /reopen list could not be saved/);
  assert.deepEqual(kills, []);
  const busy = rig([sess({ status: 'busy' })]).c;
  await busy.start(['acme-1']);
  assert.match((await busy.start(['acme-1'])).reason, /still running/);
});

test('the reopen list survives a restart, with a line for each session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acme-close-'));
  try {
    const file = join(dir, 'data', 'closed-sessions-1.json');
    assert.equal(await readReopen(file), null);
    await writeReopen(file, [{ name: 'acme one', id: 'acme-1', cwd: 'C:\\work\\acme one' }], 5);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).at, 5);
    assert.deepEqual((await readReopen(file)).sessions.map(s => s.line), ["cd 'C:\\work\\acme one' && claude --resume acme-1"]);
    assert.equal(reopenLine({ cwd: 'C:/x', id: 'y' }), "cd 'C:/x' && claude --resume y");
    assert.equal(reopenLine({ cwd: "C:/a$(b)`c`'d", id: 'y' }), "cd 'C:/a$(b)`c`'\\''d' && claude --resume y"); // nothing expands in bash
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a later close adds to the reopen list, and a session still running is not offered as closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acme-close-'));
  try {
    const file = join(dir, 'closed-sessions-1.json');
    const row = id => ({ name: id, id, cwd: `C:\work\${id}` });
    await writeReopen(file, [row('acme-1'), row('acme-2')], 5);
    await writeReopen(file, [row('acme-3'), row('acme-1')], 6); // acme-1 closed again: listed once, newest first
    const r = await readReopen(file);
    assert.equal(r.at, 6);
    assert.deepEqual(r.sessions.map(s => s.id), ['acme-3', 'acme-1', 'acme-2']);
    // acme-3's close failed (or it was reopened): it is still running, so no reopen line
    assert.deepEqual(notRunning(r, [sess({ id: 'acme-3' })]).sessions.map(s => s.id), ['acme-1', 'acme-2']);
    assert.equal(notRunning(null, []), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a second close sent while the first is still saving is refused, not interleaved', async () => {
  let release;
  const saved = [], kills = [];
  const c = closer({ list: async () => [sess(), sess({ id: 'acme-2', pid: 102 })], exclude: /(?!)/,
    save: rows => { saved.push(rows.map(r => r.id)); return new Promise(r => { release = r; }); },
    info: async () => null, kill: async pid => { kills.push(pid); return { ok: true }; }, setTimer: () => 1 });
  const first = c.start(['acme-1']);
  await until(() => release);
  assert.match((await c.start(['acme-2'])).reason, /still running/);
  release();
  assert.equal((await first).ok, true);
  assert.deepEqual(saved, [['acme-1']]);
});
