import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrWindows, folderPath, raiseHerdrWindow } from '../lib/vscode.mjs';

// Trimmed `code --status` process table, including a command line that merely mentions herdr.
const STATUS = [
  'CPU %\tMem MB\t   PID\tProcess',
  '    0\t   282\t  8872\twindow [3] (Welcome - Mission Control - Visual Studio Code)',
  ': && eval \'grep "session attach acme"\'',
  '    1\t   291\t 79800\twindow [1] (build-roadmap.html - Project Acme - Visual Studio Code)',
  String.raw`    0	    55	 14184	     C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -noexit`,
  String.raw`    0	    12	 11356	       "C:\Users\x\Programs\Herdr\bin\herdr.exe" session attach acme`,
  String.raw`    1	    50	  3760	         "C:\Users\x\Programs\Herdr\bin\herdr.exe" server`,
  '    0\t   100\t  1234\twindow [2] (Other - Visual Studio Code)',
  'Workspace Stats: ',
  '|  Window (build-roadmap.html - Project Acme - Visual Studio Code)',
].join('\n');

const ACME = String.raw`C:\dev\Development\Project Acme`;

test('herdrWindows maps attached sessions to their window folder and ignores stray mentions', () => {
  assert.deepEqual([...herdrWindows(STATUS)], [['acme', 'Project Acme']]);
});

test('folderPath picks the agent cwd named like the window folder', () => {
  const agents = [{ cwd: 'C:\\wt\\acme-platform-wt-ACME-70\\' }, { cwd: `${ACME}\\` }];
  assert.equal(folderPath('Project Acme', agents), ACME);
  assert.equal(folderPath('Nope', agents), null);
});

test('raiseHerdrWindow only opens a folder that matches an existing window', async () => {
  const calls = [];
  const run = async args => { calls.push(args); return args[0] === '--status' ? STATUS : ''; };
  const agents = [{ session: 'acme', cwd: `${ACME}\\` }];
  assert.equal(await raiseHerdrWindow('acme', agents, run), 'Project Acme');
  assert.deepEqual(calls.at(-1), [ACME]);
  calls.length = 0;
  assert.equal(await raiseHerdrWindow('ghost', agents, run), null);
  assert.ok(!calls.some(a => a[0] !== '--status'));
});
