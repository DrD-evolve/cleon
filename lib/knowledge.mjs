// Knowledge index: each project's own documents, as the tree the Knowledge panel's radial map is laid out from:
// root → category → project → group (docs & decisions, comms & meetings, outputs, Claude memory) → item. An item is
// one document, or a thread of dated versions of one (a reply redrafted over several days), newest first.
//
// Knowledge outside every project folder (the vault's pages, and notes in memory stores no project claims) is each
// project's asteroid belt: `belt` on a project node lists the items that orbit it (lib/belts.mjs), and `belt` on the
// root those that orbit no project. The root carries the workspace's own CLAUDE.md (`file`), the map's centre, and
// `links`: the links from one project's documents to another's (lib/belts.mjs linkEdges), both ends in the index.
//
// Privacy: paths matching MC_EXCLUDE (projects, folders, files, memory stores, vault pages) never enter the tree or
// the file index. /api/file reads only through that index, by id, never by path. An excluded project's or category's
// name (`hidden`) is kept out of the quotes and snippets shown from other documents' text, and out of the names and
// paths the tree shows (items, versions, belt items, and so the ends of `links`) (redactor); the viewer shows a
// document as it is. `hidden` itself is never served.
import { readdir, stat, lstat, open, readFile, realpath } from 'node:fs/promises';
import { join, resolve, dirname, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';

import { ROOT, EXCLUDE, KNOWLEDGE_FOLDERS_SRC, VAULT } from './config.mjs';
import { categories as listCategories, firstParagraph } from './projects.mjs';
import { matchItems, projectLinks, linkEdges, titleOf, topicOf, commonDirs, EXCERPT } from './belts.mjs';

export const GROUPS = { docs: 'Docs & decisions', comms: 'Comms & meetings', outputs: 'Outputs', memory: 'Claude memory' };
// Folder names (matched at any depth, in any case) that put a file in a group. MC_KNOWLEDGE_FOLDERS can replace a list.
const FOLDERS = { docs: ['docs', 'adrs', 'decisions'], comms: ['communications', 'meetings', 'transcripts'], outputs: ['output', 'outputs', 'reports'] };
// A project's own notes at its top level count as docs too.
const ROOT_DOCS = new Set(['claude.md', 'readme.md', 'changelog.md', 'learnings.md']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'venv', '__pycache__', 'target', 'coverage']);
// Documents and raster images only: generated output (one project's output/ holds thousands of .xml files), code and
// logs stay out, and so does SVG, which can carry script.
const DOC_TYPES = new Set(['md', 'markdown', 'txt', 'html', 'htm', 'mht', 'mhtml', 'pdf', 'vtt', 'eml', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'csv',
  'png', 'jpg', 'jpeg', 'gif', 'webp']);
