// Peers: other machines' Cleons, whose rows this one shows beside its own. Each is `name=http://127.0.0.1:<port>`
// in MC_PEERS, reached over loopback (an SSH local forward to the other machine's own loopback-only Cleon), so
// nothing here listens on a network. A peer does its own reading and acting on its own machine; this server only
// reads its endpoints, merges the rows (tagged `machine`), and hands it the actions you take on its rows.
//
// A peer never slows this server down: reads return what the peer last answered and refresh in the background,
// so its rows lag by at most a poll, and a peer that stops answering drops out (shown offline) instead of
// holding up the local panels.

// Only loopback names a peer's own host check accepts (server.mjs `hostOk`): not [::1].
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
const NAME = /^[a-z][a-z0-9-]{0,31}$/i;

// Pure: MC_PEERS → { peers: [{ name, url }], refused: [{ entry, reason }] }.
export function parsePeers(src) {
  const peers = [], refused = [];
  for (const entry of (src ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    const name = eq > 0 ? entry.slice(0, eq).trim() : '', raw = eq > 0 ? entry.slice(eq + 1).trim() : '';
    let url = null;
    try { url = new URL(raw); } catch { /* reported below */ }
    const reason = !NAME.test(name) ? 'name it name=url, the name a letter then letters, digits or dashes'
      : peers.some(p => p.name.toLowerCase() === name.toLowerCase()) ? 'another peer has that name'
      : !url ? 'not a URL'
      : url.protocol !== 'http:' ? 'only http:// (it is loopback)'
      : !LOOPBACK.has(url.hostname) ? 'not loopback: a peer is reached through an SSH forward to 127.0.0.1, never over a network'
      : url.pathname !== '/' || url.search || url.username || url.password ? 'just scheme, host and port'
      : null;
    if (reason) refused.push({ entry, reason });
    else peers.push({ name, url: url.origin });
  }
  return { peers, refused };
}

// The key a peer's row goes by where ids repeat across machines (tickets, epics): `<machine>|<id>`.
export const ref = (machine, id) => (machine ? `${machine}|${id}` : id);

// One peer. `get(path)` is the read the merged endpoints use: never awaited on the network, it returns the
// peer's last answer for that path (null before the first, and while the peer is offline) and starts a
// refresh when that answer is older than `ttlMs`. `post` and `fetchRaw` are for actions and file reads you
// asked for, so they wait for the peer.
export function peerSource({ name, url }, { fetch = globalThis.fetch, timeoutMs = 4000, slowPaths = {}, ttlMs = 2000, staleMs = 15_000, now = Date.now } = {}) {
  const cache = new Map(); // path → { value, at, running }
  let okAt = 0, errAt = 0, error = null;
  const host = new URL(url).host;
  const online = () => okAt > 0 && okAt >= errAt && now() - okAt < staleMs;
  const call = async (path, init, ms) => {
    try {
      const r = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(ms) });
      okAt = now();
      return r;
    } catch (e) {
      errAt = now();
      error = e.name === 'TimeoutError' ? `no answer in ${ms / 1000} s` : e.cause?.code === 'ECONNREFUSED' ? 'nothing listening (is the SSH tunnel up?)' : e.message;
      e.peerCall = true;
      throw e;
    }
  };
  const refresh = path => {
    const c = cache.get(path) ?? {};
    cache.set(path, c);
    c.running = call(path, {}, slowPaths[path] ?? timeoutMs)
      .then(async r => {
        // An error status is about this path, not the peer: 404 is an older Cleon without the endpoint. The
        // peer stays online and only this path comes back empty (`status()` lists it).
        if (!r.ok) { c.value = undefined; c.at = now(); c.status = r.status; return; }
        let v;
        try { v = await r.json(); } catch {
          // A 200 that isn't JSON: something other than a Cleon is on that port. Counts like no answer.
          errAt = now(); error = `${path} answered, but not with JSON (is something else on that port?)`;
          return;
        }
        c.value = v; c.at = now(); c.status = null;
      }, () => { /* no answer: `call` counted it against the peer */ })
      .finally(() => { c.running = null; });
    return c.running;
  };
  const failed = test => [...cache].filter(([, c]) => c.status != null && test(c.status));
  return {
    name, url,
    get(path) {
      const c = cache.get(path);
      if (!c?.running && (!c || now() - (c.at ?? 0) >= ttlMs)) refresh(path);
      return online() && c?.value !== undefined && now() - c.at < staleMs ? c.value : null;
    },
    // Waits for any refresh in flight (tests, and warming the cache at startup).
    settle: () => Promise.all([...cache.values()].map(c => c.running)),
    // `missing`: paths the peer doesn't serve (an older Cleon). `failing`: paths it answered with another error.
    status: () => ({ name, url, online: online(), error: online() ? null : error ?? 'not reached yet', at: okAt || null,
      missing: failed(s => s === 404).map(([path]) => path), failing: failed(s => s !== 404).map(([path, c]) => ({ path, status: c.status })) }),
    // An action: the same guards the peer applies to its own page (POST, JSON, an Origin matching its Host).
    // Nothing else goes with it: no cookies, no tokens, only the body the page sent minus `machine`.
    async post(path, body, ms = 60_000) {
      try {
        const r = await call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://${host}` }, body: JSON.stringify(body) }, ms);
        return { status: r.status, body: await r.json().catch(() => ({ ok: false, reason: `the ${name} Cleon answered HTTP ${r.status}` })) };
      } catch { return { status: 502, body: { ok: false, reason: `couldn't reach ${name}: ${error}` } }; }
    },
    // A GET passed through as-is (run files, task output).
    async fetchRaw(path, ms = 10_000) {
      try {
        const r = await call(path, {}, ms);
        return { status: r.status, type: r.headers.get('content-type') ?? 'text/plain; charset=utf-8', body: Buffer.from(await r.arrayBuffer()) };
      } catch { return { status: 502, type: 'application/json', body: Buffer.from(JSON.stringify({ error: `couldn't reach ${name}: ${error}` })) }; }
    },
  };
}

