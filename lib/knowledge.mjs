// Knowledge index: each project's own documents, as the tree the Knowledge panel drills into one level at a time:
// root → category → project → group (docs & decisions, comms & meetings, outputs, Claude memory) → item. An item is
// one document, or a thread of dated versions of one (a reply redrafted over several days), newest first.
//
// Privacy: paths matching MC_EXCLUDE (projects, folders, files, memory stores) never enter the tree or the file
// index. /api/file reads only through that index, by id, never by path.
import { readdir, stat, open } from 'node:fs/promises';
import { join, resolve, dirname, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';

import { ROOT, EXCLUDE, KNOWLEDGE_FOLDERS_SRC } from './config.mjs';
import { categories as listCategories } from './projects.mjs';

export const GROUPS = { docs: 'Docs & decisions', comms: 'Comms & meetings', outputs: 'Outputs', memory: 'Claude memory' };
// Folder names (matched at any depth, in any case) that put a file in a group. MC_KNOWLEDGE_FOLDERS can replace a list.
const FOLDERS = { docs: ['docs', 'adrs', 'decisions'], comms: ['communications', 'meetings', 'transcripts'], outputs: ['output', 'outputs', 'reports'] };
// A project's own notes at its top level count as docs too.
const ROOT_DOCS = new Set(['claude.md', 'readme.md', 'changelog.md', 'learnings.md']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'venv', '__pycache__', 'target', 'coverage']);
// Documents only: generated output (one project's output/ holds thousands of .xml files), code, logs and images stay out.
const DOC_TYPES = new Set(['md', 'markdown', 'txt', 'html', 'htm', 'mht', 'mhtml', 'pdf', 'vtt', 'eml', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'csv']);
const ADR_DIRS = new Set(['adrs', 'adr', 'decisions', 'decision']);
// Past CAP files in one group of one project, the rest are left out and the group says "400+".
const MAX_DEPTH = 8, CAP = 400;