const ADR_DIRS = new Set(['adrs', 'adr', 'decisions', 'decision']);
// Past CAP items in one group of one project, the older ones are left out and the group says "400+".
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
const contentHash = s => createHash('sha1').update(s).digest('hex');
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
  catch { return ''; } // opened but unreadable (locked, an offline placeholder): no status, rather than no index
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
// Every folder on disk that `rest` (a slug's remainder below `dir`) may run through, each with what's left of `rest`
// below it: [{ dir, rest }], `dir` itself first. Like folderOf, for a folder that may be partly gone, and on a path that
// may not be spelled the way the folders list themselves. Every way is kept, not only the deepest: with work/hr on disk,
// the store of a deleted work/hr-reviews reaches work/hr too. A link to a folder is followed (only listings are read, to
// find the way: /tmp is one on macOS, and a junction can be one on Windows). On Windows, a part written as an 8.3 short
// name ("RUNNER~1", "ACME-S~1", "UI-3~1.0": a session started on a short path puts one in its slug, and no listing
// shows it) is asked for directly.
const isDir = p => stat(p).then(st => st.isDirectory(), () => false);
async function slugFolders(dir, rest, depth = 0, out = []) {
  out.push({ dir, rest });
  if (!rest || depth >= 16) return out;
  const steps = []; // [folder name, how much of `rest` it takes]
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const s = e.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    if ((rest === s || rest.startsWith(`${s}-`)) && (e.isDirectory() || (e.isSymbolicLink() && await isDir(join(dir, e.name))))) steps.push([e.name, s.length]);
  }
  // A short name: up to six characters ("-" in the slug for its own "-" or "_"), "~", a number, and maybe an extension.
  for (const m of process.platform === 'win32' ? rest.matchAll(/(?<=^[a-z0-9-]{1,6})-(\d{1,6})(?:-([a-z0-9]{1,3}))?(?=-|$)/g) : []) {
    const base = rest.slice(0, m.index), names = [];
    for (const b of new Set([base, base.replace(/-/g, '_')])) {
      names.push([`${b}~${m[1]}`, m.index + 1 + m[1].length]);
      if (m[2]) names.push([`${b}~${m[1]}.${m[2]}`, m.index + m[0].length]);
    }
    for (const [name, n] of names) if (await isDir(join(dir, name))) steps.push([name, n]);
  }
  for (const [name, n] of steps) await slugFolders(join(dir, name), rest.slice(n + 1), depth + 1, out);
  return out;
}
// Pure: each way a slug's remainder may have been written, every "-" read as "-", "/", " ", "." or "_". Past five, every
// "-" is read the same way.
const SEPS = ['-', '/', ' ', '.', '_'], READ_MAX = 5;
export function readings(rest, max = READ_MAX) {
  const parts = rest.split('-');
  if (parts.length - 1 > max) return SEPS.map(c => parts.join(c));
  let out = [parts[0]];
  for (const part of parts.slice(1)) out = out.flatMap(a => SEPS.map(c => `${a}${c}${part}`));
  return out;
}
// Whether MC_EXCLUDE matches the folder a store no project claims was for, or a folder above it (the way the project
// walk skips everything under an excluded folder). A pattern written for a path ("C:/dev/hr notes") misses the store's
// own name (C--dev-hr-notes), so the path is read back: every folder on disk it may run through (slugFolders), each
// tested as found and as its real path (links and short names resolved), then below each, every reading of each folder
// of the part that's gone. A store under MC_ROOT is read back from MC_ROOT as it's configured, the same spelling a
// project's own store is matched by; any other from its drive (C--…) or from / (-…). The name read with every "-" as
// "/", " " or "." is tried too. A gone part with more "-" than readings() reads every way can't be checked, so while
// anything is excluded that store is kept out: better a stray note missing than an excluded one shown.
async function strayExcluded(name, root, exclude) {
  if (SEPS.slice(1).some(c => exclude.test(name.replace(/-/g, c)))) return true;
  const slug = name.toLowerCase(), rs = slugOf(root), m = name.match(/^([a-zA-Z])--(.*)$/);
  const [start, all] = slug === rs ? [root, ''] : slug.startsWith(`${rs}-`) ? [root, name.slice(rs.length + 1)]
    : m ? [`${m[1].toUpperCase()}:/`, m[2]] : name.startsWith('-') ? ['/', name.slice(1)] : [null, ''];
  if (!start) return false;
  const hit = p => exclude.test(p) || exclude.test(p.replace(/\\/g, '/'));
  const found = await slugFolders(start, all.toLowerCase()), dashes = rest => (rest ? rest.split('-').length - 1 : 0);
  for (const { dir, rest } of found) {
    if (dashes(rest) > READ_MAX) continue; // a folder further down reads it
    const parts = rest ? all.slice(all.length - rest.length).split('-') : [];
    for (const d of new Set([dir, await realpath(dir).catch(() => dir)])) {
      if (hit(d)) return true;
      for (let k = 1; k <= parts.length; k++) for (const r of readings(parts.slice(0, k).join('-'))) if (hit(join(d, r))) return true;
    }
  }
  return Math.min(...found.map(f => dashes(f.rest))) > READ_MAX && exclude.source !== '(?!)';
}
// The vault's pages: Markdown files under MC_VAULT, as { path, rel } with rel starting at the vault's own folder name.
// Hidden, dependency and build folders are skipped; links (Obsidian's junctions into project folders among them) are
// neither files nor folders to readdir, so they're never followed.
async function vaultPages(dir, rel, depth, out, exclude) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name), r = `${rel}/${e.name}`;
    if (e.name.startsWith('.') || exclude.test(p)) continue;
    if (e.isDirectory()) { if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) await vaultPages(p, r, depth + 1, out, exclude); }
    else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push({ path: p, rel: r, src: 'vault' });
  }
}
// A drive's or the filesystem's root keeps its "/" (D:/), so it's dropped before one is added.
const inside = (p, dir) => norm(p).toLowerCase().startsWith(`${norm(dir).toLowerCase().replace(/\/$/, '')}/`);
// A folder the index was read from through any link (MC_ROOT, a category, a memory store's folder, MC_VAULT), with where
// it really was then, or null when it can't be resolved.
const rootOf = async dir => ({ dir, real: await realpath(dir).catch(() => null) });
// Whether a file of the index may still be read, checked when it's asked for: something may have swapped it since the
// index was built. MC_EXCLUDE mustn't match it, as at build, and it must still be a plain file (lstat, as for the map's
// centre: a symbolic link or junction isn't followed). Below the nearest folder it was read from (`roots`, from
// buildIndex), links and short names resolved, it must still be where it's written to be, under where that folder
// really was then: the walk follows no link below that folder, so a folder on its way that leads elsewhere now (or that
// folder itself, re-pointed) was swapped since. Hard links, and a swap between this check and the read, aren't caught.
const below = (p, dir) => norm(p).toLowerCase().slice(norm(dir).replace(/\/$/, '').length + 1);
export async function stillIndexed(path, { roots, exclude }) {
  if (exclude.test(path) || !(await lstat(path).catch(() => null))?.isFile()) return false;
  const at = roots.filter(r => r.real && inside(path, r.dir)).sort((a, b) => norm(b.dir).length - norm(a.dir).length)[0];
  const real = at && await realpath(path).catch(() => null);
  return Boolean(real) && inside(real, at.real) && below(real, at.real) === below(path, at.dir);
}
// A project's name and description for matching: its README's (else its CLAUDE.md's) title and first paragraph. One
// MC_EXCLUDE matches isn't read: the description goes to Haiku with every batch.
async function projectMeta(path, exclude) {
  const texts = await Promise.all(['README.md', 'CLAUDE.md'].map(f => (exclude.test(join(path, f)) ? '' : head(join(path, f), 16384))));
  return { title: texts.map(titleOf).find(Boolean) ?? null, description: texts.map(t => firstParagraph(t)).find(Boolean) ?? null };
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

// One group's files → its items: threads folded per folder, each named, dated and (in a decisions folder) given its
// status. Past CAP items, the newest CAP are kept (a folder's files come in name order, which isn't age), and `more` says so.
// `redact` (redactor) hides excluded names in what the page shows (name, rel, version names); ids and `files` keep the real path.
async function items(g, list, files, redact) {
  const threads = new Map(), stats = await Promise.all(list.map(f => stat(f.path).catch(() => null)));
  for (const [i, f] of list.entries()) {
    const name = basename(f.path), t = threadOf(name), mtime = Math.round(stats[i]?.mtimeMs ?? 0);
    const k = `${norm(dirname(f.path))}\0${t.key}`;
    if (!threads.has(k)) threads.set(k, []);
    threads.get(k).push({ ...f, name, mtime, ext: extname(name).slice(1).toLowerCase(), rest: t.rest, day: t.date ?? localDay(mtime), suffix: t.suffix, draft: t.draft });
  }
  const kept = [...threads].map(([k, vs]) => [k, vs.sort(newer)]).sort((a, b) => newer(a[1][0], b[1][0]));
  const more = kept.length > CAP;
  const out = [];
  for (const [k, vs] of kept.slice(0, CAP)) {
    const top = vs[0];
    for (const v of vs) files.set(fileId(v.path), v.path);
    const it = { id: `t${sha(k)}`, kind: 'item', name: redact(vs.length > 1 ? top.rest : top.name), file: fileId(top.path), rel: redact(top.rel), ext: top.ext, mtime: top.mtime };
    if (['md', 'markdown'].includes(top.ext) && top.rel.split('/').slice(0, -1).some(s => ADR_DIRS.has(s.toLowerCase()))) {
      const status = adrStatus(await head(top.path));
      if (status) it.status = status;
    }
    if (top.draft) it.draft = true;
    if (vs.length > 1) it.versions = vs.map(v => ({ file: fileId(v.path), name: redact(v.name), mtime: v.mtime, ...(v.draft ? { draft: true } : {}) }));
    out.push([it, top]);
  }
  // Comms and outputs read newest first; docs and memory by name.
  out.sort(g === 'comms' || g === 'outputs' ? (a, b) => newer(a[1], b[1]) : (a, b) => byName(a[0], b[0]));
  return { children: out.map(([it]) => it), more };
}

// Pure: a function that replaces every name in `names` with "(excluded)" in a text: whole words (no letter or digit
// either side), in any case, with "-", "_", ".", "/", "\" and spaces read alike between a name's parts, so "acme-hr"
// also hides "ACME HR" and "acme_hr". Any dash (a non-breaking hyphen or an en dash from a converted document), a soft
// hyphen or a zero-width character counts as "-". Other spellings (abbreviations, nicknames) aren't caught. A short or
// common name hides that word everywhere it's quoted: better too much hidden than an excluded name shown.
// `spans(text)`: where the names are in a text ([start, end) pairs), so a quote can be widened not to cut one in two.
const SEP = String.raw`[-_./\\\s\p{Pd}­​-‍⁠]+`;
export function redactor(names = []) {
  const keys = [...new Set((names ?? []).map(n => n.toLowerCase().split(new RegExp(SEP, 'u')).filter(Boolean).join(' ')).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const none = s => s;
  none.spans = () => [];
  if (!keys.length) return none;
  const alt = keys.map(k => k.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(SEP));
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alt.join('|')})(?![\p{L}\p{N}])`, 'giu');
  const redact = s => (typeof s === 'string' ? s.replace(re, '(excluded)') : s);
  redact.spans = s => (typeof s === 'string' ? [...s.matchAll(re)].map(m => [m.index, m.index + m[0].length]) : []);
  return redact;
}

// The tree, and the only files /api/file may read: Map<file id, absolute path>. Defaults are this machine's settings;
// tests pass their own. `matches`: the Haiku pass's cached answers by content hash (lib/belt-match.mjs), applied to
// items the first pass leaves unmatched. Also returns `pending`, those of them it has no answer for ({ hash, rel,
// excerpt }), and `projects` ({ id, name, description }), what that pass needs to ask about them, and `hidden`: the
// names of the categories and projects MC_EXCLUDE kept out, from the folder listings read anyway (an excluded folder
// is never opened). Nothing here starts a model run.
export async function buildIndex({ root = ROOT, categories, exclude = EXCLUDE, memoryRoot = join(os.homedir(), '.claude', 'projects'),
  folders = parseFolders(KNOWLEDGE_FOLDERS_SRC), vault = VAULT, matches = {} } = {}) {
  const folderGroup = new Map();
  for (const [g, names] of Object.entries(folders)) for (const n of names) if (!folderGroup.has(n)) folderGroup.set(n, g);
  const tree = { id: 'root', kind: 'root', name: basename(resolve(root)) || root, count: 0, children: [] };
  const projects = [], files = new Map(), strays = [], roots = [await rootOf(root)], hidden = [];
  // MC_ROOT's own CLAUDE.md, the map's centre: in the file index, so /api/file serves it by id, unless MC_EXCLUDE
  // matches it (as written, or with forward slashes) or it's a link. A link isn't followed here, as nowhere in the
  // index (walk), since MC_EXCLUDE sees only the link's own path, not the file it leads to.
  const centre = join(root, 'CLAUDE.md');
  if (!exclude.test(centre) && !exclude.test(centre.replace(/\\/g, '/'))) {
    const st = await lstat(centre).catch(() => null);
    if (st?.isFile()) { tree.file = fileId(centre); tree.mtime = Math.round(st.mtimeMs); files.set(tree.file, centre); }
  }
  for (const cat of categories ?? await listCategories(root)) {
    const cdir = join(root, cat);
    if (exclude.test(cdir)) { hidden.push(cat); continue; }
    roots.push(await rootOf(cdir));
    const dirs = [];
    for (const d of await readdir(cdir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      if (exclude.test(join(cdir, d.name))) hidden.push(d.name); else dirs.push(d);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const c = { id: `c:${cat}`, kind: 'cat', name: cat, count: dirs.length, children: [] };
    for (const d of dirs) {
      const path = join(cdir, d.name), found = { docs: [], comms: [], outputs: [], memory: [] };
      const add = (g, p, rel) => found[g].push({ path: p, rel });
      await walk(path, '', null, 0, { exclude, folders: folderGroup, add });
      const node = { id: `p:${path}`, kind: 'proj', name: d.name, category: cat, path, count: 0, children: [] };
      projects.push({ node, slug: slugOf(path), found, add });
      c.children.push(node);
    }
    tree.count += c.count;
    tree.children.push(c);
  }
  // Memory stores: each hangs under the project whose slug is the store's, or under the project holding the folder the
  // store is for (a nested repo's store counts toward its project). That folder must be there, and MC_EXCLUDE is tested
  // on its path too: a slug has "-" where the path has "\" or ".", so a pattern written for the path misses the store's
  // own name. A store no project claims is a belt store: its notes orbit the projects they're about, unless MC_EXCLUDE
  // matches the folder it was for (strayExcluded).
  // A note is named "memory/<file>", never by its store's folder name, which spells out the folder's real path. Two
  // stores may each hold a note of one name: they stay two items, since ids are hashes of the real path. A belt note
  // keeps its store's name as `hint`, for the Haiku pass only (pending); it's never put on a tree node.
  for (const s of await readdir(memoryRoot, { withFileTypes: true }).catch(() => [])) {
    const dir = join(memoryRoot, s.name, 'memory'), slug = s.name.toLowerCase();
    if (!s.isDirectory() || exclude.test(dir)) continue;
    let owner = null, folder = null;
    for (const p of projects.filter(p => slug === p.slug || slug.startsWith(`${p.slug}-`)).sort((a, b) => b.slug.length - a.slug.length)) {
      if ((folder = await folderOf(p.node.path, slug.slice(p.slug.length + 1)))) { owner = p; break; }
    }
    if (owner ? exclude.test(folder) : await strayExcluded(s.name, root, exclude)) continue;
    roots.push(await rootOf(dir));
    for (const f of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, f.name), rel = `memory/${f.name}`;
      if (!f.isFile() || !/\.md$/i.test(f.name) || f.name === 'MEMORY.md' || exclude.test(p)) continue;
      if (owner) owner.add('memory', p, rel); else strays.push({ path: p, rel, hint: `${s.name}/${rel}`, src: 'memory' });
    }
  }
  // Every excluded name is known by now: items and belts show `(excluded)` in its place, and links, search and the
  // viewer's title take their names from them.
  const redact = redactor(hidden);
  for (const { node, found } of projects) {
    for (const g of Object.keys(GROUPS)) {
      const { children, more } = await items(g, found[g], files, redact);
      node.children.push({ id: `g:${node.path}#${g}`, kind: 'group', group: g, name: GROUPS[g], count: children.length, ...(more ? { more: true } : {}), children });
      node.count += children.length;
    }
  }
  if (vault && !exclude.test(vault)) roots.push(await rootOf(vault));
  return { tree, files, roots, hidden, ...await belts({ tree, files, projects, strays, vault, exclude, matches, redact }) };
}

