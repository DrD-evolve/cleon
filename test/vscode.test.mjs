import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrWindows, raiseHerdrWindow } from '../lib/vscode.mjs';

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

test('herdrWindows maps attached sessions to their window folder and ignores stray mentions', () => {
  assert.deepEqual([...herdrWindows(STATUS)], [['acme', 'Project Acme']]);
});

test('raiseHerdrWindow raises the mapped window and nothing for unknown sessions', async () => {
  const raised = [];
  const run = async () => STATUS;
  const raise = async folder => { raised.push(folder); return true; };
  assert.equal(await raiseHerdrWindow('acme', run, raise), 'Project Acme');
  assert.deepEqual(raised, ['Project Acme']);
  assert.equal(await raiseHerdrWindow('ghost', run, raise), null);
  assert.equal(raised.length, 1);
  assert.equal(await raiseHerdrWindow('acme', run, async () => false), null);
});
