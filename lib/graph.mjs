// Knowledge graph: Obsidian vault (incl. its project-docs junctions), project CLAUDE.md files,
// and Claude memory stores. Nodes are files + folder hubs; edges are containment and links.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, basename, relative } from 'node:path';
import os from 'node:os';

import { ROOT, VAULT, EXCLUDE } from './config.mjs';

// Privacy: paths matching MC_EXCLUDE never enter the graph or file tiles.
export { EXCLUDE };
const SKIP_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash']);
const MAX_FILES = 1500;

export const SOURCES = [
  ...(VAULT ? [{ group: 'vault', label: 'Obsidian vault', root: VAULT, walk: true }] : []),
  { group: 'memory', label: 'Claude memory', root: join(os.homedir(), '.claude', 'projects'), memory: true },
  { group: 'claude-md', label: 'Project CLAUDE.md', root: ROOT, claudeMd: true },
];

const norm = p => resolve(p).replace(/\\/g, '/');

// Pure: markdown links to local .md files, resolved against the source file.
export function mdLinks(text, fromPath) {
  const out = [];
  for (const m of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:\/\//i.test(m[1])) continue;
    out.push(norm(join(dirname(fromPath), decodeURIComponent(m[1]))));
  }
  return out;
}

// Pure: [[slug]] links used by the memory stores.
export const wikiLinks = text => [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(m => m[1].trim());
export const memoryName = text => text.match(/^name:\s*(.+)$/m)?.[1].trim() ?? null;

async function walk(dir, files, depth = 0) {
  if (depth > 6 || files.length >= MAX_FILES || EXCLUDE.test(dir)) return;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (EXCLUDE.test(p)) continue;
    // Junctions/symlinks report neither isFile nor isDirectory — stat follows them.
    const s = e.isSymbolicLink() ? await stat(p).catch(() => null) : e;
    if (!s) continue;
    if (s.isDirectory() && !SKIP_DIRS.has(e.name)) await walk(p, files, depth + 1);
    else if (s.isFile() && e.name.endsWith('.md')) files.push(p);
  }
}

async function collect() {
  const items = []; // { path, group, chain: [hub labels from source root down] }
  for (const src of SOURCES) {
    const files = [];
    if (src.walk) await walk(src.root, files);
    if (src.memory) {
      for (const d of await readdir(src.root).catch(() => [])) {
        if (EXCLUDE.test(d)) continue;
        for (const f of await readdir(join(src.root, d, 'memory')).catch(() => [])) {
          if (f.endsWith('.md') && f !== 'MEMORY.md' && !EXCLUDE.test(f)) files.push(join(src.root, d, 'memory', f));
        }
      }
    }
    if (src.claudeMd) {
      for (const cat of await readdir(src.root).catch(() => [])) {
        for (const proj of await readdir(join(src.root, cat)).catch(() => [])) {
          const p = join(src.root, cat, proj, 'CLAUDE.md');
          if (!EXCLUDE.test(p) && await stat(p).catch(() => null)) files.push(p);
        }
      }
    }
    for (const p of files) {
      const rel = relative(src.root, dirname(p)).split(/[\\/]/).filter(Boolean);
      const chain = src.memory ? [rel[0].replace(/^C--/, '').replace(/-/g, ' ')]
        : src.claudeMd ? [] : rel;
      items.push({ path: p, group: src.group, srcLabel: src.label, chain });
    }
  }
  return items.slice(0, MAX_FILES);
}

export async function buildGraph() {
  const items = await collect();
  const nodes = [], links = [], files = new Map(); // id -> absolute path (the only readable set)
  const hubs = new Map();
  const hub = (key, name, group, parent) => {
    if (!hubs.has(key)) {
      hubs.set(key, `h${hubs.size}`);
      nodes.push({ id: hubs.get(key), name, group, kind: 'hub' });
      if (parent) links.push({ source: parent, target: hubs.get(key), kind: 'tree' });
    }
    return hubs.get(key);
  };
  const byPath = new Map(), byMemName = new Map(), texts = new Map();
  for (const [i, it] of items.entries()) {
    const id = `f${i}`;
    let parent = hub(it.group, it.srcLabel, it.group);
    it.chain.forEach((seg, k) => { parent = hub(`${it.group}/${it.chain.slice(0, k + 1).join('/')}`, seg, it.group, parent); });
    const text = await readFile(it.path, 'utf8').catch(() => '');
    const name = it.group === 'claude-md' ? basename(dirname(it.path)) : basename(it.path, '.md');
    nodes.push({ id, name, group: it.group, kind: 'file', size: text.length });
    links.push({ source: parent, target: id, kind: 'tree' });
    files.set(id, it.path);
    byPath.set(norm(it.path), id);
    texts.set(id, text);
    if (it.group === 'memory') { const n = memoryName(text); if (n) byMemName.set(n, id); }
  }
  const seen = new Set();
  const addRef = (a, b) => {
    const k = `${a}>${b}`;
    if (b && a !== b && !seen.has(k)) { seen.add(k); links.push({ source: a, target: b, kind: 'ref' }); }
  };
  for (const [id, text] of texts) {
    for (const p of mdLinks(text, files.get(id))) addRef(id, byPath.get(p));
    for (const n of wikiLinks(text)) addRef(id, byMemName.get(n));
  }
  return { nodes, links, files };
}
