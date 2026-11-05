import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderCandidates, raiseHerdrWindow, raiseCwdWindow, raisePidWindow, raiseHerdrAnywhere, minttyFor, raisePeerHerdr } from '../lib/vscode.mjs';

const ACME = String.raw`C:\dev\Development\Project Acme`;
const WORKTREE = String.raw`C:\wt\acme-platform-wt-ACME-145`;

test('folderCandidates tries every path\'s own folder before any parent, without the drive', () => {
  assert.deepEqual(folderCandidates([`${ACME}\\`, WORKTREE, ACME]),
    ['Project Acme', 'acme-platform-wt-ACME-145', 'Development', 'wt', 'dev']);
  assert.deepEqual(folderCandidates(['C:/dev/Development/Mission Control/public']), ['public', 'Mission Control', 'Development', 'dev']);
});

test('raiseHerdrWindow uses only that herdr session\'s agent cwds', async () => {
  let asked;
  const raise = async folders => { asked = folders; return folders[0]; };
  const agents = [{ session: 'acme', cwd: `${ACME}\\` }, { session: 'other', cwd: 'C:\\dev\\Ventures\\Corner Shop' }];
  assert.equal(await raiseHerdrWindow('acme', agents, raise), 'Project Acme');
  assert.deepEqual(asked, ['Project Acme', 'Development', 'dev']);
});

test('raiseCwdWindow asks for the cwd folder and its parents', async () => {
  let asked;
  assert.equal(await raiseCwdWindow(ACME, async f => { asked = f; return null; }), null);
  assert.deepEqual(asked, ['Project Acme', 'Development', 'dev']);
});

test("raisePidWindow asks by pid, and never with something that isn't one", async () => {
  const asked = [];
  const raise = async args => { asked.push(args); return 'MINGW64:~'; };
  assert.equal(await raisePidWindow(4242, { raise }), 'MINGW64:~');
  for (const bad of [undefined, null, 0, -1, '42', 1.5]) assert.equal(await raisePidWindow(bad, { raise }), null);
  assert.deepEqual(asked, [['--pid', '4242']]);
});

// Git Bash's `ps -W`, trimmed: a mintty window running bash, which ran a native program (ping).
const PS = String.raw`      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
  4257256       0       0      62952  ?              0   Oct 30 C:\Program Files\Some App\app.exe
  3059812       1 3059812      75976  ?         197611 13:33:33 /usr/bin/mintty
  3059814 3059812 3059814      15472  pty4      197611 13:33:33 /usr/bin/bash
  3059851 3059814 3059814      40672  pty4      197611 13:33:34 /c/Windows/system32/ping
  1060          1    1060      41700  cons0     197611   Oct 31 /usr/bin/bash
`;

test('minttyFor follows Git Bash parents from a Windows pid to its mintty window', () => {
  assert.equal(minttyFor(PS, 40672), 75976);
  assert.equal(minttyFor(PS, 15472), 75976);
  assert.equal(minttyFor(PS, 41700), null); // a console bash: no mintty above it
  assert.equal(minttyFor(PS, 62952), null);
  assert.equal(minttyFor(PS, 1), null);
  assert.equal(minttyFor('', 40672), null);
});

test("raisePidWindow falls back to Git Bash's process table when Windows' parent chain finds nothing", async () => {
  const asked = [];
  const raise = async args => { asked.push(args[1]); return args[1] === '75976' ? 'MINGW64:/c/dev' : null; };
  assert.equal(await raisePidWindow(40672, { gitDir: 'G', raise, ps: async g => g === 'G' ? PS : '' }), 'MINGW64:/c/dev');
  assert.deepEqual(asked, ['40672', '75976']);
});

test("raiseHerdrAnywhere: Cleon's own herdr window, then any herdr window on that workspace, then VS Code", async () => {
  const agents = [{ session: 'acme', cwd: ACME }];
  const only = hit => { const asked = []; return [asked, async args => { asked.push(args[0]); return args[0] === hit ? 'raised' : null; }]; };
  let [asked, raise] = only('--class');
  assert.equal(await raiseHerdrAnywhere('acme', agents, 'Formats engine', raise), 'raised');
  assert.deepEqual(asked, ['--class']);
  [asked, raise] = only('--herdr');
  assert.equal(await raiseHerdrAnywhere('acme', agents, 'Formats engine', raise), 'raised');
  assert.deepEqual(asked, ['--class', '--herdr']);
  [asked, raise] = only('Project Acme');
  assert.equal(await raiseHerdrAnywhere('acme', agents, undefined, raise), 'raised'); // no label: no title search
  assert.deepEqual(asked, ['--class', 'Project Acme']);
});

test('raise-window.py --flash exits cleanly when the window has gone', { skip: process.platform !== 'win32' }, async () => {
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../lib/raise-window.py', import.meta.url));
  const code = await new Promise(r => execFile('python', ['-I', script, '--flash', '0'], { timeout: 10_000 }, e => r(e ? e.code ?? 'error' : 0)));
  assert.equal(code, 0);
});

test("raisePeerHerdr raises the herdr window here that's showing the peer's workspace, waiting for its title to catch up", async () => {
  const asked = [];
  let tries = 0;
  const raise = async args => { asked.push(args); return ++tries === 3 ? 'WORKER-PC: ACME-70' : null; };
  assert.equal(await raisePeerHerdr('ACME-70', 'WORKER-PC', { raise, wait: async () => {} }), 'WORKER-PC: ACME-70');
  assert.deepEqual(asked[0], ['--herdr', 'ACME-70', '--host', 'WORKER-PC']);
  assert.equal(asked.length, 3);
  // Never shown here: gives up after five looks. From an older peer (no host): the label alone.
  const none = [];
  assert.equal(await raisePeerHerdr('ACME-70', null, { raise: async a => { none.push(a); return null; }, wait: async () => {} }), null);
  assert.equal(none.length, 5);
  assert.deepEqual(none[0], ['--herdr', 'ACME-70']);
});

test("raise-window.py: a herdr title matches its workspace label, and with a host only that machine's", { skip: process.platform !== 'win32' }, async () => {
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../lib/raise-window.py', import.meta.url));
  const cases = [
    ['WORKER-PC: ACME-70', 'ACME-70', null], ['WORKER-PC: ACME-70   ', 'ACME-70', 'worker-pc'], ['HOME-PC: ACME-70', 'ACME-70', 'WORKER-PC'],
    ['WORKER-PC: ACME-700', 'ACME-70', 'WORKER-PC'], ['✳ ACME-70', 'ACME-70', null],
  ];
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rw", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.herdr_title(t, l, h) for t, l, h in json.loads(sys.argv[2])]))`;
  const out = await new Promise((r, j) => execFile('python', ['-I', '-c', code, script, JSON.stringify(cases)], { timeout: 10_000 }, (e, o) => (e ? j(e) : r(o))));
  assert.deepEqual(JSON.parse(out), [true, true, false, false, false]);
});
