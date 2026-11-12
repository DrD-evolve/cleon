// The project page's archive-readiness facts, from this machine's config and home only. Nothing here returns text from a
// file: every reader gives a boolean, a count, a time or a fixed label.
//   walkActivity, memoryFolder  take only readdir and lstat, so they have no means to open a file (and are tested so).
//   readMcp                     reads ~/.claude.json and keeps nothing but each server's command and args.
//   readMentionTexts            reads CLAUDE.md, the workspace files and the optional project list; the page gets booleans.
import { readdir as fsReaddir, lstat as fsLstat, readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from './bin.mjs'; // not node's: see bin.mjs
import { excludesFolder, excludesPath } from './config.mjs';
import { cached } from './shared.mjs';

export const WALK_MAX_ENTRIES = 20_000, WALK_MAX_DEPTH = 12, WALK_BUDGET_MS = 2000;
const WALK_SKIP = new Set(['.git', 'node_modules', '.venv']);

// Last real file activity and whether a `.env*` entry exists, in one breadth-first walk from the project folder. Names,
// types and modified times only (readdir and lstat; `fs` needs nothing else). A link or junction is never followed.
// Skipped: `.git`, `node_modules` and `.venv` at any depth, the project's own `.claude/settings.json` (a tool rewrites it),
// and whatever `exclude` matches. `at`: the newest modified time of a file (null when there is none). `partial`: a cap
// (entries, depth, time) ended the walk early.
export async function walkActivity(dir, { readdir = fsReaddir, lstat = fsLstat } = {}, { exclude, now = Date.now, maxEntries = WALK_MAX_ENTRIES, maxDepth = WALK_MAX_DEPTH, budgetMs = WALK_BUDGET_MS } = {}) {
  const t0 = now(), skipped = p => excludesFolder(p, exclude);
  let at = null, env = false, partial = false, seen = 0;
  const queue = [{ path: dir, rel: '', depth: 0 }];
  while (queue.length) {
    const { path, rel, depth } = queue.shift();
    if (now() - t0 > budgetMs) { partial = true; break; }
    const list = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (!list) continue;
    for (const d of list) {
      const full = join(path, d.name), here = rel ? `${rel}/${d.name}` : d.name;
      if (skipped(full)) continue;
      if (++seen > maxEntries) { partial = true; break; }
      if (/^\.env/i.test(d.name)) env = true;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (WALK_SKIP.has(d.name.toLowerCase())) continue;
        if (depth + 1 > maxDepth) partial = true; else queue.push({ path: full, rel: here, depth: depth + 1 });
      } else if (d.isFile() && here.toLowerCase() !== '.claude/settings.json') {
        const st = await lstat(full).catch(() => null);
        if (st?.isFile() && Number.isFinite(st.mtimeMs) && (at === null || st.mtimeMs > at)) at = Math.round(st.mtimeMs);
      }
    }
    if (partial && seen > maxEntries) break;
  }
  return { at, partial, env };
}
// The walk, shared for 60 s per project (a page load costs one).
const walks = new Map();
export function walkCached(path, o) {
  let get = walks.get(path);
  if (!get) walks.set(path, get = cached(() => walkActivity(path, undefined, o), 60_000));
  return get();
}

// Claude Code's project slug: the folder's path with every other character a "-". The folder is matched case-insensitively
// against the names under projects/, so the store is found however the session spelled the drive.
const slugOf = p => resolve(p).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
// Whether ~/.claude/projects/<slug>/memory is a plain folder. readdir and lstat only.
export async function memoryFolder(projectPath, home, { readdir = fsReaddir, lstat = fsLstat } = {}, exclude) {
  const base = join(home, '.claude', 'projects'), slug = slugOf(projectPath);
  const hit = (await readdir(base, { withFileTypes: true }).catch(() => [])).find(d => d.isDirectory() && d.name.toLowerCase() === slug);
  if (!hit) return false;
  const mem = join(base, hit.name, 'memory');
  if (excludesFolder(mem, exclude)) return false;
  return (await lstat(mem).catch(() => null))?.isDirectory() ?? false;
}

