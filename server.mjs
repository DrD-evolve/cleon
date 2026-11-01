// Mission Control — local-only dashboard server. Binds to 127.0.0.1; no auth, no cloud calls.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions } from './lib/sessions.mjs';
import { herdrSnapshot, herdrFocus } from './lib/herdr.mjs';
import { raiseHerdrWindow, raiseCwdWindow } from './lib/vscode.mjs';
import { focusSession } from './lib/focus.mjs';
import { listOrchestrators } from './lib/orchestrators.mjs';
import { listRuns, readRunFile } from './lib/runs.mjs';
import { buildGraph } from './lib/graph.mjs';
import { listProjects } from './lib/projects.mjs';
import { linearIssues } from './lib/linear.mjs';
import { githubSummary, prChecks } from './lib/github.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
try { process.loadEnvFile(join(HERE, '.env')); } catch { /* no .env — Linear shows as not configured */ }

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
const HOST = process.env.MC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MC_PORT ?? 4317);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
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
  '/api/orchestrators': async () => listOrchestrators(await listSessions(), await herdrSnapshot()),
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
        sessions: listSessions, snapshot: herdrSnapshot, raiseCwd: raiseCwdWindow,
        focusPane: t => herdrFocus(t, undefined, raiseHerdrWindow),
      });
      return json(res, r, r.ok ? 200 : 409);
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
}
