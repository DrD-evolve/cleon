import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newer, herdrVersions, pauseState, restartServer, bringUpToDate } from '../lib/herdr-update.mjs';
import { closeClassWindows, placeClassWindow } from '../lib/vscode.mjs';

test('newer compares x.y.z numerically and never calls an unreadable version newer', () => {
  assert.equal(newer('0.9.5', '0.8.2'), true);
  assert.equal(newer('0.10.0', '0.9.5'), true);
  assert.equal(newer('0.9.5', '0.9.5'), false);
  assert.equal(newer('0.8.2', '0.9.5'), false);
  assert.equal(newer(null, '0.8.2'), false);
  assert.equal(newer('0.9.5', null), false);
});

// A fake herdr: `status --json` per session, `session list --json`, and release-notes.json by path.
const fakeHerdr = ({ client = '0.8.2', servers = {}, sessions = [] }) => async args => {
  const session = args[0] === '--session' ? args[1] : null;
  const rest = session ? args.slice(2) : args;
  if (rest.join(' ') === 'session list --json') return { ok: true, out: JSON.stringify({ sessions }) };
  if (rest.join(' ') === 'status --json') return { ok: true, out: JSON.stringify({
    client: { version: client, channel: 'stable' },
    server: { socket: session ? `C:\\h\\sessions\\${session}\\herdr.sock` : 'C:\\h\\herdr.sock', version: servers[session] ?? null } }) };
  return { ok: false, out: '', err: 'unexpected' };
};

test("herdrVersions reads herdr's own update check and each running server's version", async () => {
  const run = fakeHerdr({ servers: { a: '0.8.2', b: '0.8.2' }, sessions: [{ name: 'a', running: true }, { name: 'b', running: true }, { name: 'c', running: false }] });
  const files = { 'C:\\h\\release-notes.json': JSON.stringify({ version: '0.9.5', body: '### Fixed\n- things' }) };
  const v = await herdrVersions(run, async p => { if (!(p in files)) throw new Error('missing'); return files[p]; });
  assert.deepEqual({ ...v, notes: v.notes.slice(0, 8) }, { installed: '0.8.2', channel: 'stable', latest: '0.9.5', update: true, notes: '### Fixe',
    servers: [{ session: 'a', version: '0.8.2' }, { session: 'b', version: '0.8.2' }], behind: [] });
  // Updated outside Cleon: the installed herdr is newer than the servers still running.
  const after = await herdrVersions(fakeHerdr({ client: '0.9.5', servers: { a: '0.8.2', b: '0.9.5' }, sessions: [{ name: 'a', running: true }, { name: 'b', running: true }] }),
    async () => JSON.stringify({ version: '0.9.5', body: 'x' }));
  assert.equal(after.update, false);
  assert.equal(after.notes, null);
  assert.deepEqual(after.behind, ['a']);
  // No update check on file yet: nothing to offer.
  assert.equal((await herdrVersions(fakeHerdr({}), async () => { throw new Error('none'); })).update, false);
  assert.equal((await herdrVersions(async () => ({ ok: false, out: '' }))).installed, null);
});

test('pauseState: not while an agent works or waits on you, nor while an orchestrator has tickets open', () => {
  const ws = [{ session: 'acme', workspace_id: 'w1', label: 'ACME-604 isolation' }];
  const snap = agents => ({ online: true, workspaces: ws, agents: agents.map(([status, agent = 'claude']) => ({ session: 'acme', workspace_id: 'w1', agent, agent_status: status })) });
  const run = (epic, ...steps) => ({ epic, tickets: steps.map((step, i) => ({ ticket: `${epic}-${i}`, step })) });
  assert.deepEqual(pauseState(snap([['idle'], ['done']]), [], []), { ok: true, why: [] });
  assert.deepEqual(pauseState(snap([['working'], ['blocked', 'codex']]), [], []).why,
    ['ACME-604 isolation (acme): claude is working', 'ACME-604 isolation (acme): codex is blocked']);
  // A live orchestrator, idle, with a ticket still to merge: it may be waiting on a merge watcher.
  assert.deepEqual(pauseState(snap([['idle']]), [{ epic: 'ACME-588' }], [run('ACME-588', 'done', 'human-review')]).why,
    ['the ACME-588 orchestrator is running (1 ticket open)']);
  // Its epic all merged: a pause, even though the session is still open.
  assert.equal(pauseState(snap([]), [{ epic: 'ACME-588' }], [run('ACME-588', 'done', 'done')]).ok, true);
  // No run folder yet: it's only just started.
  assert.equal(pauseState(snap([]), [{ epic: 'ACME-700' }], []).ok, false);
  assert.equal(pauseState({ online: false }, [], []).ok, true);
});

