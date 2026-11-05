// Cleon — local-only dashboard server. Binds to 127.0.0.1; no auth, no cloud calls.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions } from './lib/sessions.mjs';
import { hostname } from 'node:os';
import { herdrSnapshot, herdrFocus, paneForPid, agentForSession, panePids, herdr, herdrMachines } from './lib/herdr.mjs';
import { raiseHerdrWindow, raiseCwdWindow, raiseFolderWindow, raiseClassWindow, raiseHerdrClient, raisePidWindow, raiseHerdrAnywhere,
  closeClassWindows, placeClassWindow, raisePeerHerdr } from './lib/vscode.mjs';
import { herdrVersions, herdrExec, pauseState, restartServer, bringUpToDate } from './lib/herdr-update.mjs';
import { focusSession } from './lib/focus.mjs';
import { listOrchestrators, listWorkers, listSessionActivity } from './lib/orchestrators.mjs';
import { sampleResources } from './lib/resources.mjs';
import { EXCLUDE_SRC } from './lib/config.mjs';
import { sampleDocker, pruneDocker, removeImage, watchDockerEvents } from './lib/docker.mjs';
import { listAttention } from './lib/attention.mjs';
import { answerGate } from './lib/gate.mjs';
import { EXCLUDE, GIT_DIR } from './lib/config.mjs';
import { execFile } from 'node:child_process';
import { taskOutput } from './lib/tasks.mjs';
import { listSessionPrs } from './lib/sessionprs.mjs';
import { listRuns, readRunFile, runLocations, settleRuns } from './lib/runs.mjs';
import { PEERS_SRC, HEADLESS } from './lib/config.mjs';
import { parsePeers, peerSource, ref, mergeList, mergeOrchestrators, mergeActivity, mergeWorkers, mergeHerdr, peerRuns, peerSamples, peerCounts } from './lib/peers.mjs';
import { buildGraph } from './lib/graph.mjs';
import { listProjects, projectMap, findProject } from './lib/projects.mjs';
import { openInHerdr, openInBash, openInVscode, startInHerdr, attachHerdrWindow, serveHeadless, cleanEnv } from './lib/open.mjs';
import { supervise, freePort, portFree, readTunnels, writeTunnels, killOrphans } from './lib/tunnel.mjs';
import { restartOrchestrator } from './lib/resume.mjs';
import { linearIssues } from './lib/linear.mjs';
import { scmSummary, scmName, prChecks, prNumber } from './lib/scm.mjs';
import { processMetrics, processInputs } from './lib/metrics.mjs';
import { scanUsage, usageInput, usageReport, codexStatus } from './lib/usage.mjs';
import { activity, asking } from './lib/activity.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// .env is loaded by lib/config.mjs, imported (through the lib modules) before this line runs.

