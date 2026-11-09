// Asteroid belts, first pass: knowledge that sits outside every project folder (the Obsidian vault's pages, and notes in
// Claude memory stores no project claims) orbits the projects it's about. An item orbits a project when its text names
// the project (its folder name, or the title of its README or CLAUDE.md), or when one of the project's own files links
// to it. Free and always on; nothing here leaves the machine. Items it leaves unmatched can go to Haiku
// (lib/belt-match.mjs) when MC_KNOWLEDGE_MATCH=1.
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, basename, extname } from 'node:path';

const norm = p => resolve(p).replace(/\\/g, '/');
// How much of an unmatched item the second pass is shown: its first 1500 characters (front matter included, which
// holds a memory note's name and description).
export const EXCERPT = 1500;

// Pure: Markdown links to local .md files, resolved against the file they're in, as absolute forward-slashed paths.
export function mdLinks(text, fromPath) {
  const out = [];
  for (const m of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/gi)) {
    if (/^[a-z][a-z0-9+.-]+:\/\//i.test(m[1])) continue;
    let target = m[1];
    try { target = decodeURIComponent(target); } catch { /* a stray % is a literal one */ }
    out.push(norm(resolve(dirname(fromPath), target)));
  }
  return out;
}
// Pure: [[name]] links, as memory notes and Obsidian pages write them ([[name|label]] and [[name#part]] too).
export const wikiLinks = text => [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(m => m[1].trim()).filter(Boolean);
// Pure: a memory note's own name, from its front matter.
export const memoryName = text => frontMatter(text).match(/^name:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '') || null;
export const frontMatter = text => (text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
const field = (fm, key) => fm.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') ?? '';

// Pure: one line of plain text, at most `max` characters.
const oneLine = (s, max) => { const t = String(s ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

// Pure: a README's or CLAUDE.md's title as a project name: its first "#" heading, up to a dash or colon that starts a
// subtitle. Left out when it's generic ("README", "CLAUDE.md", "Overview") or reads as a sentence (over five words).
export function titleOf(md) {
  const body = (md ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const h = body.split(/\r?\n/, 40).find(l => /^#\s+\S/.test(l));
  if (!h) return null;
  const t = h.replace(/^#\s+/, '').replace(/[*_`]/g, '').split(/\s+[—–-]\s+|:\s|\s\(|\s\|/)[0].trim();
  if (t.length < 3 || t.split(/\s+/).length > 5 || /^(readme|claude(\.md| code)?|overview|context|notes?|project|about)$/i.test(t)) return null;
  return t;
}
// Pure: the names a project is mentioned by: its folder name, and its title unless that's one plain word (a one-word
// title is more often the product it belongs to than the project: "Acme"), each once.
export function projectNames(p) {
  const out = [];
  for (const n of [p.name, p.title && !isPlainWord(p.title) ? p.title : null]) if (n && n.length >= 3 && !out.some(o => o.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}
// Pure: a name that's one plain word (letters only: "marketing", "vendor", "core") turns up in passing, however often,
// so it matches only on a stronger signal: its folder path ("strategic/marketing"), or a mention in the item's own
// title (its file name, a memory note's name or description, its first heading). A hyphen, dot, digit or space
// (acme-portal, ui-3.0, "Acme Team") sets a name apart, and one mention anywhere is enough.
export const isPlainWord = name => /^\p{L}+$/u.test(name);

// Word boundaries for names that contain "-": a mention is any run not touching a letter, digit, "_" or "-" either side,
// so acme-portal is named in "see acme-portal." but not in "acme-portal-x".
const B = '[\\p{L}\\p{N}_-]';
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameRe = n => escRe(n).replace(/\s+/g, '\\s+');
const keyOf = s => s.toLowerCase().replace(/\s+/g, ' ');
const anyOf = parts => (parts.length ? new RegExp(`(?<!${B})(?:${parts.join('|')})(?!${B})`, 'giu') : null);

// Pure: a short quote around a mention, never splitting a surrogate pair.
function quote(text, at, len) {
  let a = Math.max(0, at - 50), b = Math.min(text.length, at + len + 50);
  if (a > 0 && /[\uDC00-\uDFFF]/.test(text[a])) a--;
  if (b < text.length && /[\uDC00-\uDFFF]/.test(text[b])) b++;
  return `“${a > 0 ? '…' : ''}${oneLine(text.slice(a, b), 140)}${b < text.length ? '…' : ''}”`;
}
// Pure: what an item is called before its body: its file name, a memory note's name and description, and its first
// heading. "-" and "_" read as spaces here, so "marketing-plan.md" names marketing.
function headOf(item) {
  const fm = frontMatter(item.text);
  const h = item.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').split(/\r?\n/, 40).find(l => /^#{1,6}\s+\S/.test(l)) ?? '';
  return [basename(item.path, extname(item.path)), field(fm, 'name'), field(fm, 'description'), h.replace(/^#+\s+/, '')].join('\n').replace(/[-_]/g, ' ');
}

// Pure: the projects each item orbits, and why. `items`: [{ path, text }]. `projects`: [{ id ("<category>/<name>"),
// name, category, title, links }], where `links` is projectLinks() of the project's own files. → per item, in order,
// [{ project: id, how: 'link' | 'mention', why }]: a link first (it's the stronger reason), then mentions.
export function matchItems(items, projects) {
  const byName = new Map(), plainHead = [], plainPath = new Map();
  for (const p of projects) for (const n of projectNames(p)) {
    const k = keyOf(n);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ p, plain: isPlainWord(n) });
    if (isPlainWord(n)) {
      plainHead.push(nameRe(n));
      // Its folder path ("strategic/marketing", either slash) names it outright; a title is no path.
      if (n === p.name && p.category) plainPath.set(keyOf(`${p.category}/${n}`), p);
    }
  }
  const names = anyOf([...byName.keys()].sort((a, b) => b.length - a.length).map(nameRe));
  const heads = anyOf([...new Set(plainHead)]);
  const paths = anyOf([...plainPath.keys()].map(k => k.split('/').map(escRe).join('[\\\\/]+')));
  return items.map(item => {
    const text = item.text ?? '', found = new Map(); // project id → { how, why }
    // Links: a project's file links to this item by path, or by [[name]] (its file name, or a memory note's name).
    const p = norm(item.path).toLowerCase(), names2 = [basename(item.path, extname(item.path)), memoryName(text)].filter(Boolean).map(s => s.toLowerCase());
    for (const pr of projects) {
      const from = pr.links?.paths.get(p) ?? names2.map(n => pr.links?.wiki.get(n)).find(Boolean);
      if (from) found.set(pr.id, { how: 'link', why: `linked from ${pr.name}/${from}` });
    }
    // Mentions: every name, counted per project; a plain-word name only on a stronger signal.
    const hits = new Map(); // project → { plain: mentions, first, distinct: { at, len } }
    for (const m of names ? text.matchAll(names) : []) {
      for (const { p: pr, plain } of byName.get(keyOf(m[0])) ?? []) {
        const h = hits.get(pr) ?? { plain: 0, first: null, distinct: null };
        if (plain) { h.plain++; h.first ??= { at: m.index, len: m[0].length }; } else h.distinct ??= { at: m.index, len: m[0].length };
        hits.set(pr, h);
      }
    }
    const inPath = new Map(), inHead = new Set();
    for (const m of paths ? text.matchAll(paths) : []) {
      const pr = plainPath.get(keyOf(m[0].replace(/[\\/]+/, '/')));
      if (pr && !inPath.has(pr)) inPath.set(pr, { at: m.index, len: m[0].length });
    }
    const head = heads ? headOf(item) : '';
    for (const m of heads ? head.matchAll(heads) : []) for (const { p: pr, plain } of byName.get(keyOf(m[0])) ?? []) if (plain) inHead.add(pr);
    for (const pr of projects) {
      if (found.has(pr.id)) continue;
      const h = hits.get(pr), at = h?.distinct ?? inPath.get(pr) ?? (inHead.has(pr) ? h?.first : null);
      if (at) found.set(pr.id, { how: 'mention', why: quote(text, at.at, at.len) });
      else if (inHead.has(pr)) found.set(pr.id, { how: 'mention', why: 'named in its file name' });
    }
    return [...found].map(([project, f]) => ({ project, ...f }));
  });
}

// What a project's own Markdown files link to (each under 256 KB): Map<lowercased absolute path, the linking file's
// path in the project> and Map<lowercased [[name]], the same>. `files`: [{ path, rel }].
export async function projectLinks(files) {
  const paths = new Map(), wiki = new Map();
  const texts = await Promise.all(files.map(async f => {
    const st = await stat(f.path).catch(() => null);
    return st && st.size <= 256e3 ? readFile(f.path, 'utf8').catch(() => null) : null;
  }));
  for (const [i, text] of texts.entries()) {
    if (!text) continue;
    for (const p of mdLinks(text, files[i].path)) if (!paths.has(p.toLowerCase())) paths.set(p.toLowerCase(), files[i].rel);
    for (const w of wikiLinks(text)) if (!wiki.has(w.toLowerCase())) wiki.set(w.toLowerCase(), files[i].rel);
  }
  return { paths, wiki };
}

// Pure: links between projects' own documents. `projects`: [{ id, links (projectLinks of its own Markdown), docs:
// [{ path, rel, item? }] (its documents in the index, every version; `item` is the document a version belongs to,
// counted once, else its rel, since two documents can share a rel, as two memory stores' notes of one name do) }]. Only a document in the index can be linked to, so a
// file MC_EXCLUDE matches, one reached through a link (the walk follows none), a missing file and anything outside
// every project (the workspace's CLAUDE.md, the vault) never counts. A Markdown link counts when it resolves to
// another project's document; a [[name]] when exactly one other project has a Markdown document of that name (its file
// name, or the end of its path for [[docs/plan]]) and the linking project has none (then it's its own). → [{ from, to,
// n, file, target }], one per ordered pair: n distinct documents linked, `file` the first linking file (its path in
// `from`) and `target` the document it links to (its path in `to`).
export function linkEdges(projects) {
  const byPath = new Map(), byStem = new Map(); // lowercased path → { id, rel }; file name without extension → [{ id, rel, stem }]
  const MD = /\.(md|markdown)$/i;
  for (const p of projects) for (const d of p.docs ?? []) {
    const k = norm(d.path).toLowerCase(), doc = { id: p.id, rel: d.rel, item: d.item ?? d.rel };
    byPath.set(k, doc);
    if (!MD.test(k)) continue;
    const stem = k.replace(MD, ''), name = stem.slice(stem.lastIndexOf('/') + 1);
    if (!byStem.has(name)) byStem.set(name, []);
    byStem.get(name).push({ ...doc, stem });
  }
  const edges = new Map(); // "from\0to" → { from, to, file, target, docs: Set of target items }
  const add = (from, to, file, t) => {
    const k = `${from}\0${to}`;
    if (!edges.has(k)) edges.set(k, { from, to, file, target: t.rel, docs: new Set() });
    edges.get(k).docs.add(t.item);
  };
  for (const p of projects) {
    for (const [path, file] of p.links?.paths ?? []) {
      const t = byPath.get(path);
      if (t && t.id !== p.id) add(p.id, t.id, file, t);
    }
    for (const [name, file] of p.links?.wiki ?? []) {
      const n = name.replace(/\\/g, '/').replace(MD, '').replace(/^\/+/, '');
      const hits = (byStem.get(n.slice(n.lastIndexOf('/') + 1)) ?? []).filter(h => h.stem.endsWith(`/${n}`));
      if (!hits.length || hits.some(h => h.id === p.id) || new Set(hits.map(h => h.id)).size > 1) continue;
      add(p.id, hits[0].id, file, hits[0]);
    }
  }
  return [...edges.values()].map(({ docs, ...e }) => ({ ...e, n: docs.size }));
}

// Pure: the clump a belt item sits in. A vault page: the first two folders below the ones every vault page shares
// (`common`), e.g. "vault · wiki/engineering". A memory note: its type, from front matter or its file name's prefix.
export function topicOf(item, common = []) {
  if (item.src === 'vault') {
    const dirs = item.rel.split('/').slice(0, -1).slice(common.length, common.length + 2);
    return dirs.length ? `vault · ${dirs.join('/')}` : 'vault';
  }
  const t = field(frontMatter(item.text), 'type') || basename(item.path).match(/^(user|feedback|project|reference)[_-]/i)?.[1] || 'note';
  return `memory · ${t.toLowerCase()}`;
}
// Pure: the folders every vault page's path starts with (`rels`: forward-slashed, relative to the vault).
export function commonDirs(rels) {
  const all = rels.map(r => r.split('/').slice(0, -1));
  if (!all.length) return [];
  const out = [];
  for (let i = 0; all.every(d => d.length > i && d[i] === all[0][i]); i++) out.push(all[0][i]);
  return out;
}
