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

// The guard: the page's pollers start herdr and git many times a minute, so none of them may go back to
// node:child_process's execFile, which holds the server up while each program starts.
test('herdr and git are started through lib/bin.mjs, never node:child_process directly', async () => {
  const files = ['server.mjs', ...(await readdir(join(ROOT, 'lib'))).filter(f => f.endsWith('.mjs') && f !== 'bin.mjs').map(f => `lib/${f}`)];
  const offenders = [];
  for (const f of files) {
    const src = await readFile(join(ROOT, f), 'utf8');
    const nodeExec = /import\s*\{[^}]*\bexecFile\b[^}]*\}\s*from\s*'node:child_process'/.test(src);
    if (nodeExec && /\bexecFile\(\s*'(git|herdr)'/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