// Remote APIs are cached so several open tabs don't multiply calls. A call that arrives while the
// value is being fetched waits for that fetch rather than starting another, so the endpoints a page
// poll hits at once share one result.
const cached = (fn, ttlMs) => {
  let at = 0, value, running = null;
  const get = () => (Date.now() - at < ttlMs ? Promise.resolve(value)
    : running ??= Promise.resolve().then(fn).then(v => { value = v; at = Date.now(); return v; }).finally(() => { running = null; }));
  get.reset = () => { at = 0; }; // the next call reads afresh
  return get;
};
// Read by several endpoints in every 5 s poll (and by every open window), so read once and shared
// for a moment: the herdr snapshot is a herdr process per session, the session list a file read and
// a pid check per session, the repo scan two git processes per repo. Actions read their own fresh copy.
const herdrShared = cached(() => herdrSnapshot(), 2000);
const sessionsShared = cached(() => listSessions(), 1000);
const projectsShared = cached(() => listProjects(), 30_000);
// Other machines' Cleons (MC_PEERS, lib/peers.mjs). Their rows join the read endpoints below, tagged with the
// machine; actions on those rows are handed to the peer they came from. A refused entry is never contacted.
const { peers: PEER_LIST, refused: PEERS_REFUSED } = parsePeers(PEERS_SRC);
// A peer's own Resources sample: `local=1`, so two Cleons that peer each other never keep each other sampling.
const PEER_RES = '/api/resources?local=1';
const PEER_USAGE = '/api/usage-input';
// A peer's first Resources sample takes a few seconds, its first usage read a full transcript scan; a timeout
// would count against the whole peer.
// A peer given as ssh://<host> is read through a tunnel this Cleon runs (startTunnels), so it has no URL until then.
const PEERS = PEER_LIST.map(p => peerSource({ name: p.name, url: p.url ?? null }, { slowPaths: { '/api/process-input': 30_000, [PEER_RES]: 20_000, [PEER_USAGE]: 60_000 } }));
const TUNNELS = new Map(); // peer name → its tunnel (lib/tunnel.mjs supervise)
// Each peer's last answer for `path`, for the ones that have one (never waits on the network).
const fromPeers = path => PEERS.map(p => ({ name: p.name, value: p.get(path) })).filter(x => x.value != null);
// This machine's runs plus the peers', settled together: the peers' PRs are checked here (where the
// source-control token is), and a ticket merged on either machine reads done on both.
async function allRuns() {
  const local = await listRuns();
  const theirs = peerRuns(fromPeers('/api/runs'));
  return theirs.length ? settleRuns([...local.runs, ...theirs]) : local;
}
const linearCached = cached(() => linearIssues(), 60_000);
// GitHub or Bitbucket (MC_SCM); `scm` names it for the tab label.
const githubCached = cached(async () => ({ scm: scmName, ...await scmSummary() }), 60_000);
// CI checks, per check: in-flight tickets (not done, not stale) keyed by ticket, plus your own open
// PRs whose CI is pending or failing keyed "pr:<url>", so a PR outside any orchestration (a session
// working by hand) shows its jobs and mutation progress too. A peer's tickets are keyed `<machine>|<ticket>`.
const checksCached = cached(async () => {
  const { runs } = await allRuns();
  const live = runs.flatMap(r => r.tickets.map(t => ({ ...t, machine: r.machine }))).filter(t => t.pr && t.step !== 'done' && !t.stale);
  const mine = ((await githubCached())?.myPrs ?? []).filter(p => p.checks === 'pending' || p.checks === 'failing');
  const out = {};
  await Promise.all([
    ...live.map(async t => { const c = await prChecks(t.pr); if (c) out[ref(t.machine, t.ticket)] = c; }),
    ...mine.map(async p => { const c = await prChecks(p.url); if (c) out[`pr:${p.url}`] = c; }),
  ]);
  return out;
}, 30_000);
// System resources: sampled at most every 8s and never twice at once (a sample takes ~3s).
// Only requested while the Resources panel is on the board, so nothing runs when it's closed.
let resLast = null, resRunning = null;
async function resources() {
  if (!resRunning && (!resLast || Date.now() - resLast.at > 8000)) {
    resRunning = (async () => {
      const labels = new Map((await sessionsShared()).filter(s => s.alive).map(s => [s.pid, `Claude · ${s.name}`]));
      labels.set(process.pid, 'Cleon server');
      return (resLast = await sampleResources(labels));
    })().finally(() => { resRunning = null; });
  }
  return resLast ?? resRunning;
}
// Docker: like resources, sampled at most every 8s and only while the Docker panel is on the board.
let dockerLast = null, dockerRunning = null;
async function docker(fresh = false) {
  if (!dockerRunning && (fresh || !dockerLast || Date.now() - dockerLast.at > 8000))
    dockerRunning = sampleDocker().then(d => (dockerLast = d)).finally(() => { dockerRunning = null; });
  return dockerRunning ?? dockerLast;
}
// Process metrics: only while the Process panel is on the board. The first build scans transcripts
// and asks GitHub about each merged PR (~10s); later ones reuse both caches. Never two at once.
let metricsLast = null, metricsRunning = null;
async function metrics() {
  if (!metricsRunning && (!metricsLast || Date.now() - metricsLast.at > 60_000))
    metricsRunning = (async () => {
      const { runs } = await allRuns();
      const theirs = await peerInputs('/api/process-input');
      return (metricsLast = await processMetrics(runs, { peers: theirs.map(p => ({ name: p.name, input: p.value })) }));
    })().finally(() => { metricsRunning = null; });
  return metricsLast ?? metricsRunning;
}
// Each peer's answer for `path`, for a panel built from every machine (Process, Usage). Asked for only while
// that panel is open, so a peer's first answer (a transcript scan there, ~10 s) is waited for, up to 15 s:
// this holds up that panel alone, never the others.
async function peerInputs(path) {
  if (fromPeers(path).length < PEERS.length)
    await Promise.race([Promise.all(PEERS.map(p => p.settle())), new Promise(r => setTimeout(r, 15_000))]);
  return fromPeers(path);
}
// What this machine adds to a peer's Process panel: timestamps only (lib/metrics.mjs processInputs).
const processInputCached = cached(async () => processInputs((await listRuns()).runs), 60_000);
// This machine's transcripts, scanned at most once a minute and never twice at once (the ledger is updated in
// place): read by the Usage panel here and by each peer's (/api/usage-input). The first read goes through every
// transcript (~10 s); later ones read only what each has gained, and the ledger keeps totals for transcripts
// Claude Code deletes.
const usageFiles = cached(async () => {
  const { runs } = await listRuns();
  const files = await scanUsage({ ticketEpic: new Map(runs.flatMap(r => r.tickets.map(t => [t.ticket, r.epic]))) });
  return { files, projects: await projectsShared() };
}, 60_000);
// Usage: only while the Usage panel is on the board. Each peer's totals (its usageInput) are counted with this
// machine's, never saved here: each machine's ledger is its own.
let usageLast = null, usageRunning = null;
async function usage() {
  if (!usageRunning && (!usageLast || Date.now() - usageLast.at > 60_000))
    usageRunning = (async () => {
      const [{ files, projects }, theirs] = await Promise.all([usageFiles(), peerInputs(PEER_USAGE)]);
      const { runs } = await allRuns(); // a peer's tickets too: their epics, and which merged
      const tickets = runs.flatMap(r => r.tickets.map(t => ({ ticket: t.ticket, epic: r.epic, step: t.step })));
      const alive = new Set(mergeList(await sessionsShared(), fromPeers('/api/sessions')).filter(s => s.alive).map(s => s.id));
      return (usageLast = { ...usageReport(files, { projects, tickets, alive, peers: theirs.map(p => ({ name: p.name, input: p.value })) }),
        peers: peerCounts(PEERS.map(p => p.status()), new Set(theirs.map(p => p.name)), PEER_USAGE), codex: await codexStatus() });
    })().finally(() => { usageRunning = null; });
  return usageLast ?? usageRunning;
}
// Background tasks' progress: the tail of each listed task's output file, attached in place.
// Agent tasks are left out: a subagent's progress is its own activity feed.
const listedTasks = (orch, workers) => [...orch.flatMap(o => o.tasks),
  ...Object.values(workers).flatMap(w => [...w.tasks, ...w.subagents.flatMap(s => s.tasks)])].filter(k => k.kind !== 'agent');
