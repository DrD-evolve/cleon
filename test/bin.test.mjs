import { test } from 'node:test';
import assert from 'node:assert/strict';
import dc from 'node:diagnostics_channel';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from '../lib/bin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (file, args, opts = {}) => new Promise(resolve => execFile(file, args, opts, (err, stdout, stderr) => resolve({ err, stdout, stderr })));

test('execFile runs a program from the worker and gives back its output, as node:child_process does', async () => {
  const ok = await run('node', ['-e', 'process.stdout.write("hi"); process.stderr.write("there")'], { windowsHide: true });
  assert.equal(ok.err, null);
  assert.deepEqual([ok.stdout, ok.stderr], ['hi', 'there']);
  const no = await run('node', ['-e', 'process.exit(3)']);
  assert.equal(no.err.code, 3);
  assert.equal((await run('no-such-program-acme', [])).err.code, 'ENOENT');
  const slow = await run('node', ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 200 });
  assert.equal(slow.err.killed, true);
});

test('each program is still published to the Activity panel, with its exit or its error', async () => {
  const seen = [];
  const on = ({ process: child }) => {
    const e = { file: child.spawnfile, args: child.spawnargs.slice(1) };
    seen.push(e);
    child.once('exit', code => { e.exit = code; });
    child.once('error', err => { e.error = err.code; });
  };
  dc.subscribe('child_process', on);
  try {
    await run('node', ['-e', 'process.exit(2)']);
    await run('no-such-program-acme', ['x']);
  } finally { dc.unsubscribe('child_process', on); }
  assert.deepEqual(seen, [{ file: 'node', args: ['-e', 'process.exit(2)'], exit: 2 }, { file: 'no-such-program-acme', args: ['x'], error: 'ENOENT' }]);
});

test('a start that fails before the program runs still ends its Activity entry, as an error', async () => {
  const seen = [];
  const on = ({ process: child }) => child.once('error', err => seen.push(err.code));
  dc.subscribe('child_process', on);
  try { assert.equal((await run('node', ['a\0b'])).err.code, 'ERR_INVALID_ARG_VALUE'); } // node refuses it before starting anything
  finally { dc.unsubscribe('child_process', on); }
  assert.deepEqual(seen, ['ERR_INVALID_ARG_VALUE']);
});

test('an option that is not plain data throws, and leaves nothing keeping the process alive', async () => {
  assert.throws(() => execFile('node', ['-e', ''], { acme() {} }, () => {}), { name: 'DataCloneError' });
  const bin = new URL('../lib/bin.mjs', import.meta.url).href;
  const src = `import(${JSON.stringify(bin)}).then(m => { try { m.execFile('node', [], { acme() {} }, () => {}); } catch {} });`;
  const child = await run(process.execPath, ['--input-type=module', '-e', src], { timeout: 10_000 });
  assert.equal(child.err, null); // exited by itself, not killed by the timeout
});

test('a change to process.env after the worker started reaches the next program, as with node:child_process', async () => {
  await run('node', ['-e', '']); // the worker is running
  process.env.ACME_LATE = 'late';
  try { assert.equal((await run('node', ['-e', 'process.stdout.write(process.env.ACME_LATE ?? "")'])).stdout, 'late'); }
  finally { delete process.env.ACME_LATE; }
});

// A long-lived child, as docker events and the ssh tunnel use it: run to its end, collecting what it says.
const ran = child => new Promise(resolve => {
  const r = { out: '', err: '', events: [] };
  child.stdout.on('data', d => { r.out += d; });
  child.stderr.on('data', d => { r.err += d; });
  child.once('spawn', () => r.events.push(['spawn', typeof child.pid]));
  child.once('exit', (...a) => r.events.push(['exit', ...a]));
  child.on('error', e => r.events.push(['error', e.code]));
  child.once('close', (...a) => { r.events.push(['close', ...a]); resolve(r); });
});

test('spawn runs a program from the worker and streams its output, with its pid, exit and close', async () => {
  const r = await ran(spawn('node', ['-e', 'process.stdout.write("hi\\n"); process.stderr.write("there"); process.exit(4)'], { windowsHide: true }));
  assert.deepEqual([r.out, r.err], ['hi\n', 'there']);
  assert.deepEqual(r.events, [['spawn', 'number'], ['exit', 4, null], ['close', 4, null]]);
  const no = await ran(spawn('no-such-program-acme', [], {}));
  assert.deepEqual(no.events.filter(([e]) => e !== 'exit').map(([e, c]) => e === 'error' ? [e, c] : [e]), [['error', 'ENOENT'], ['close']]);
});

test('a spawned program can be killed, before and after its pid is known', async () => {
  const late = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  const lateDone = ran(late);
  await new Promise(r => late.once('spawn', r));
  assert.equal(late.kill(), true);
  assert.equal((await lateDone).events.at(-1)[0], 'close');
  assert.equal(late.kill(), false); // already ended
  const early = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
  const earlyDone = ran(early);
  assert.equal(early.pid, undefined);
  assert.equal(early.kill(), true); // goes to the worker, which has started it by the time it reads this
  assert.equal((await earlyDone).events.at(-1)[0], 'close');
});

test('a spawned program is published to the Activity panel too', async () => {
  const seen = [];
  const on = ({ process: child }) => child.once('exit', code => seen.push([child.spawnfile, code]));
  dc.subscribe('child_process', on);
  try { await ran(spawn('node', ['-e', 'process.exit(5)'], {})); } finally { dc.unsubscribe('child_process', on); }
  assert.deepEqual(seen, [['node', 5]]);
});

// The guard: starting a program from node:child_process holds the server up while it starts. The page's pollers
// start herdr and git many times a minute; docker (the Docker panel, and docker events whenever it restarts), ssh
// (the peer tunnel, on every reconnect) and powershell (process lookups) start on their own timers. None of them
// may go back to node:child_process. A tripwire for the usual way back (a literal name handed to node's execFile
// or spawn), not a proof: an alias or a name held in a variable gets past it. open.mjs's detached `herdr server`
// is started once, not polled. taskkill isn't covered: scan.mjs runs it from a process 'exit' handler, where a
// start posted to the worker would never happen.
test('herdr, git, docker, ssh and powershell are started through lib/bin.mjs, never node:child_process directly', async () => {
  const files = ['server.mjs', ...(await readdir(join(ROOT, 'lib'), { recursive: true }))
    .map(f => `lib/${f.replaceAll('\\', '/')}`).filter(f => f.endsWith('.mjs') && f !== 'lib/bin.mjs')];
  const offenders = [];
  for (const f of files) {
    const src = await readFile(join(ROOT, f), 'utf8');
    if (!/from\s*['"]node:child_process['"]/.test(src)) continue;
    const starts = src.match(/\b(execFile|spawn|exec)(Sync)?\(\s*['"](git|herdr|docker|ssh|powershell)(\.exe)?['"][^\n]*/g) ?? [];
    if (starts.some(s => !(f === 'lib/open.mjs' && /'server'/.test(s)))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
