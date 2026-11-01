import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderCandidates, raiseHerdrWindow, raiseCwdWindow } from '../lib/vscode.mjs';

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