// ---------- ~/.claude.json ----------
const MCP_MAX = 32 * 1024 * 1024;
// Pure: the file's text → [{ command, args }], or null when it can't be read as JSON. The reviver returns undefined for
// every key named `env` or `headers`, so no token a server is given survives the parse; only each server's command and
// args are picked (top level and under projects.*), and as strings. An error is never passed on: V8's SyntaxError quotes
// the input.
export function mcpCommands(text) {
  if (typeof text !== 'string') return null;
  try {
    const o = JSON.parse(text, (k, v) => (k === 'env' || k === 'headers' ? undefined : v));
    const out = [], take = servers => {
      if (!servers || typeof servers !== 'object') return;
      for (const s of Object.values(servers)) {
        if (!s || typeof s !== 'object') continue;
        out.push({ command: typeof s.command === 'string' ? s.command : '', args: Array.isArray(s.args) ? s.args.filter(a => typeof a === 'string') : [] });
      }
    };
    take(o?.mcpServers);
    if (o?.projects && typeof o.projects === 'object') for (const p of Object.values(o.projects)) take(p?.mcpServers);
    return out;
  } catch { return null; }
}
const slashes = s => s.replace(/\\+/g, '/').toLowerCase();
// Pure: whether some registration's command or argument holds the project's path, as a path prefix (followed by `/`, a
// quote, whitespace or the end). A server launched by bare name (`npx foo`) can't be matched: a known miss.
export function mcpMatches(cmds, projectPath) {
  const p = slashes(resolve(projectPath));
  const holds = s => { const h = slashes(s); for (let i = h.indexOf(p); i >= 0; i = h.indexOf(p, i + 1)) { if (i + p.length === h.length || /[/"'\s]/.test(h[i + p.length])) return true; } return false; };
  return Array.isArray(cmds) && cmds.some(c => holds(c.command) || c.args.some(holds));
}
// A reader of ~/.claude.json: its commands (or null: absent, too big, unreadable), kept 30 s and re-read when its size or
// time changes. The raw text and the parsed object are gone when it returns.
export function mcpReader(file, { readFile = fsReadFile, stat = fsStat } = {}, ttlMs = 30_000, now = Date.now) {
  let key = '', at = 0, value = null;
  return async () => {
    const st = await stat(file).catch(() => null);
    if (!st?.isFile() || st.size > MCP_MAX) return null;
    const k = `${st.mtimeMs}:${st.size}`;
    if (k === key && now() - at < ttlMs) return value;
    value = mcpCommands(await readFile(file, 'utf8').catch(() => null));
    key = k; at = now();
    return value;
  };
}

// ---------- Mentions ----------
export const MENTION_MAX = 1024 * 1024;
const COMMON = new Set('app api web docs doc test tests tools tool data scripts script src lib libs main core site demo base misc temp tmp work common utils util shared'.split(' '));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Pure: whether a text mentions a project: its absolute path or `<category>/<name>` (slashes unified, lowercase), or its
// name as a whole token (outside [A-Za-z0-9_.-]) when the name is at least four characters and no common word.
export function mentions(text, { path, category, name }) {
  const t = slashes(text), n = name.toLowerCase();
  const pathy = [slashes(resolve(path)), `${category}/${name}`.toLowerCase()];
  if (pathy.some(p => new RegExp(`(?<![a-z0-9_-])${esc(p)}(?![a-z0-9_-])`).test(t))) return true;
  return n.length >= 4 && !COMMON.has(n) && new RegExp(`(?<![a-z0-9_.-])${esc(n)}(?![a-z0-9_.-])`).test(t);
}
// The texts mentions() is asked of: MC_ROOT/CLAUDE.md and ~/.claude/CLAUDE.md (kind claudeMd), each *.code-workspace
// directly under MC_ROOT (workspace) and the project-list file (projectList), as { kind, text }. A file MC_EXCLUDE matches,
// a link, a non-file or one over 1 MB is skipped, so is a read that fails.
export async function readMentionTexts({ root, home, projectList }, { readdir = fsReaddir, lstat = fsLstat, readFile = fsReadFile } = {}, exclude) {
  const files = [[join(root, 'CLAUDE.md'), 'claudeMd'], [join(home, '.claude', 'CLAUDE.md'), 'claudeMd']];
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) if (d.isFile() && /\.code-workspace$/i.test(d.name)) files.push([join(root, d.name), 'workspace']);
  if (projectList) files.push([projectList, 'projectList']);
  const out = [];
  for (const [path, kind] of files) {
    if (excludesPath(path, exclude)) continue;
    const st = await lstat(path).catch(() => null);
    if (!st?.isFile() || st.size > MENTION_MAX) continue;
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text !== null) out.push({ kind, text });
  }
  return out;
}
// Pure: { claudeMd, workspace, projectList } booleans. projectList is null when no project list is set.
export function mentionFlags(texts, project, projectListSet) {
  const has = kind => texts.some(x => x.kind === kind && mentions(x.text, project));
  return { claudeMd: has('claudeMd'), workspace: has('workspace'), projectList: projectListSet ? has('projectList') : null };
}

// ---------- git beyond the status ----------
// Commits on any local branch no remote ref has (covers an unpushed commit and a branch never pushed), and whether the
// repo has a remote at all. Two more git commands, only for a repo, shared 10 s; a failure gives null.
const gitOut = (path, args) => new Promise((ok, fail) => execFile('git', ['-C', path, '-c', 'core.fsmonitor=false', '--no-optional-locks', ...args],
  { timeout: 5000, windowsHide: true }, (e, out) => (e ? fail(e) : ok(out))));
const extras = new Map();
export function gitExtra(path, { run = gitOut, ttlMs = 10_000 } = {}) {
  let get = extras.get(path);
  if (!get) extras.set(path, get = cached(async () => {
    try {
      const [n, remotes] = await Promise.all([run(path, ['rev-list', '--count', '--branches', '--not', '--remotes']), run(path, ['remote'])]);
      return { unpushed: Number.parseInt(n, 10) || 0, remote: remotes.trim() !== '' };
    } catch { return null; }
  }, ttlMs));
  return get();
}

// ---------- Linear and pull requests, from what is already loaded ----------
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Pure: open issues whose project is named like the folder, from the Linear read (null when it isn't loaded or is offline).
export function matchLinear(linear, name) {
  if (!linear?.online || !Array.isArray(linear.issues)) return null;
  const n = norm(name), hit = n ? linear.issues.filter(i => norm(i.project?.name) === n) : [];
  return { open: hit.length, items: hit.slice(0, 5).map(i => ({ id: i.identifier, url: i.url })) };
}
// Pure: your open PRs and review requests (once each, by url) in a repository named like the folder, from the source-control
// read (null when it isn't loaded or is offline). ref: `repo#number`.
export function matchPrs(scm, name) {
  if (!scm?.online) return null;
  const n = norm(name), seen = new Set(), hit = [];
  for (const p of [...(scm.myPrs ?? []), ...(scm.reviewRequests ?? [])]) {
    if (!n || norm(p.repository?.name) !== n || seen.has(p.url)) continue;
    seen.add(p.url);
    hit.push(p);
  }
  return { open: hit.length, items: hit.slice(0, 5).map(p => ({ ref: `${p.repository.name}#${p.number}`, url: p.url })) };
}