// Merging. `peers` is [{ name, value }]: each peer's answer for the same endpoint. A row a peer already
// tagged came from a third machine (or back from this one, when two Cleons peer each other), so only a
// peer's own rows are taken: nothing is shown twice.
const own = rows => (rows ?? []).filter(x => !x?.machine);
const tagTasks = (tasks, machine) => (tasks ?? []).map(k => ({ ...k, machine }));

// Pure: sessions and attention are lists with globally unique ids (Claude session ids): tag and append.
export const mergeList = (local, peers) => [...(local ?? []), ...peers.flatMap(p => own(p.value).map(x => ({ ...x, machine: p.name })))];

// Pure: orchestrators: tag them and their background tasks (whose output is read on their machine).
export const mergeOrchestrators = (local, peers) => [...(local ?? []),
  ...peers.flatMap(p => own(p.value).map(o => ({ ...o, machine: p.name, tasks: tagTasks(o.tasks, p.name) })))];

// Pure: session activity, keyed by session id (unique): tag each entry's tasks.
export function mergeActivity(local, peers) {
  const out = { ...(local ?? {}) };
  for (const p of peers) for (const [id, a] of Object.entries(p.value ?? {}))
    if (!a?.machine) out[id] = { ...a, machine: p.name, tasks: tagTasks(a.tasks, p.name) };
  return out;
}

// Pure: workers, keyed by ticket. A ticket can sit on both machines, so a peer's go by `<machine>|<ticket>`.
export function mergeWorkers(local, peers) {
  const out = { ...(local ?? {}) };
  for (const p of peers) for (const [ticket, w] of Object.entries(p.value ?? {})) {
    if (w?.machine || ticket.includes('|')) continue;
    out[ref(p.name, ticket)] = { ...w, machine: p.name, tasks: tagTasks(w.tasks, p.name),
      subagents: (w.subagents ?? []).map(s => ({ ...s, tasks: tagTasks(s.tasks, p.name) })) };
  }
  return out;
}

// Pure: herdr snapshots. Workspace, tab and pane ids repeat across machines; every peer item carries its machine.
export function mergeHerdr(local, peers) {
  const parts = peers.map(p => ({ ...p.value, machine: p.name })).filter(h => h.online);
  if (!parts.length) return local;
  const out = { online: true, sessions: [], workspaces: [], tabs: [], agents: [], panes: [], focused: local?.online ? local.focused : null,
    ...(local?.online ? {} : { localReason: local?.reason ?? 'herdr offline' }) };
  for (const h of [...(local?.online ? [local] : []), ...parts]) {
    out.sessions.push(...(h.sessions ?? []).filter(s => !h.machine || !s.includes('|')).map(s => (h.machine ? ref(h.machine, s) : s)));
    for (const k of ['workspaces', 'tabs', 'agents', 'panes'])
      out[k].push(...own(h[k]).map(x => (h.machine ? { ...x, machine: h.machine } : x)));
  }
  return out;
}

// Pure: Resources. Each peer's own sample in a section of its own, never mixed into this machine's numbers, or
// why there's none yet. `peers` is [{ name, value, status }] (`status` from peerSource).
export const peerSamples = peers => peers.map(({ name, value, status }) => {
  if (!value) return { machine: name, sample: null, online: status.online, reason: status.online ? 'Sampling…' : `Not answering: ${status.error}` };
  const { peers: _, ...sample } = value; // only the peer's own machine, never what it got from its own peers
  return { machine: name, sample, online: true, reason: null };
});

// Runs for the merge: a deep enough copy of each peer's runs, tagged, that settling them (lib/runs.mjs
// `settleRuns`, which marks tickets done in place) never touches the cached answer.
export const peerRuns = peers => peers.flatMap(p => own(p.value?.runs).map(r => ({ ...r, machine: p.name, tickets: r.tickets.map(t => ({ ...t })) })));
