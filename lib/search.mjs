// Knowledge search: the names of projects, groups and items, and the text inside Markdown, HTML (tags, scripts and
// styles stripped) and VTT (cue text) files, every version of a thread. Built from a knowledge index (lib/knowledge.mjs),
// so it reads only files the index lists, and each path is tested against MC_EXCLUDE again before it's read.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { EXCLUDE } from './config.mjs';

const BODY_TYPES = new Set(['md', 'markdown', 'html', 'htm', 'vtt']);
// Named entities are case-sensitive (&rarr; is →, &rArr; is ⇒): the common ones, typographic marks and arrows included.
const ENTITIES = { amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'", nbsp: ' ', shy: '',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·',
  bull: '•', sect: '§', para: '¶', times: '×', deg: '°', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', check: '✓' };
const entities = s => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e] ?? m;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
// A tag: `<` then a letter, `/`, `!` or `?` (so "a < b" isn't one), up to the `>` outside quoted attribute values.
const TAG = /<[a-z/!?](?:[^>"']|"[^"]*"|'[^']*')*>/gi;
// A comment, or a script, style, template or noscript element with what's in it, whichever opens first (so a "<!--" in a
// script is script text, as it is to a browser); one left open runs to the end.
const HIDDEN = /<!--[\s\S]*?(?:-->|$)|<(script|style|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

// Pure: what's searchable in a file of type `ext`. HTML: the text a reader sees (no tags, attributes, comments, scripts
// or styles). VTT: each cue's text, its speaker first ("Name: text"), without the header, notes, cue ids or timings.
// Markdown as it is. Whitespace runs become one space.
export function textOf(ext, raw) {
  const x = ext.toLowerCase();
  let t = raw ?? '';
  if (x === 'html' || x === 'htm') t = entities(t.replace(HIDDEN, ' ').replace(TAG, ' '));
  else if (x === 'vtt') {
    t = t.split(/\r?\n[ \t]*\r?\n/).map(block => {
      const lines = block.split(/\r?\n/), at = lines.findIndex(l => l.includes('-->'));
      return at < 0 ? '' : entities(lines.slice(at + 1).join(' ').replace(/<v(?:\.[^\s>]*)?\s+([^>]*)>/g, '$1: ').replace(/<[^>]*>/g, ''));
    }).join(' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

// The searchable index of a knowledge index `{ tree, files }`: every project, group and item name with its chain of ids
// from the root, and the text of every version of every item whose type has a body. An empty group isn't a name hit,
// since the map doesn't open one. Files are read 8 at a time; one that can't be read is left out.
export async function buildText({ tree, files }, { exclude = EXCLUDE } = {}) {
  const names = [], jobs = [];
  const walk = (n, path, ctx) => {
    const p = [...path, n.id];
    if (n.kind === 'cat') ctx = { ...ctx, category: n.name };
    if (n.kind === 'proj') ctx = { ...ctx, project: n.name };
    if (n.kind === 'group') ctx = { ...ctx, group: n.name };
    if (n.kind === 'proj' || (n.kind === 'group' && n.count) || n.kind === 'item') {
      const e = { node: n, path: p, ...ctx, flat: n.name.replace(/\s+/g, ' ') };
      names.push(e);
      if (n.kind === 'item') {
        const versions = n.versions ?? [{ file: n.file, name: n.name, mtime: n.mtime }];
        versions.forEach((v, i) => jobs.push({ item: e, file: v.file, version: i ? v.name : null, mtime: v.mtime ?? n.mtime ?? 0 }));
      }
    }
    n.children?.forEach(c => walk(c, p, ctx));
  };
  walk(tree, [], {});
  const docs = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < jobs.length) {
      const i = next++, j = jobs[i], path = files.get(j.file);
      const ext = path ? extname(path).slice(1).toLowerCase() : '';
      if (!path || exclude.test(path) || !BODY_TYPES.has(ext)) continue;
      const raw = await readFile(path, 'utf8').catch(() => null);
      if (raw != null) docs[i] = { ...j, text: textOf(ext, raw) };
    }
  }));
  // Versions stay newest first within an item, so an item's first matching doc is its newest match.
  return { names, docs: docs.filter(Boolean) };
}

const KIND_ORDER = { proj: 0, group: 1, item: 2 };
const CONTEXT = 60;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordStart = (s, i) => i === 0 || !/[\p{L}\p{N}]/u.test(s[i - 1]);
const low = (s, i) => (c => c >= 0xdc00 && c <= 0xdfff)(s.charCodeAt(i)); // the second half of a surrogate pair
const split = (s, i, n, room) => {
  let a = Math.max(0, i - room), b = Math.min(s.length, i + n + room);
  if (low(s, a)) a++; // the context never starts or ends inside a pair (an emoji there would show as �)
  if (low(s, b)) b--;
  return { pre: (a > 0 ? '…' : '') + s.slice(a, i), hit: s.slice(i, i + n), post: s.slice(i + n, b) + (b < s.length ? '…' : '') };
};

// Pure: the hits for `q`, matched as one literal phrase (case-insensitive, whitespace runs as one space, at least 2
// characters). Names before text: projects, then groups, then items; a match at a word's start before one inside a
// word; then newest, then A–Z. Text matches newest first. One hit per node, at most `limit`, `more` when there were more.
// Each hit: its id and kind, name, the chain of ids from the root, where it matched, the match with its context as
// plain text ({ pre, hit, post }), and for an item the file that matched (`version`: its name, when not the newest).
export function search(idx, q, limit = 50) {
  const phrase = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[\ud800-\udbff]$/, ''); // no half pair
  if (phrase.length < 2 || !idx) return { q: phrase, hits: [], more: false };
  const re = new RegExp(escapeRe(phrase), 'i'); // literal: every metacharacter escaped
  const seen = new Set(), named = [], bodied = [];
  for (const e of idx.names) {
    const m = re.exec(e.flat);
    if (!m) continue;
    seen.add(e.node.id);
    named.push({ e, start: wordStart(e.flat, m.index), snippet: split(e.flat, m.index, m[0].length, Infinity), mtime: e.node.mtime ?? 0 });
  }
  for (const d of idx.docs) {
    if (seen.has(d.item.node.id)) continue;
    const m = re.exec(d.text);
    if (!m) continue;
    seen.add(d.item.node.id);
    bodied.push({ e: d.item, d, snippet: split(d.text, m.index, m[0].length, CONTEXT), mtime: d.mtime });
  }
  named.sort((a, b) => KIND_ORDER[a.e.node.kind] - KIND_ORDER[b.e.node.kind] || b.start - a.start || b.mtime - a.mtime
    || a.e.node.name.localeCompare(b.e.node.name, undefined, { sensitivity: 'base' }));
  bodied.sort((a, b) => b.mtime - a.mtime);
  const all = [...named, ...bodied];
  const hits = all.slice(0, limit).map(({ e, d, snippet }) => ({
    id: e.node.id, kind: e.node.kind, name: e.node.name, path: e.path, where: d ? 'body' : 'name', snippet,
    ...(e.node.kind === 'proj' ? { category: e.category } : { project: e.project }),
    ...(e.node.kind === 'item' ? { group: e.group, file: d?.file ?? e.node.file } : {}),
    ...(d?.version ? { version: d.version } : {}),
  }));
  return { q: phrase, hits, more: all.length > limit };
}
