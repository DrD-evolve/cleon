// Mission Control — local-only dashboard server. Binds to 127.0.0.1; no auth, no cloud calls.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions } from './lib/sessions.mjs';
import { herdrSnapshot, herdrFocus, paneForPid } from './lib/herdr.mjs';
import { raiseHerdrWindow, raiseCwdWindow } from './lib/vscode.mjs';
import { focusSession } from './lib/focus.mjs';
import { listOrchestrators, listWorkers } from './lib/orchestrators.mjs';
import { sampleResources } from './lib/resources.mjs';
import { EXCLUDE_SRC } from './lib/config.mjs';
import { sampleDocker, pruneDocker, removeImage, watchDockerEvents } from './lib/docker.mjs';
import { listAttention } from './lib/attention.mjs';
import { taskOutput } from './lib/tasks.mjs';
import { listRuns, readRunFile } from './lib/runs.mjs';
import { buildGraph } from './lib/graph.mjs';
import { listProjects } from './lib/projects.mjs';
import { linearIssues } from './lib/linear.mjs';
import { githubSummary, prChecks } from './lib/github.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// .env is loaded by lib/config.mjs, imported (through the lib modules) before this line runs.

// Remote APIs are cached so several open tabs don't multiply calls.
const cached = (fn, ttlMs) => {
  let at = 0, value;
  return async () => (Date.now() - at < ttlMs ? value : (value = await fn(), at = Date.now(), value));
};
const linearCached = cached(() => linearIssues(), 60_000);
const githubCached = cached(() => githubSummary(), 60_000);
// CI checks for in-flight tickets only (not done, not stale), keyed by ticket.
const checksCached = cached(async () => {
  const { runs } = await listRuns();
  const live = runs.flatMap(r => r.tickets).filter(t => t.pr && t.step !== 'done' && !t.stale);
  const out = {};
  await Promise.all(live.map(async t => { const c = await prChecks(t.pr); if (c) out[t.ticket] = c; }));
  return out;
}, 30_000);
// System resources: sampled at most every 8s and never twice at once (a sample takes ~3s).
// Only requested while the Resources panel is on the board, so nothing runs when it's closed.
let resLast = null, resRunning = null;
async function resources() {
  if (!resRunning && (!resLast || Date.now() - resLast.at > 8000)) {
    resRunning = (async () => {
      const labels = new Map((await listSessions()).filter(s => s.alive).map(s => [s.pid, `Claude · ${s.name}`]));
      labels.set(process.pid, 'Mission Control server');
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
async function actionBody(req, res) {
  const host = req.headers.host ?? '';
  if (req.method !== 'POST' || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || req.headers.origin !== `http://${host}`
    || !req.headers['content-type']?.startsWith('application/json')) { json(res, { error: 'forbidden' }, 403); return null; }
  let body = '';
  for await (const c of req) { body += c; if (body.length > 1024) { json(res, { error: 'too large' }, 413); return null; } }
  try { return JSON.parse(body || '{}'); } catch { json(res, { error: 'bad json' }, 400); return null; }
}

const routes = {
  '/api/sessions': async () => listSessions(),
  '/api/herdr': async () => herdrSnapshot(),
  '/api/runs': async () => listRuns(),
  '/api/projects': async () => listProjects(),
  '/api/linear': linearCached,
  '/api/github': githubCached,
  '/api/checks': checksCached,
  '/api/resources': resources,
  '/api/docker': () => docker(),
  '/api/orchestrators': orchestrators,
  '/api/attention': async () => listAttention(await listSessions(), await herdrSnapshot()),
  '/api/workers': workers,
  '/api/graph': async q => { const { nodes, links } = await getGraph(q.get('refresh') === '1'); return { nodes, links }; },
};

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
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
  server.listen(PORT, HOST, () => console.log(`Mission Control → http://${HOST}:${PORT}`));
  if (!EXCLUDE_SRC) console.warn('MC_EXCLUDE is not set in .env: nothing is kept out of the knowledge graph or file tiles.');
  watchDockerEvents();
}