async function withProgress(orch, workers) {
  await Promise.all(listedTasks(orch, workers).map(async k => { k.out = await taskOutput(k.id); }));
}
async function orchestrators() {
  const o = await listOrchestrators(await sessionsShared(), await herdrShared());
  await withProgress(o, {});
  return o;
}
async function sessionActivity() {
  const a = await listSessionActivity(await sessionsShared());
  await Promise.all(Object.values(a).flatMap(x => x.tasks).map(async k => { k.out = await taskOutput(k.id); }));
  return a;
}
async function workers() {
  const w = await listWorkers((await listRuns()).runs, await herdrShared(), await sessionsShared());
  await withProgress([], w);
  return w;
}
// Jumps into herdr open a window on the session when none shows it (see herdrFocus).
const attachHerdr = (session, cwd, id) => attachHerdrWindow(session, cwd, { gitDir: GIT_DIR, raiseClass: raiseClassWindow, ...(id ? { id } : {}) });
// MC_HEADLESS: no one sits at this machine (a worker its owner reaches over RDP or a tunnel), so jumps,
// restarts and herdr updates never raise or attach a window; herdr panes are still focused. Answers say `headless`.
const raiser = HEADLESS ? null : raiseHerdrAnywhere;
const attacher = HEADLESS ? null : attachHerdr;
const noWindow = async () => null;
// herdr updates (Herdr panel). Versions are read at most once a minute (a herdr process per running
// session); whether it's a pause is worked out on every ask, from the shared snapshot and run state.
const herdrVersionsCached = cached(() => herdrVersions(), 60_000);
const herdrPause = async (fresh = false) => {
  const snap = fresh ? await herdrSnapshot() : await herdrShared();
  const sessions = fresh ? await listSessions() : await sessionsShared();
  return pauseState(snap, await listOrchestrators(sessions, snap), (await listRuns()).runs);
};
let herdrUpdating = false;
async function updateHerdr() {
  if (herdrUpdating) return { ok: false, reason: 'an update is already running' };
  herdrUpdating = true;
  try {
    return await bringUpToDate({
      versions: () => herdrVersions(),
      pause: () => herdrPause(true),
      update: () => herdrExec(['update'], 300_000),
      restart: async session => {
        // A pane's folder for the server and the new window to start in (the server only uses it as a default).
        const cwd = (await herdrSnapshot()).panes?.find(p => p.session === session)?.cwd;
        // Headless: no windows to close, so none are reopened.
        return restartServer(session, { cwd, serve: serveHeadless, closeWindows: HEADLESS ? async () => [] : closeClassWindows, attach: attachHerdr, place: placeClassWindow });
      },
    });
  } finally { herdrUpdating = false; }
}
// Plan gate answers. The browser names a ticket and an option; the pane is worked out here, from the
// ticket's worker session, so a request can only ever reach a worker that is at its plan gate.
const herdrCall = args => new Promise(resolve => execFile('herdr', args, { timeout: 8000, windowsHide: true, maxBuffer: 4e6 },
  (err, out, errOut) => resolve({ ok: !err, out, reason: (errOut || err?.message || '').trim().split('\n')[0] })));
