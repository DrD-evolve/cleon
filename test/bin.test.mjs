import { test } from 'node:test';
import assert from 'node:assert/strict';
import dc from 'node:diagnostics_channel';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from '../lib/bin.mjs';

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

// The guard: the page's pollers start herdr and git many times a minute, so none of them may go back to
// node:child_process, which holds the server up while each program starts. A tripwire for the usual way
// back (a literal 'git' or 'herdr' handed to node's execFile or spawn), not a proof: an alias or a name
// held in a variable gets past it. open.mjs's detached `herdr server` is started once, not polled.
test('herdr and git are started through lib/bin.mjs, never node:child_process directly', async () => {
  const files = ['server.mjs', ...(await readdir(join(ROOT, 'lib'), { recursive: true }))
    .map(f => `lib/${f.replaceAll('\\', '/')}`).filter(f => f.endsWith('.mjs') && f !== 'lib/bin.mjs')];
  const offenders = [];
  for (const f of files) {
    const src = await readFile(join(ROOT, f), 'utf8');
    if (!/from\s*['"]node:child_process['"]/.test(src)) continue;
    const starts = src.match(/\b(execFile|spawn|exec)(Sync)?\(\s*['"](git|herdr)['"][^\n]*/g) ?? [];
    if (starts.some(s => !(f === 'lib/open.mjs' && /'server'/.test(s)))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
