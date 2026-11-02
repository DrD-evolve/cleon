// Cleon — local-only dashboard server. Binds to 127.0.0.1; no auth, no cloud calls.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions } from './lib/sessions.mjs';
import { herdrSnapshot, herdrFocus, paneForPid, agentForSession, panePids, herdr } from './lib/herdr.mjs';
import { raiseHerdrWindow, raiseCwdWindow, raiseFolderWindow, raiseClassWindow, raiseHerdrClient } from './lib/vscode.mjs';
import { focusSession } from './lib/focus.mjs';
import { listOrchestrators, listWorkers } from './lib/orchestrators.mjs';
import { sampleResources } from './lib/resources.mjs';
import { EXCLUDE_SRC } from './lib/config.mjs';
import { sampleDocker, pruneDocker, removeImage, watchDockerEvents } from './lib/docker.mjs';
import { listAttention } from './lib/attention.mjs';
import { answerGate } from './lib/gate.mjs';
import { EXCLUDE, GIT_DIR } from './lib/config.mjs';
import { execFile } from 'node:child_process';
import { taskOutput } from './lib/tasks.mjs';
import { listSessionPrs } from './lib/sessionprs.mjs';
import { listRuns, readRunFile } from './lib/runs.mjs';
import { buildGraph } from './lib/graph.mjs';
import { listProjects, projectMap } from './lib/projects.mjs';
import { openInHerdr, openInBash, openInVscode } from './lib/open.mjs';
import { linearIssues } from './lib/linear.mjs';
import { scmSummary, scmName, prChecks, prNumber } from './lib/scm.mjs';
import { processMetrics } from './lib/metrics.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// .env is loaded by lib/config.mjs, imported (through the lib modules) before this line runs.

