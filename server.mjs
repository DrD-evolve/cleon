// Mission Control — local-only dashboard server. Binds to 127.0.0.1; no auth, no cloud calls.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions } from './lib/sessions.mjs';
import { herdrSnapshot } from './lib/herdr.mjs';
import { listRuns, readRunFile } from './lib/runs.mjs';
import { buildGraph } from './lib/graph.mjs';
import { listProjects } from './lib/projects.mjs';
import { linearIssues } from './lib/linear.mjs';
import { githubSummary } from './lib/github.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
try { process.loadEnvFile(join(HERE, '.env')); } catch { /* no .env — Linear shows as not configured */ }

// Remote APIs are cached so several open tabs don't multiply calls.
const cached = (fn, ttlMs) => {
  let at = 0, value;
  return async () => (Date.now() - at < ttlMs ? value : (value = await fn(), at = Date.now(), value));
};
const linearCached = cached(() => linearIssues(), 60_000);
const githubCached = cached(() => githubSummary(), 60_000);
const HOST = process.env.MC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MC_PORT ?? 4317);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const VENDOR = {
  '/vendor/3d-force-graph.min.js': 'node_modules/3d-force-graph/dist/3d-force-graph.min.js',
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

const routes = {
  '/api/sessions': async () => listSessions(),
  '/api/herdr': async () => herdrSnapshot(),
  '/api/runs': async () => listRuns(),
  '/api/projects': async () => listProjects(),
  '/api/linear': linearCached,
  '/api/github': githubCached,
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
