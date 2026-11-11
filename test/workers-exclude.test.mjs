import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
// Independent of this machine's .env and home folder: pin the exclusion and the transcript folder before the
// modules read them (an existing env var wins over .env, and static imports would load first).
process.env.MC_EXCLUDE = String.raw`C:/dev/ACME-private|[\\/]ACME-vault$`;
const home = await mkdtemp(join(os.tmpdir(), 'cleon-workers-excl-'));
process.env.USERPROFILE = home; process.env.HOME = home;
const { listWorkers } = await import('../lib/orchestrators.mjs');

const transcript = id => join(home, '.claude', 'projects', 'p-acme', `${id}.jsonl`);
const say = text => JSON.stringify({ type: 'assistant', timestamp: '2026-11-03T10:00:00Z', message: { content: [{ type: 'text', text }] } }) + '\n';
for (const id of ['acme-s1', 'acme-s2', 'acme-s3']) {
  await mkdir(join(transcript(id), '..'), { recursive: true });
  await writeFile(transcript(id), say(`working on ${id}`));
}
const run = id => ({ label: null, tickets: [{ ticket: `ACME-${id}`, step: 'implementing', stale: false, panes: [{ lane: 'active', pane: `p${id}`, role: 'worker' }] }] });
const snap = cwds => ({
  online: true,
  workspaces: [{ session: 's', workspace_id: 'w', label: 'ACME' }],
  agents: ['1', '2', '3'].map(n => ({ pane_id: `p${n}`, session: 's', workspace_id: 'w', agent_session: { value: `acme-s${n}` }, agent_status: 'working' })),
  panes: cwds.map((cwd, i) => ({ pane_id: `p${i + 1}`, session: 's', cwd })),
});
const workers = (n, cwds, sessions) => listWorkers([run(n)], snap(cwds), sessions, async () => []);
const live = (n, cwd) => [{ id: `acme-s${n}`, alive: true, cwd }];

test('listWorkers: a worker whose session or pane folder is excluded is never read, whichever slash the cwd or pattern uses', async () => {
  try {
    const open = 'C:\\dev\\ACME-public';
    assert.deepEqual(Object.keys(await workers('1', [open, open, open], live('1', open))), ['ACME-1']);
    assert.match((await workers('1', [open, open, open], live('1', open)))['ACME-1'].intent, /acme-s1/);
    // The session's cwd, a backslash path under a forward-slash pattern.
    assert.deepEqual(await workers('1', [open, open, open], live('1', 'C:\\dev\\ACME-private\\notes')), {});
    // The pane's cwd, a forward-slash path under a pattern written for either slash, when no live session matches.
    assert.deepEqual(await workers('2', [open, 'C:/dev/ACME-vault', open], []), {});
    // The pane's cwd, a backslash path under a forward-slash pattern.
    assert.deepEqual(await workers('3', [open, open, 'C:\\dev\\ACME-private'], live('3', open)), {});
  } finally { await rm(home, { recursive: true, force: true }); }
});