// The belts: the vault's pages (those not inside a project folder) and the stray memory notes, each placed in the belt
// of every project it orbits, or the root's. Each placement is its own node (an item orbiting two projects is in both
// belts); `orbits` lists them all, with why, and `why` says why it's in this one (excluded names redacted).
async function belts({ tree, files, projects, strays, vault, exclude, matches, redact }) {
  const pages = [];
  if (vault && !exclude.test(vault)) await vaultPages(vault, basename(resolve(vault)), 0, pages, exclude);
  const candidates = [...pages.filter(p => !projects.some(x => inside(p.path, x.node.path))), ...strays];
  const read = await Promise.all(candidates.map(async it => {
    const [text, st] = await Promise.all([readFile(it.path, 'utf8').catch(() => null), stat(it.path).catch(() => null)]);
    return text == null ? null : { ...it, text, hash: contentHash(text), mtime: Math.round(st?.mtimeMs ?? 0) };
  }));
  const items = read.filter(Boolean), common = commonDirs(items.filter(i => i.src === 'vault').map(i => i.rel));
  const meta = await Promise.all(projects.map(async ({ node }) => {
    const own = node.children.flatMap(g => g.children).filter(it => ['md', 'markdown'].includes(it.ext)).map(it => ({ path: files.get(it.file), rel: it.rel }));
    return { id: `${node.category}/${node.name}`, name: node.name, category: node.category, ...await projectMeta(node.path, exclude), links: await projectLinks(own) };
  }));
  const nodes = new Map(meta.map((m, i) => [m.id, projects[i].node]));
  // Links between projects: only to documents in the index, never to anything else `files` holds. Every version of a
  // thread is the thread's item (its newest version's path), so links to two versions of one document count once.
  tree.links = linkEdges(meta.map((m, i) => ({ id: m.id, links: m.links,
    docs: projects[i].node.children.flatMap(g => g.children).flatMap(it => (it.versions ?? [it]).map(v => ({ path: files.get(v.file), rel: it.rel, item: it.id }))) })));
  const found = matchItems(items, meta, redact), pending = [];
  for (const [i, it] of items.entries()) {
    let orbits = found[i];
    if (!orbits.length) {
      const hit = matches?.[it.hash];
      if (hit) orbits = (hit.projects ?? []).filter(id => nodes.has(id)).map(id => ({ project: id, how: 'haiku', why: hit.why ? `Haiku: ${hit.why}` : 'Haiku' }));
      else pending.push({ hash: it.hash, rel: it.hint ?? it.rel, excerpt: it.text.slice(0, EXCERPT) });
    }
    orbits = orbits.map(o => ({ project: o.project, name: nodes.get(o.project).name, how: o.how, why: redact(o.why) }));
    const file = fileId(it.path);
    files.set(file, it.path);
    const base = { kind: 'belt', name: redact(basename(it.path)), file, rel: redact(it.rel), ext: extname(it.path).slice(1).toLowerCase(), mtime: it.mtime, src: it.src, topic: redact(topicOf(it, common)), orbits };
    if (!orbits.length) (tree.belt ??= []).push({ ...base, id: `b${sha(`\0${norm(it.path)}`)}`, why: null });
    for (const o of orbits) (nodes.get(o.project).belt ??= []).push({ ...base, id: `b${sha(`${o.project}\0${norm(it.path)}`)}`, why: o.why });
  }
  const order = (a, b) => a.topic.localeCompare(b.topic) || byName(a, b);
  tree.belt?.sort(order);
  for (const n of nodes.values()) n.belt?.sort(order);
  return { pending, projects: meta.map(({ id, name, description }) => ({ id, name, description })) };
}
