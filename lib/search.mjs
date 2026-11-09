// Knowledge search: the names of projects, groups and items, and the text inside Markdown, HTML (tags, scripts and
// styles stripped) and VTT (cue text) files, every version of a thread. Built from a knowledge index (lib/knowledge.mjs),
// so it reads only files the index lists, and each path is checked again before it's read: against MC_EXCLUDE, and,
// when the index carries the folders it was read from, as /api/file checks it (stillIndexed). The names MC_EXCLUDE
// kept out (the index's `hidden`) are redacted in the text kept, so no snippet shows one and none is found by text.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { EXCLUDE } from './config.mjs';
import { stillIndexed, redactor } from './knowledge.mjs';

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
export async function buildText({ tree, files, roots, hidden, shown }, { exclude = EXCLUDE } = {}) {
  const names = [], jobs = [], redact = redactor(hidden, shown);
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
      if (roots && !await stillIndexed(path, { roots, exclude })) continue;
      const raw = await readFile(path, 'utf8').catch(() => null);
      if (raw != null) docs[i] = { ...j, text: redact(textOf(ext, raw)) };
    }
  }));
  // Versions stay newest first within an item, so an item's first matching doc is its newest match.
  return { names, docs: docs.filter(Boolean) };
}

const KIND_ORDER = { proj: 0, item: 1, group: 2 };
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
// characters). Name matches first: projects, then items, then groups; a match at a word's start before one inside a
// word; then newest, then A–Z. Then text matches, newest first. Each list has its own cap of `limit`, so names can't
// crowd the text out; `more` when there were more name matches, `moreText` when there were more text matches. One hit
// per node: a node listed by name isn't a text hit too, but one the names cap left out can be. Groups that share a label
// are one hit (`count` of them, each in `projects`: its id, chain of ids, project and category).
// Each hit: its id and kind, name, the chain of ids from the root, where it matched, the match with its context as
// plain text ({ pre, hit, post }), and for an item the file that matched (`version`: its name, when not the newest).
export function search(idx, q, limit = 50) {
  const phrase = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[\ud800-\udbff]$/, ''); // no half pair
  if (phrase.length < 2 || !idx) return { q: phrase, hits: [], more: false, moreText: false };
  const re = new RegExp(escapeRe(phrase), 'i'); // literal: every metacharacter escaped
  const named = [], bodied = [], groups = new Map();
  for (const e of idx.names) {
    const m = re.exec(e.flat);
    if (!m) continue;
    const n = { e, start: wordStart(e.flat, m.index), snippet: split(e.flat, m.index, m[0].length, Infinity), mtime: e.node.mtime ?? 0 };
    if (e.node.kind !== 'group') named.push(n);
    else if (groups.has(e.flat)) groups.get(e.flat).push(n);
    else groups.set(e.flat, [n]);
  }
  // Every project has the same few groups, so groups with the same label fold into one hit, before the cap: it takes one
  // place under it and counts them all. A label only one group matched stays a hit of its own.
  for (const list of groups.values()) {
    if (list.length === 1) { named.push(list[0]); continue; }
    list.sort((a, b) => a.e.project.localeCompare(b.e.project, undefined, { sensitivity: 'base' }));
    const [first] = list, label = first.e.node.name;
    named.push({ ...first, mtime: Math.max(...list.map(n => n.mtime)), fold: { id: `fold:${label}`, kind: 'group', name: label,
      where: 'name', snippet: first.snippet, count: list.length,
      projects: list.map(({ e }) => ({ id: e.node.id, path: e.path, project: e.project, category: e.category })) } });
  }
  named.sort((a, b) => KIND_ORDER[a.e.node.kind] - KIND_ORDER[b.e.node.kind] || b.start - a.start || b.mtime - a.mtime
    || a.e.node.name.localeCompare(b.e.node.name, undefined, { sensitivity: 'base' }));
  const seen = new Set(named.slice(0, limit).map(n => n.e.node.id));
  for (const d of idx.docs) {
    if (seen.has(d.item.node.id)) continue;
    const m = re.exec(d.text);
    if (!m) continue;
    seen.add(d.item.node.id);
    bodied.push({ e: d.item, d, snippet: split(d.text, m.index, m[0].length, CONTEXT), mtime: d.mtime });
  }
  bodied.sort((a, b) => b.mtime - a.mtime);
  const hits = [...named.slice(0, limit), ...bodied.slice(0, limit)].map(({ e, d, snippet, fold }) => fold ?? ({
    id: e.node.id, kind: e.node.kind, name: e.node.name, path: e.path, where: d ? 'body' : 'name', snippet,
    ...(e.node.kind === 'proj' ? { category: e.category } : { project: e.project }),
    ...(e.node.kind === 'item' ? { group: e.group, file: d?.file ?? e.node.file } : {}),
    ...(d?.version ? { version: d.version } : {}),
  }));
  return { q: phrase, hits, more: named.length > limit, moreText: bodied.length > limit };
}
