// docs/RUN-FORMAT.md is the contract for other orchestration tools. These tests build runs from that
// document alone, so the doc and the reader can't drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { listRuns, readRunFile } from '../lib/runs.mjs';

async function build(files) {
  const dir = await mkdtemp(join(os.tmpdir(), 'cleon-runs-'));
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), text);
  }
  return dir;
}

test('a run written to the documented layout reads as the documented steps', async () => {
  const dir = await build({
    'ACME-100/ACME-101/KICKOFF.md': 'brief',               // no STAGE yet: queued
    'ACME-100/ACME-102/STAGE': 'planning',
    'ACME-100/ACME-103/STAGE': 'plan-gate',
    'ACME-100/ACME-104/STAGE': 'implementing',
    'ACME-100/ACME-104/REVIEW_STAGE': 'review-done',        // a fix round after review
    'ACME-100/ACME-105/STAGE': 'report-done',
    'ACME-100/ACME-106/STAGE': 'report-done',
    'ACME-100/ACME-106/REVIEW_STAGE': 'review-done',
    'ACME-100/ACME-106/PR': 'https://github.com/o/r/pull/6',
    'ACME-100/ACME-107/STAGE': 'report-done',
    'ACME-100/ACME-107/PR': 'https://github.com/o/r/pull/7',
    'ACME-100/.watch-state/ACME-107.pr': 'MERGED',
    'ACME-100/ACME-108/STAGE': 'blocked',
    'ACME-100/ACME-108/BLOCKED': 'needs a decision',
    'ACME-100/ACME-108/PLAN.md': 'plan',                     // held before implementing
    'not-an-id/ACME-1/STAGE': 'planning',                    // ignored: not an epic id
  });
  try {
    const { runs } = await listRuns(dir, { lookup: async () => 'OPEN' });
    assert.equal(runs.length, 1);
    const by = Object.fromEntries(runs[0].tickets.map(t => [t.ticket, t]));
    assert.deepEqual(Object.fromEntries(Object.entries(by).map(([k, t]) => [k, t.step])), {
      'ACME-101': 'queued', 'ACME-102': 'planning', 'ACME-103': 'plan-gate', 'ACME-104': 'implementing',
      'ACME-105': 'self-review', 'ACME-106': 'human-review', 'ACME-107': 'done', 'ACME-108': 'implementing',
    });
    assert.equal(by['ACME-104'].fixRound, true);
    assert.equal(by['ACME-106'].pr, 'https://github.com/o/r/pull/6');
    assert.deepEqual([by['ACME-108'].held, by['ACME-108'].blockedOn], [true, 'needs a decision']);
    assert.equal(await readRunFile('ACME-100', 'ACME-101', 'KICKOFF.md', dir, dir), 'brief');
    assert.equal(await readRunFile('ACME-100', 'ACME-101', 'STAGE', dir, dir), null); // not an artifact
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MC_ORCH_ADAPTER swaps in another tool\'s file names and stage words', async () => {
  const dir = await build({
    'ACME-200/ACME-201/STATUS': 'go',
    'ACME-200/ACME-202/STAGE': 'planning',                   // the default name means nothing here
  });
  const base = pathToFileURL(fileURLToPath(new URL('../lib/adapters/orchestration-plugin.mjs', import.meta.url))).href;
  await writeFile(join(dir, 'adapter.mjs'), `import base from '${base}';
export default { ...base, files: { ...base.files, stage: 'STATUS' },
  deriveStep: ({ stage }) => ({ step: stage === 'go' ? 'implementing' : 'queued' }) };`);
  const runsUrl = pathToFileURL(fileURLToPath(new URL('../lib/runs.mjs', import.meta.url))).href;
  const script = `const { listRuns } = await import(${JSON.stringify(runsUrl)});
const { runs } = await listRuns(${JSON.stringify(dir)}, { lookup: async () => null });
console.log(JSON.stringify(runs[0].tickets.map(t => [t.ticket, t.step]).sort()));`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, MC_ORCH_ADAPTER: join(dir, 'adapter.mjs') } });
    assert.deepEqual(JSON.parse(stdout), [['ACME-201', 'implementing'], ['ACME-202', 'queued']]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