let gateBusy = false;
async function answerPlanGate({ ticket, choice, question, options }) {
  const t = (await listRuns()).runs.flatMap(r => r.tickets).find(t => t.ticket === ticket && !t.stale);
  if (!t || t.step !== 'plan-gate' || t.held) return { ok: false, reason: `${ticket} isn't at its plan gate` };
  const [sessions, snap] = [await listSessions(), await herdrSnapshot()];
  const w = (await listWorkers((await listRuns()).runs, snap, sessions))[ticket];
  const s = w && sessions.find(x => x.id === w.sessionId && x.alive);
  if (!s) return { ok: false, reason: "the ticket's worker session isn't running" };
  if (EXCLUDE.test(s.cwd ?? '')) return { ok: false, reason: 'excluded session' };
  const live = sessions.filter(x => x.alive);
  const agent = await agentForSession(s, snap, live, panePids());
  if (!agent) return { ok: false, reason: "the worker isn't in a herdr pane; answer it there" };
  if (gateBusy) return { ok: false, reason: 'another answer is being sent' };
  gateBusy = true;
  try {
    return await answerGate({ question, options }, choice, {
      read: async () => (await herdrCall(['--session', agent.session, 'agent', 'read', agent.pane_id, '--source', 'visible'])).out,
      key: k => herdrCall(['--session', agent.session, 'pane', 'send-keys', agent.pane_id, k]),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
    });
  } finally { gateBusy = false; }
}
// Merge approval: one fixed prompt to the epic's orchestrator, never text from the browser. The
// wording is what mergeApprovals() recognises, so the ticket reads "merge approved" once it's sent.
// CI is mentioned only while it's part of the merge: checks still running or failing, or CI that couldn't
// be read. With no CI, or CI already green, the prompt just says merge.
export const mergePrompt = (pr, ticket, ciGate) => `Merge PR #${pr} for ${ticket}${ciGate ? ' when its CI is green' : ''}.`;
// Pure: does this PR's CI still stand between it and a merge? `checks` is the checks feed entry. No entry
// means CI couldn't be read (no SCM access, or the lookup failed): it may be running or failing, so it counts.
export const ciGates = checks => !checks || Boolean(checks.checks?.some(k => ['pending', 'fail', 'cancel'].includes(k.bucket)));
async function approveMerge({ ticket }) {
  const run = (await listRuns()).runs.find(r => r.tickets.some(t => t.ticket === ticket && !t.stale));
  const t = run?.tickets.find(t => t.ticket === ticket && !t.stale);
  if (!t || t.step !== 'human-review' || t.held) return { ok: false, reason: `${ticket} isn't at review·merge` };
  const pr = prNumber(t.pr);
  if (!pr) return { ok: false, reason: `${ticket} has no PR number` };
  // More than one live session can look like this epic's orchestrator. An approval from any of them
  // counts; the prompt goes only to the one in a herdr pane, and never when that's ambiguous.
  const all = (await listOrchestrators(await listSessions(), await herdrSnapshot())).filter(o => o.epic === run.epic);
  if (!all.length) return { ok: false, reason: `no live orchestrator for ${run.epic}` };
  if (all.some(o => o.approvals.some(a => (a.prs.includes(pr) || a.tickets.includes(ticket)) && (!t.since || a.t >= t.since))))
    return { ok: false, reason: 'already approved; the orchestrator has it' };
  const inHerdr = all.filter(o => o.pane);
  if (!inHerdr.length) return { ok: false, reason: "the orchestrator isn't in a herdr pane; tell it there" };
  if (inHerdr.length > 1) return { ok: false, reason: `${inHerdr.length} orchestrators in herdr panes claim ${run.epic}; tell the right one directly` };
  const o = inHerdr[0];
  if (o.status === 'working') return { ok: false, reason: 'the orchestrator is mid-turn; try again when its turn ends' };
  const checks = (await checksCached())[ticket];
  const text = mergePrompt(pr, ticket, ciGates(checks));
  const r = await herdrCall(['--session', o.pane.herdr, 'agent', 'prompt', o.pane.id, text]);
  if (!r.ok) {
    const code = (() => { try { return JSON.parse(r.out).error?.code; } catch { return null; } })();
    return { ok: false, reason: code === 'agent_blocked' ? 'the orchestrator is waiting on a question; answer that first' : `herdr refused: ${code ?? r.reason}` };
  }
  return { ok: true, sent: text, ...(checks ? {} : { ciUnknown: true }) };
}
const HOST = process.env.MC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MC_PORT ?? 4317);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const VENDOR = {
  '/vendor/3d-force-graph.min.js': 'node_modules/3d-force-graph/dist/3d-force-graph.min.js',
  '/vendor/force-graph.min.js': 'node_modules/force-graph/dist/force-graph.min.js',
  '/vendor/gridstack-all.js': 'node_modules/gridstack/dist/gridstack-all.js',
  '/vendor/gridstack.min.css': 'node_modules/gridstack/dist/gridstack.min.css',
  '/vendor/marked.esm.js': 'node_modules/marked/lib/marked.esm.js',
};