test('restartServer stops the server, closes its Cleon windows, starts it and reattaches each window in place', async () => {
  const calls = [];
  let running = true, polls = 0;
  const run = async args => {
    calls.push(args.slice(2).join(' '));
    if (args[2] === 'server') { running = false; return { ok: true, out: '' }; }
    if (args[2] === 'status') return { ok: true, out: JSON.stringify({ server: { running } }) };
    if (args[2] === 'api') return { ok: true, out: ++polls > 1 ? JSON.stringify({ result: { snapshot: {} } }) : '' };
    return { ok: false, out: '' };
  };
  const placed = [];
  const r = await restartServer('acme-api', {
    run, cwd: 'C:/dev/acme', wait: async () => {},
    closeWindows: async base => { calls.push(`close ${base}`); return [[1, 10, 20, 900, 700], [3, 0, 0, 100, 100]]; },
    serve: async (s, cwd) => { calls.push(`serve ${s} ${cwd}`); running = true; return { ok: true }; },
    attach: async (s, cwd, id) => { calls.push(`attach ${s}`); return { ok: true, id }; },
    place: async (cls, at) => { placed.push([cls.replace(/\d+$/, '<id>'), at]); return true; },
  });
  assert.deepEqual(r, { ok: true, session: 'acme-api', windows: 2 });
  assert.deepEqual(calls, ['server stop', 'status --json', 'close cleon-herdr-acme-api-', 'serve acme-api C:/dev/acme',
    'api snapshot', 'api snapshot', 'attach acme-api', 'attach acme-api']);
  assert.deepEqual(placed, [['cleon-herdr-acme-api-<id>', [1, 10, 20, 900, 700]], ['cleon-herdr-acme-api-<id>', [3, 0, 0, 100, 100]]]);
});

test("restartServer never closes windows on a server that didn't stop, or whose status can't be read", async () => {
  for (const status of [JSON.stringify({ server: { running: true } }), 'not json']) {
    let closed = false;
    const r = await restartServer('a', {
      run: async args => ({ ok: true, out: args[2] === 'status' ? status : '' }), wait: async () => {},
      closeWindows: async () => { closed = true; return []; }, serve: async () => ({ ok: true }), attach: async () => ({ ok: true }), place: async () => true,
    });
    assert.equal(r.ok, false);
    assert.equal(closed, false);
  }
});

test('bringUpToDate: refused unless a pause; restarts nothing when the update fails; re-checks the pause before restarts', async () => {
  const pause = (...states) => async () => states.shift() ?? { ok: true, why: [] };
  const versions = (...vs) => async () => vs.length > 1 ? vs.shift() : vs[0];
  const before = { installed: '0.8.2', latest: '0.9.5', update: true, behind: [] };
  const after = { installed: '0.9.5', latest: '0.9.5', update: false, behind: ['a', 'b'] };
  const restarted = [];
  const restart = async s => { restarted.push(s); return s === 'b' ? { ok: false, reason: 'b failed' } : { ok: true, windows: 1 }; };

  const busy = await bringUpToDate({ pause: pause({ ok: false, why: ['x is working'] }), versions: versions(before), update: async () => assert.fail('updated'), restart });
  assert.deepEqual(busy, { ok: false, reason: 'Not a pause: x is working' });

  const failed = await bringUpToDate({ pause: pause(), versions: versions(before, before), update: async () => ({ ok: false, err: 'download failed\nno network' }), restart });
  assert.deepEqual(failed, { ok: false, reason: "herdr update didn't install 0.9.5: no network" });
  assert.deepEqual(restarted, []);

  const lost = await bringUpToDate({ pause: pause({ ok: true, why: [] }, { ok: false, why: ['y is blocked'] }), versions: versions(before, after), update: async () => ({ ok: true }), restart });
  assert.equal(lost.ok, true);
  assert.deepEqual([lost.to, lost.pending, lost.restarted], ['0.9.5', ['a', 'b'], []]);
  assert.match(lost.reason, /no longer a pause: y is blocked/);

  const done = await bringUpToDate({ pause: pause(), versions: versions(before, after), update: async () => ({ ok: true }), restart });
  assert.deepEqual(done, { ok: false, from: '0.8.2', to: '0.9.5', restarted: [{ session: 'a', windows: 1 }], failed: [{ session: 'b', reason: 'b failed' }], pending: [], reason: 'b failed' });

  // Already installed, servers behind (updated outside Cleon): restarts only.
  const caught = await bringUpToDate({ pause: pause(), versions: versions({ ...after, behind: ['a'] }), update: async () => assert.fail('updated'), restart });
  assert.equal(caught.ok, true);
});

test('window helpers: a bad placement never reaches Windows; unreadable output is no windows', async () => {
  const ran = [];
  const run = async args => { ran.push(args); return ''; };
  assert.equal(await placeClassWindow('cleon-herdr-a-1', [1, 2, 3], run), false);
  assert.equal(await placeClassWindow('cleon-herdr-a-1', [1, 2, 3, 4, '5; rm'], run), false);
  assert.deepEqual(ran, []);
  assert.equal(await placeClassWindow('cleon-herdr-a-1', [1, 0, 0, 800, 600], run), true);
  assert.deepEqual(ran, [['--place', 'cleon-herdr-a-1', '1', '0', '0', '800', '600']]);
  assert.deepEqual(await closeClassWindows('cleon-herdr-a-', async () => null), []);
  assert.deepEqual(await closeClassWindows('cleon-herdr-a-', async () => '[[1,0,0,10,10]]'), [[1, 0, 0, 10, 10]]);
});