// Pure: MC_KNOWLEDGE_FOLDERS (`docs=docs,adrs;comms=meetings;outputs=reports`) → each group's folder names, lowercased.
// A group named there gets exactly that list; the others keep their defaults. Unknown groups are ignored.
export function parseFolders(src) {
  const out = Object.fromEntries(Object.entries(FOLDERS).map(([g, names]) => [g, [...names]]));
  for (const part of (src ?? '').split(';')) {
    const m = part.match(/^\s*([a-z]+)\s*=(.*)$/i), g = m?.[1].toLowerCase();
    if (g && Object.hasOwn(out, g)) out[g] = m[2].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  return out;
}

const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const norm = p => resolve(p).replace(/\\/g, '/');
// The id a file is asked for by: the same file gets the same id across rebuilds and restarts.
export const fileId = p => `f${sha(norm(p))}`;

// A date in a file name, and a letter right after it that marks another version that day (2026-08-11b).
const DATE = /(?<!\d)(\d{4}-\d{2}-\d{2})(?:([a-z])(?![a-z0-9]))?(?!\d)/i;
const DRAFT = /(^|[-_ .])draft(?=$|[-_ .])/i, DRAFTS = new RegExp(DRAFT.source, 'gi');
// One document saved as Markdown one day and as HTML the next is still one thread.
const TEXT_DOC = new Set(['md', 'markdown', 'html', 'htm']);

// Pure: a file name's place in a thread. Files in one folder whose names differ only by a YYYY-MM-DD date, a letter
// right after it, a draft marker, or .md/.html/.htm share a `key`; `rest` is the name without those. A name that is
// nothing but a date (and draft marker) folds with nothing.
export function threadOf(name) {
  const ext = extname(name), x = ext.slice(1).toLowerCase();
  let rest = name.slice(0, name.length - ext.length);
  const m = rest.match(DATE);
  if (m) rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
  const draft = DRAFT.test(rest);
  rest = rest.replace(DRAFTS, '$1').replace(/([-_ .])[-_ .]+/g, '$1').replace(/^[-_ .]+|[-_ .]+$/g, '');
  return { key: rest ? `${rest.toLowerCase()}.${TEXT_DOC.has(x) ? 'doc' : x}` : `=${name}`, rest, date: m?.[1] ?? null, suffix: m?.[2]?.toLowerCase() ?? '', draft };
}

// An ADR's status, from its first 40 lines: front matter `status:`, a `Status:` field (bold or not, in a list, or
// inline after a "·"), or the line under a `## Status` heading. Prose and table headers that merely say "Status" don't count.
const STATUS_FIELD = /(?:^\s*(?:>\s*)?(?:[-*+]\s+|#{1,6}\s+)?|·\s*)(?:\*\*|__)?status(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*([^·|]+)/i;
const STATUS_HEAD = /^\s*#{1,6}\s*status\s*$/i;
const cleanStatus = s => {
  const t = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|[*`~]/g, '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '').trim();
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
};
export function adrStatus(text) {
  const lines = (text ?? '').split(/\r?\n/).slice(0, 40);
  for (const [i, line] of lines.entries()) {
    const m = line.match(STATUS_FIELD);
    if (m && cleanStatus(m[1])) return cleanStatus(m[1]);
    if (STATUS_HEAD.test(line)) {
      const next = lines.slice(i + 1).find(l => l.trim());
      if (next && !/^\s*#/.test(next)) return cleanStatus(next.replace(/^\s*[-*+]\s+/, '')) || null;
    }
  }
  return null;
}

// The first few KB of a file: enough for an ADR's first 40 lines.
async function head(p, bytes = 8192) {
  const fh = await open(p).catch(() => null);
  if (!fh) return '';
  try { const { buffer, bytesRead } = await fh.read(Buffer.alloc(bytes), 0, bytes, 0); return buffer.toString('utf8', 0, bytesRead); }
  finally { await fh.close(); }
}

// Claude Code keeps a project's memory under ~/.claude/projects/<slug>, the slug being its folder's path with every
// character but letters and digits turned into "-" (C:\dev\tools\acme → C--dev-tools-acme).
const slugOf = p => resolve(p).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
// The folder under `dir` whose slug is `rest` (what a nested repo's store adds to its project's slug), or null. Every
// "-" may be a folder boundary, so each way of splitting it is tried, but only on folders that are there: a store left
// by a deleted folder, or by a sibling (acme-portal-old beside acme-portal), names none.
async function folderOf(dir, rest, depth = 0) {
  if (!rest) return dir;
  if (depth >= MAX_DEPTH) return null;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const s = e.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const found = e.isDirectory() && (rest === s || rest.startsWith(`${s}-`)) && await folderOf(join(dir, e.name), rest.slice(s.length + 1), depth + 1);
    if (found) return found;
  }
  return null;
}
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Newest first: the later date (an undated file goes by its modified day), then the later letter that day, then the
// final over a draft, then the later modified time.
const newer = (a, b) => b.day.localeCompare(a.day) || b.suffix.localeCompare(a.suffix) || a.draft - b.draft || b.mtime - a.mtime;
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// Every document under a project that belongs to a group: a top-level note, or a file under one of a group's folders
// (the nearest such folder up decides). Hidden, dependency and build folders are skipped; links (junctions included)
// are neither files nor folders to readdir, so they're never followed.
async function walk(dir, rel, group, depth, ctx) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (ctx.exclude.test(p)) continue;
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase()))
        await walk(p, r, ctx.folders.get(e.name.toLowerCase()) ?? group, depth + 1, ctx);
    } else if (e.isFile()) {
      const g = group ?? (depth === 0 && ROOT_DOCS.has(e.name.toLowerCase()) ? 'docs' : null);
      if (g && DOC_TYPES.has(extname(e.name).slice(1).toLowerCase())) ctx.add(g, p, r);
    }
  }
}

// One group's files → its items: threads folded per folder, each named, dated and (in a decisions folder) given its status.
async function items(g, list, files) {
  const threads = new Map(), stats = await Promise.all(list.map(f => stat(f.path).catch(() => null)));
  for (const [i, f] of list.entries()) {
    const name = basename(f.path), t = threadOf(name), mtime = Math.round(stats[i]?.mtimeMs ?? 0);
    const k = `${norm(dirname(f.path))}\0${t.key}`;
    if (!threads.has(k)) threads.set(k, []);
    threads.get(k).push({ ...f, name, mtime, ext: extname(name).slice(1).toLowerCase(), rest: t.rest, day: t.date ?? localDay(mtime), suffix: t.suffix, draft: t.draft });
    files.set(fileId(f.path), f.path);
  }
  const out = [];
  for (const [k, vs] of threads) {
    vs.sort(newer);
    const top = vs[0];
    const it = { id: `t${sha(k)}`, kind: 'item', name: vs.length > 1 ? top.rest : top.name, file: fileId(top.path), rel: top.rel, ext: top.ext, mtime: top.mtime };
    if (['md', 'markdown'].includes(top.ext) && top.rel.split('/').slice(0, -1).some(s => ADR_DIRS.has(s.toLowerCase()))) {
      const status = adrStatus(await head(top.path));
      if (status) it.status = status;
    }
    if (top.draft) it.draft = true;
    if (vs.length > 1) it.versions = vs.map(v => ({ file: fileId(v.path), name: v.name, mtime: v.mtime, ...(v.draft ? { draft: true } : {}) }));
    out.push([it, top]);
  }
  // Comms and outputs read newest first; docs and memory by name.
  out.sort(g === 'comms' || g === 'outputs' ? (a, b) => newer(a[1], b[1]) : (a, b) => byName(a[0], b[0]));
  return out.map(([it]) => it);
}

// The tree, and the only files /api/file may read: Map<file id, absolute path>. Defaults are this machine's settings;
// tests pass their own.
export async function buildIndex({ root = ROOT, categories, exclude = EXCLUDE, memoryRoot = join(os.homedir(), '.claude', 'projects'),
  folders = parseFolders(KNOWLEDGE_FOLDERS_SRC) } = {}) {
  const folderGroup = new Map();
  for (const [g, names] of Object.entries(folders)) for (const n of names) if (!folderGroup.has(n)) folderGroup.set(n, g);
  const tree = { id: 'root', kind: 'root', name: basename(resolve(root)) || root, count: 0, children: [] };
  const projects = [], files = new Map();
  for (const cat of categories ?? await listCategories(root)) {
    const cdir = join(root, cat);
    if (exclude.test(cdir)) continue;
    const dirs = (await readdir(cdir, { withFileTypes: true }).catch(() => []))
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !exclude.test(join(cdir, d.name)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const c = { id: `c:${cat}`, kind: 'cat', name: cat, count: dirs.length, children: [] };
    for (const d of dirs) {
      const path = join(cdir, d.name), found = { docs: [], comms: [], outputs: [], memory: [] }, more = {};
      const add = (g, p, rel) => { if (found[g].length < CAP) found[g].push({ path: p, rel }); else more[g] = true; };
      await walk(path, '', null, 0, { exclude, folders: folderGroup, add });
      const node = { id: `p:${path}`, kind: 'proj', name: d.name, category: cat, path, count: 0, children: [] };
      projects.push({ node, slug: slugOf(path), found, more, add });
      c.children.push(node);
    }
    tree.count += c.count;
    tree.children.push(c);
  }
  // Memory stores: each hangs under the project whose slug is the store's, or under the project holding the folder the
  // store is for (a nested repo's store counts toward its project). That folder must be there, and MC_EXCLUDE is tested
  // on its path too: a slug has "-" where the path has "\" or ".", so a pattern written for the path misses the store's
  // own name. A store no project claims is left out.
  for (const s of await readdir(memoryRoot, { withFileTypes: true }).catch(() => [])) {
    const dir = join(memoryRoot, s.name, 'memory'), slug = s.name.toLowerCase();
    if (!s.isDirectory() || exclude.test(dir)) continue;
    let owner = null, folder = null;
    for (const p of projects.filter(p => slug === p.slug || slug.startsWith(`${p.slug}-`)).sort((a, b) => b.slug.length - a.slug.length)) {
      if ((folder = await folderOf(p.node.path, slug.slice(p.slug.length + 1)))) { owner = p; break; }
    }
    if (!owner || exclude.test(folder)) continue;
    for (const f of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, f.name);
      if (f.isFile() && /\.md$/i.test(f.name) && f.name !== 'MEMORY.md' && !exclude.test(p)) owner.add('memory', p, `${s.name}/memory/${f.name}`);
    }
  }
  for (const { node, found, more } of projects) {
    for (const g of Object.keys(GROUPS)) {
      const children = await items(g, found[g], files);
      node.children.push({ id: `g:${node.path}#${g}`, kind: 'group', group: g, name: GROUPS[g], count: children.length, ...(more[g] ? { more: true } : {}), children });
      node.count += children.length;
    }
  }
  return { tree, files };
}