let graph = null; // cached; rebuilt on ?refresh=1
const getGraph = async refresh => (graph = !graph || refresh ? await buildGraph() : graph);

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const text = (res, body) => body == null ? json(res, { error: 'not found' }, 404)
  : (res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }), res.end(body));

// Endpoints that act (focus herdr, raise windows) are POST-only and same-origin only, so another page
// in the browser can't drive them (a cross-site form post carries a foreign Origin; a no-cors fetch
// can't send JSON). Host is pinned to loopback so a DNS-rebound domain can't pass as same-origin.
// Returns the parsed JSON body, or null after answering the request itself.
async function actionBody(req, res, max = 1024) {
  if (req.body) return req.body; // already read and checked (see FORWARDED)
  const host = req.headers.host ?? '';
  if (req.method !== 'POST' || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers.origin !== `http://${host}`
    || !req.headers['content-type']?.startsWith('application/json')) { json(res, { error: 'forbidden' }, 403); return null; }
  let body = '';
  for await (const c of req) { body += c; if (body.length > max) { json(res, { error: 'too large' }, 413); return null; } }
  try { return JSON.parse(body || '{}'); } catch { json(res, { error: 'bad json' }, 400); return null; }
}

// The read endpoints marked "+ peers" return this machine's rows and each peer's (lib/peers.mjs), every
// peer row tagged `machine`.
const routes = {
  '/api/sessions': async () => mergeList(await sessionsShared(), fromPeers('/api/sessions')), // + peers
  '/api/session-prs': async () => listSessionPrs(await sessionsShared(), (await githubCached())?.myPrs),
  // + peers; `host`: this machine's name, which herdr starts its window titles with (a peer's window, raised here)
  '/api/herdr': async () => ({ ...mergeHerdr(await herdrShared(), fromPeers('/api/herdr')), host: hostname() }),
  '/api/herdr/version': async () => ({ ...await herdrVersionsCached(), pause: await herdrPause(), updating: herdrUpdating }),
  '/api/runs': allRuns, // + peers
  // + each tunnel this Cleon runs. Local only: ssh's error line names the account and the peer's address.
  '/api/peers': async () => PEERS.map(p => ({ ...p.status(), ...(TUNNELS.has(p.name) ? { tunnel: TUNNELS.get(p.name).status() } : {}) })),
  '/api/process-input': processInputCached, // for a peer's Process panel
  '/api/usage-input': async () => { const { files, projects } = await usageFiles(); return usageInput(files, projects); }, // for a peer's Usage panel
  '/api/projects': async () => projectsShared(),
  '/api/projmap': async () => projectMap(undefined, projectsShared),
  '/api/linear': linearCached,
  '/api/github': githubCached,
  '/api/checks': checksCached,
  // + each peer's own sample, under `peers` (asked for only while the Resources panel is open, never waited on).
  '/api/resources': async q => (q.get('local') === '1' ? resources()
    : { ...await resources(), peers: peerSamples(PEERS.map(p => ({ name: p.name, value: p.get(PEER_RES), status: p.status() }))) }),
  '/api/docker': () => docker(),
  '/api/metrics': () => metrics(),
  '/api/usage': () => usage(),
  '/api/orchestrators': async () => mergeOrchestrators(await orchestrators(), fromPeers('/api/orchestrators')), // + peers
  '/api/attention': async () => mergeList(await listAttention(await sessionsShared(), await herdrShared()), fromPeers('/api/attention')), // + peers
  '/api/workers': async () => mergeWorkers(await workers(), fromPeers('/api/workers')), // + peers
  '/api/session-activity': async () => mergeActivity(await sessionActivity(), fromPeers('/api/session-activity')), // + peers
  '/api/boot': async () => ({ boot: BOOT }),
  '/api/activity': async q => activity(Number(q.get('rev')) || 0, Number(q.get('at')) || 0),
  '/api/graph': async q => { const { nodes, links } = await getGraph(q.get('refresh') === '1'); return { nodes, links }; },
};