// Remote APIs are cached so several open tabs don't multiply calls.
const cached = (fn, ttlMs) => {
  let at = 0, value;
  return async () => (Date.now() - at < ttlMs ? value : (value = await fn(), at = Date.now(), value));
};
const linearCached = cached(() => linearIssues(), 60_000);
// GitHub or Bitbucket (MC_SCM); `scm` names it for the tab label.
const githubCached = cached(async () => ({ scm: scmName, ...await scmSummary() }), 60_000);
// CI checks, per check: in-flight tickets (not done, not stale) keyed by ticket, plus your own open
// PRs whose CI is pending or failing keyed "pr:<url>", so a PR outside any orchestration (a session
// working by hand) shows its jobs and mutation progress too.
const checksCached = cached(async () => {
  const { runs } = await listRuns();
  const live = runs.flatMap(r => r.tickets).filter(t => t.pr && t.step !== 'done' && !t.stale);
  const mine = ((await githubCached())?.myPrs ?? []).filter(p => p.checks === 'pending' || p.checks === 'failing');
  const out = {};
  await Promise.all([
    ...live.map(async t => { const c = await prChecks(t.pr); if (c) out[t.ticket] = c; }),
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
      const labels = new Map((await listSessions()).filter(s => s.alive).map(s => [s.pid, `Claude · ${s.name}`]));
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
    metricsRunning = listRuns().then(({ runs }) => processMetrics(runs)).then(m => (metricsLast = m)).finally(() => { metricsRunning = null; });
  return metricsLast ?? metricsRunning;
}
// Background tasks' progress: the tail of each listed task's output file, attached in place.
// Agent tasks are left out: a subagent's progress is its own activity feed.
const listedTasks = (orch, workers) => [...orch.flatMap(o => o.tasks),
  ...Object.values(workers).flatMap(w => [...w.tasks, ...w.subagents.flatMap(s => s.tasks)])].filter(k => k.kind !== 'agent');
async function withProgress(orch, workers) {
  await Promise.all(listedTasks(orch, workers).map(async k => { k.out = await taskOutput(k.id); }));
}
async function orchestrators() {
  const o = await listOrchestrators(await listSessions(), await herdrSnapshot());
  await withProgress(o, {});
  return o;
}
async function workers() {
  const w = await listWorkers((await listRuns()).runs, await herdrSnapshot(), await listSessions());
  await withProgress([], w);
  return w;
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
// CI is mentioned only while it's part of the merge: checks still running or failing. With no CI, or
// CI already green, the prompt just says merge.
export const mergePrompt = (pr, ticket, ciGate) => `Merge PR #${pr} for ${ticket}${ciGate ? ' when its CI is green' : ''}.`;
// Pure: does this PR's CI still stand between it and a merge? `checks` is the checks feed entry.
export const ciGates = checks => Boolean(checks?.checks?.some(k => ['pending', 'fail', 'cancel'].includes(k.bucket)));
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
  const text = mergePrompt(pr, ticket, ciGates((await checksCached())[ticket]));
  const r = await herdrCall(['--session', o.pane.herdr, 'agent', 'prompt', o.pane.id, text]);
  if (!r.ok) {
    const code = (() => { try { return JSON.parse(r.out).error?.code; } catch { return null; } })();
    return { ok: false, reason: code === 'agent_blocked' ? 'the orchestrator is waiting on a question; answer that first' : `herdr refused: ${code ?? r.reason}` };
  }
  return { ok: true, sent: text };
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
  const host = req.headers.host ?? '';
  if (req.method !== 'POST' || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers.origin !== `http://${host}`
    || !req.headers['content-type']?.startsWith('application/json')) { json(res, { error: 'forbidden' }, 403); return null; }
  let body = '';
  for await (const c of req) { body += c; if (body.length > max) { json(res, { error: 'too large' }, 413); return null; } }
  try { return JSON.parse(body || '{}'); } catch { json(res, { error: 'bad json' }, 400); return null; }
}

const routes = {
  '/api/sessions': async () => listSessions(),
  '/api/session-prs': async () => listSessionPrs(await listSessions(), (await githubCached())?.myPrs),
  '/api/herdr': async () => herdrSnapshot(),
  '/api/runs': async () => listRuns(),
  '/api/projects': async () => listProjects(),
  '/api/projmap': async () => projectMap(),
  '/api/linear': linearCached,
  '/api/github': githubCached,
  '/api/checks': checksCached,
  '/api/resources': resources,
  '/api/docker': () => docker(),
  '/api/metrics': () => metrics(),
  '/api/orchestrators': orchestrators,
  '/api/attention': async () => listAttention(await listSessions(), await herdrSnapshot()),
  '/api/workers': workers,
  '/api/boot': async () => ({ boot: BOOT }),
  '/api/graph': async q => { const { nodes, links } = await getGraph(q.get('refresh') === '1'); return { nodes, links }; },
};

// The exit code that asks scripts/launch.sh (which sets MC_SUPERVISED) to start the server again.
export const RESTART_CODE = 75;
// This process's start, so the page can tell the restarted server from the one that's exiting.
const BOOT = Date.now();

// Every request must name a loopback host (or MC_HOST), so a DNS-rebound page can't read the API either.
const hostOk = host => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || host.replace(/:\d+$/, '') === HOST;

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!hostOk(req.headers.host ?? '')) return json(res, { error: 'forbidden' }, 403);
  try {
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
      const r = await herdrFocus({ pane, workspace, label }, undefined, raiseHerdrWindow);
      return json(res, r, r.ok ? 200 : 409);
    }
    if (url.pathname === '/api/session/focus') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (typeof body.id !== 'string') return json(res, { error: 'id required' }, 400);
      const r = await focusSession(body.id, {
        sessions: listSessions, snapshot: herdrSnapshot, raiseCwd: raiseCwdWindow, paneForPid: pid => paneForPid(pid),
        focusPane: t => herdrFocus(t, undefined, raiseHerdrWindow),
      });
      return json(res, r, r.ok ? 200 : 409);
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
      const listed = listedTasks(await listOrchestrators(await listSessions(), await herdrSnapshot()),
        await listWorkers((await listRuns()).runs, await herdrSnapshot(), await listSessions()));
      if (!listed.some(k => k.id === id)) return json(res, { error: 'not a listed task' }, 404);
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
    // Project map buttons. The path must be one listProjects() returns now, so the browser can only
    // ever open a known project folder, and only in one of the three named apps.
    if (url.pathname === '/api/project/open') {
      const body = await actionBody(req, res);
      if (!body) return;
      const { path, app } = body;
      if (typeof path !== 'string' || !['herdr', 'bash', 'vscode'].includes(app)) return json(res, { error: 'path and app (herdr, bash or vscode) required' }, 400);
      const project = (await listProjects()).find(p => p.path === path);
      if (!project) return json(res, { ok: false, reason: 'not a known project' }, 404);
      const r = app === 'herdr' ? await openInHerdr(project, { snapshot: herdrSnapshot, run: herdr, raise: raiseHerdrWindow, raiseClient: raiseHerdrClient, gitDir: GIT_DIR, raiseClass: raiseClassWindow })
        : app === 'bash' ? await openInBash(project, GIT_DIR, { raiseClass: raiseClassWindow })
        : await openInVscode(project, raiseFolderWindow);
      return json(res, r, r.ok ? 200 : 409);
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
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, HOST, () => console.log(`Cleon → http://${HOST}:${PORT}`));
  if (!EXCLUDE_SRC) console.warn('MC_EXCLUDE is not set in .env: nothing is kept out of the knowledge graph or file tiles.');
  watchDockerEvents();
}