// The exit code that asks scripts/launch.sh (which sets MC_SUPERVISED) to start the server again.
export const RESTART_CODE = 75;
// This process's start, so the page can tell the restarted server from the one that's exiting.
const BOOT = Date.now();

// Every request must name a loopback host (or MC_HOST), so a DNS-rebound page can't read the API either.
const hostOk = host => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || host.replace(/:\d+$/, '') === HOST;

// Each request runs with its path in `asking`, so the Activity panel can say which endpoint asked for
// every program and web request made while answering it.
export const server = createServer((req, res) => asking.run({ route: new URL(req.url, 'http://x').pathname }, () => handle(req, res)));

// Actions you can take on a peer's row, with each one's body limit. The body names the row's machine; such an
// action is checked here like any other, then handed to that peer (lib/peers.mjs `post`) without `machine`,
// and the peer acts on its own machine under its own guards. Without `machine` it's this machine's.
const FORWARDED = { '/api/gate/answer': 16_384, '/api/merge/approve': 1024, '/api/herdr/focus': 1024, '/api/session/focus': 1024, '/api/runs/restart': 1024 };
async function forward(res, path, { machine, ...body }) {
  const peer = PEERS.find(p => p.name === machine);
  if (!peer) return json(res, { ok: false, reason: `no peer named ${typeof machine === 'string' ? machine : '(not a name)'}` }, 400);
  const r = await peer.post(path, body);
  const here = !HEADLESS && JUMPS.has(path) && r.body?.ok && typeof r.body.session === 'string' ? { here: await peerWindow(peer, r.body, body.label) } : {};
  return json(res, { ...r.body, machine, ...here }, r.status);
}
// A jump the peer answered by focusing a herdr pane: the herdr window here that's switched to that machine
// (its saved machine, in herdr's sidebar) follows the focus, so it's raised and flashed. Found by its title,
// "<peer's host>: <workspace label>", the label read from the peer's herdr snapshot. With none showing it, the
// answer names the saved machine to switch a window to, or how to save one. A headless machine raises nothing.
const JUMPS = new Set(['/api/herdr/focus', '/api/session/focus']);
async function peerWindow(peer, { session, workspace }, asked) {
  const snap = peer.get('/api/herdr');
  const label = snap?.workspaces?.find(w => w.session === session && w.workspace_id === workspace)?.label ?? (typeof asked === 'string' ? asked : null);
  const raised = label ? await raisePeerHerdr(label, typeof snap?.host === 'string' ? snap.host : null) : null;
  if (raised) return { raised };
  const saved = (await herdrMachines()).find(m => m.enabled !== false && m.session === session && String(m.target).toLowerCase() === peer.name.toLowerCase());
  return saved ? { raised: null, switchTo: saved.label } : { raised: null, setup: `herdr machine add ${peer.name} --remote-session ${session}` };
}
// Reads passed through to a peer for its rows (`?machine=`): a plan or report, a task's output. The peer
// serves only what it would serve its own page.
const FORWARDED_READS = new Set(['/api/run-file', '/api/task-output']);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!hostOk(req.headers.host ?? '')) return json(res, { error: 'forbidden' }, 403);
  try {
    if (Object.hasOwn(FORWARDED, url.pathname)) {
      const body = await actionBody(req, res, FORWARDED[url.pathname]);
      if (!body) return;
      if (body.machine !== undefined) return forward(res, url.pathname, body);
      req.body = body; // the handler below reads it from here
    }
    if (FORWARDED_READS.has(url.pathname) && url.searchParams.has('machine')) {
      const q = new URLSearchParams(url.searchParams), machine = q.get('machine');
      q.delete('machine');
      const peer = PEERS.find(p => p.name === machine);
      if (!peer) return json(res, { error: `no peer named ${machine}` }, 404);
      const r = await peer.fetchRaw(`${url.pathname}?${q}`);
      res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store' });
      return res.end(r.body);
    }
    if (routes[url.pathname]) return json(res, await routes[url.pathname](url.searchParams));
    if (url.pathname === '/api/file') {
      const p = (await getGraph()).files.get(url.searchParams.get('id'));
      return text(res, p ? await readFile(p, 'utf8') : null);
    }
    if (url.pathname === '/api/herdr/focus') {
      const body = await actionBody(req, res);
      if (!body) return;
      const { pane, workspace, label } = body;
      const str = v => v === undefined || typeof v === 'string';
      if (!(pane || workspace) || !str(pane) || !str(workspace) || !str(label)) return json(res, { error: 'pane or workspace required' }, 400);
      const r = await herdrFocus({ pane, workspace, label }, undefined, raiser, attacher);
      return json(res, HEADLESS ? { ...r, headless: true } : r, r.ok ? 200 : 409);
    }
    if (url.pathname === '/api/session/focus') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (typeof body.id !== 'string') return json(res, { error: 'id required' }, 400);
      const r = await focusSession(body.id, {
        sessions: listSessions, snapshot: herdrSnapshot, paneForPid: pid => paneForPid(pid),
        raisePid: HEADLESS ? noWindow : pid => raisePidWindow(pid, { gitDir: GIT_DIR }), raiseCwd: HEADLESS ? noWindow : raiseCwdWindow,
        focusPane: t => herdrFocus(t, undefined, raiser, attacher),
      });
      return json(res, HEADLESS ? { ...r, headless: true } : r, r.ok ? 200 : 409);
    }
    if (url.pathname === '/api/docker/prune' || url.pathname === '/api/docker/image-rm') {
      const body = await actionBody(req, res);
      if (!body) return;
      const r = url.pathname.endsWith('prune') ? await pruneDocker(String(body.what))
        : typeof body.id === 'string' && (body.ref === null || typeof body.ref === 'string') ? await removeImage(body.id, body.ref)
        : { ok: false, reason: 'id and ref required' };
      await docker(true);
      return json(res, r, r.ok ? 200 : 409);
    }
    // The last lines of one background task's output, only for a task the dashboard lists now.
    if (url.pathname === '/api/task-output') {
      const id = url.searchParams.get('id');
      const listed = listedTasks(await listOrchestrators(await sessionsShared(), await herdrShared()),
        await listWorkers((await listRuns()).runs, await herdrShared(), await sessionsShared()));
      const ofSessions = Object.values(await listSessionActivity(await sessionsShared())).flatMap(a => a.tasks);
      if (![...listed, ...ofSessions].some(k => k.id === id)) return json(res, { error: 'not a listed task' }, 404);
      return json(res, await taskOutput(id, 60) ?? { size: 0, at: null, lines: [] });
    }
    if (url.pathname === '/api/gate/answer') {
      const body = await actionBody(req, res, 16_384);
      if (!body) return;
      const { ticket, choice, question, options } = body;
      if (typeof ticket !== 'string' || !Number.isInteger(choice) || typeof question !== 'string'
        || !Array.isArray(options) || !options.every(o => typeof o === 'string')) return json(res, { error: 'ticket, choice, question and options required' }, 400);
      const r = await answerPlanGate({ ticket, choice, question, options });
      return json(res, r, r.ok ? 200 : 409);
    }
    if (url.pathname === '/api/merge/approve') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (typeof body.ticket !== 'string') return json(res, { error: 'ticket required' }, 400);
      const r = await approveMerge({ ticket: body.ticket });
      return json(res, r, r.ok ? 200 : 409);
    }
    // Project map buttons. The path must be a project folder listProjects() would return now (findProject
    // checks without git), so the browser can only ever open a known project folder, and only in one of
    // the three named apps.
    if (url.pathname === '/api/project/open') {
      const body = await actionBody(req, res);
      if (!body) return;
      const { path, app } = body;
      if (typeof path !== 'string' || !['herdr', 'bash', 'vscode'].includes(app)) return json(res, { error: 'path and app (herdr, bash or vscode) required' }, 400);
      const project = await findProject(path);
      if (!project) return json(res, { ok: false, reason: 'not a known project' }, 404);
      const r = app === 'herdr' ? await openInHerdr(project, { snapshot: herdrSnapshot, run: herdr, raise: raiseHerdrWindow, raiseClient: raiseHerdrClient, gitDir: GIT_DIR, raiseClass: raiseClassWindow })
        : app === 'bash' ? await openInBash(project, GIT_DIR, { raiseClass: raiseClassWindow })
        : await openInVscode(project, raiseFolderWindow);
      return json(res, r, r.ok ? 200 : 409);
    }
    // Orchestration flows → "restart in herdr", for an epic whose orchestrator session died. The browser
    // names only the epic; lib/resume.mjs works out its run, repo, permission mode and command.
    if (url.pathname === '/api/runs/restart') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (typeof body.epic !== 'string') return json(res, { error: 'epic required' }, 400);
      const r = await restartOrchestrator(body.epic, {
        runs: () => listRuns(),
        orchestrators: async () => listOrchestrators(await listSessions(), await herdrSnapshot()),
        repos: async () => (await runLocations()).repos,
        findProject,
        start: (project, how) => startInHerdr(project, how, { snapshot: herdrSnapshot, run: herdr, gitDir: GIT_DIR, raiseClass: raiseClassWindow, headless: HEADLESS }),
      });
      return json(res, r, r.ok ? 200 : 409);
    }
    // Herdr panel → update: installs the version herdr's own check found and restarts its servers, only at a
    // pause (lib/herdr-update.mjs). The browser sends nothing but the request.
    if (url.pathname === '/api/herdr/update') {
      const body = await actionBody(req, res);
      if (!body) return;
      const r = await updateHerdr();
      herdrVersionsCached.reset();
      return json(res, HEADLESS ? { ...r, headless: true } : r, r.ok ? 200 : 409);
    }
    // Restart (＋ Panels → Restart server): exit with RESTART_CODE once the reply is sent, and
    // scripts/launch.sh starts the server again in the same window. Started any other way, nothing
    // would bring it back, so it refuses.
    if (url.pathname === '/api/restart') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (!process.env.MC_SUPERVISED) return json(res, { ok: false, reason: "Not started by the launcher, so nothing would start it again: restart it by hand" }, 409);
      res.on('finish', () => process.exit(RESTART_CODE));
      return json(res, { ok: true, boot: BOOT });
    }
    // Stop (＋ Panels → Stop server): exit once the reply is sent. Under scripts/launch.sh any exit but
    // RESTART_CODE ends the script, so its window closes too.
    if (url.pathname === '/api/stop') {
      const body = await actionBody(req, res);
      if (!body) return;
      res.on('finish', () => process.exit(0));
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/run-file') {
      const q = url.searchParams;
      return text(res, await readRunFile(q.get('epic'), q.get('ticket'), q.get('name')));
    }
    const rel = VENDOR[url.pathname] ?? join('public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (rel.includes('..')) return json(res, { error: 'not found' }, 404);
    const body = await readFile(join(HERE, rel)).catch(() => null);
    if (!body) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, HOST, () => console.log(`Cleon → http://${HOST}:${PORT}`));
  if (!EXCLUDE_SRC) console.warn('MC_EXCLUDE is not set in .env: nothing is kept out of the knowledge graph or file tiles.');
  for (const r of PEERS_REFUSED) console.warn(`MC_PEERS: refused "${r.entry}": ${r.reason}. It is never contacted.`);
  for (const p of PEERS.filter(p => p.url)) {
    console.log(`Peer ${p.name} → ${p.url}`);
    for (const path of ['/api/sessions', '/api/runs', '/api/attention', '/api/herdr']) p.get(path); // first answers arrive before the page's first poll asks
  }
  startTunnels().catch(e => console.warn(`MC_PEERS: couldn't start the SSH tunnels: ${e.message}`));
  watchDockerEvents();
}

// The tunnels for ssh://<host> peers. Each keeps the local port it had last time (the peer's page keeps its
// address), and any ssh a killed Cleon left behind is ended first. Recorded per Cleon port, so a test Cleon on
// this machine never touches these. They end with this server: on exit (Stop and Restart server), Ctrl+C, or a
// signal; closing Cleon's window takes them down with it.
async function startTunnels() {
  const wanted = PEER_LIST.filter(p => p.ssh);
  if (!wanted.length) return;
  const file = join(HERE, 'data', `peer-tunnels-${PORT}.json`);
  const saved = await readTunnels(file);
  const ended = await killOrphans(saved);
  for (const name of ended) console.log(`Peer ${name}: ended the ssh tunnel a previous Cleon left running`);
  // An ended ssh lets go of its port a moment later: wait briefly, so the peer keeps its address.
  const freeSoon = async port => { for (let i = 0; i < 6; i++) { if (await portFree(port)) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
  const state = {};
  process.on('exit', () => { for (const t of TUNNELS.values()) t.stop(); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1)));
  for (const { name, ssh } of wanted) {
    const peer = PEERS.find(p => p.name === name);
    const last = saved[name]?.port;
    const port = Number.isInteger(last) && await (ended.includes(name) ? freeSoon(last) : portFree(last)) ? last : await freePort();
    const at = p => `http://127.0.0.1:${p}`;
    peer.retarget(at(port));
    const t = supervise({ target: ssh, port }, {
      env: cleanEnv(process.env), newPort: freePort,
      onPid: (pid, p) => { state[name] = { pid, port: p }; writeTunnels(file, state); },
      onPort: p => { peer.retarget(at(p)); console.log(`Peer ${name}: its port was taken; the tunnel moved to ${at(p)}`); },
    });
    TUNNELS.set(name, t);
    t.start();
    console.log(`Peer ${name} → ssh ${ssh}, forwarded to ${at(port)}`);
  }
}
