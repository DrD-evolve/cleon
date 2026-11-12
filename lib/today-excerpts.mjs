// Today view, part 2: the rule-3 excerpts the planner may read. The only project text that goes to Claude every day, so
// it is narrow on purpose:
//   - each category is opt-in (MC_TODAY_READ); with none listed no file is opened at all;
//   - only active projects: a commit or an uncommitted change in the last 7 days;
//   - two fixed file names at a project's root (CLAUDE.md, CHANGELOG.md): never a directory listing, never source code,
//     never a search for TODO or FIXME;
//   - from CLAUDE.md only its blockers or next-steps section, from CHANGELOG.md only its newest entry, with code blocks
//     stripped, under a size limit per excerpt and in total;
//   - every path through excludesFolder / excludesPath, and an excerpt is dropped when MC_EXCLUDE matches its text or
//     any word in it taken as a folder name (so a pattern written for paths, `[\/]name[\/]`, catches a bare mention).
import { open, lstat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { EXCLUDE, excludesFolder, excludesPath } from './config.mjs';

export const CATEGORIES = Object.freeze(['claude-md', 'changelog']);
export const FILES = Object.freeze({ 'claude-md': 'CLAUDE.md', changelog: 'CHANGELOG.md' });
export const LIMITS = Object.freeze({ perExcerpt: 600, total: 3000, projects: 8, fileBytes: 64 * 1024 });
const D = 864e5;

// Pure: MC_TODAY_READ → the listed categories, and any word that isn't one (so the server can say so).
export function parseRead(src) {
  const words = String(src ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return { read: CATEGORIES.filter(c => words.includes(c)), unknown: words.filter(w => !CATEGORIES.includes(w)) };
}

// Fenced code is dropped (it may be source), and HTML comments; control characters become spaces.
const FENCE = /^\s*(```|~~~)/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const clean = md => {
  let fenced = false;
  return String(md ?? '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n')
    .filter(l => { if (FENCE.test(l)) { fenced = !fenced; return false; } return !fenced; })
    .join('\n').replace(CONTROL, ' ');
};
const level = l => /^(#{1,6})\s/.exec(l)?.[1].length ?? 0;
const squash = (lines, max) => {
  const t = lines.map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Pure: the first blockers / next-steps section of a CLAUDE.md (its heading and body, up to the next heading of the same
// or a higher level), or null. A heading needs a space after its hashes, as in `level`: "#blocked" is not one, and
// taking it would leave the section with no end.
const SECTION = /^#{1,6}\s+(?:\*\*)?\s*(blockers?|blocked|next[ -]?steps?)\b/i;
export function sectionOf(md, max = LIMITS.perExcerpt) {
  const lines = clean(md).split('\n');
  const at = lines.findIndex(l => SECTION.test(l));
  if (at < 0) return null;
  const lv = level(lines[at]);
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) { const l = level(lines[i]); if (l && l <= lv) { end = i; break; } }
  return lines.slice(at + 1, end).some(l => l.trim()) ? squash(lines.slice(at, end), max) : null;
}

// Pure: the newest entry of a CHANGELOG.md: the first `##` heading with something under it (an empty Unreleased heading
// is skipped), up to the next `##`.
export function newestEntry(md, max = LIMITS.perExcerpt) {
  const lines = clean(md).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (level(lines[i]) !== 2) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (level(lines[j]) && level(lines[j]) <= 2) { end = j; break; }
    if (lines.slice(i + 1, end).some(l => l.trim())) return squash(lines.slice(i, end), max);
  }
  return null;
}

// A regular file's first `bytes`, as text; null for a link, a folder, a missing or unreadable file.
export async function openText(path, bytes = LIMITS.fileBytes) {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, bytes));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.toString('utf8', 0, bytesRead);
    } finally { await fh.close(); }
  } catch { return null; }
}

// Pure: the projects active in the last 7 days, most recent first. `projects`: [{ name, path, lastCommitAt }]; `dirty`:
// [{ path, newestChange }] (lib/today-read.mjs readFacts).
export function activeProjects({ projects = [], dirty = [], now, exclude = EXCLUDE }) {
  const change = new Map(dirty.map(d => [d.path, d.newestChange ?? 0]));
  return projects.filter(p => !excludesFolder(p.path, exclude))
    .map(p => ({ p, at: Math.max(p.lastCommitAt ?? 0, change.get(p.path) ?? 0) }))
    .filter(x => x.at && now - x.at <= 7 * D).sort((a, b) => b.at - a.at).map(x => x.p);
}

// Pure: whether MC_EXCLUDE matches the text, or one of its words compared as a folder name.
export const namesExcluded = (text, exclude = EXCLUDE) =>
  exclude.test(text) || text.split(/[^\w.-]+/).some(w => w && excludesFolder(`${sep}${w}`, exclude));

// The excerpts, [{ project, category, text }]. `read`: the opted-in categories (parseRead). `open(path)` reads one file.
export async function collectExcerpts({ projects, dirty, read = [], now = Date.now(), exclude = EXCLUDE, open: openFn = openText, limits = LIMITS }) {
  const cats = CATEGORIES.filter(c => read.includes(c));
  if (!cats.length) return [];
  const out = []; let used = 0;
  for (const p of activeProjects({ projects, dirty, now, exclude }).slice(0, limits.projects)) {
    for (const category of cats) {
      if (used >= limits.total) return out;
      const file = join(p.path, FILES[category]);
      if (excludesPath(file, exclude)) continue;
      const md = await openFn(file);
      if (md == null) continue;
      let text = (category === 'claude-md' ? sectionOf : newestEntry)(md, limits.perExcerpt);
      if (!text || namesExcluded(text, exclude)) continue;
      if (used + text.length > limits.total) text = `${text.slice(0, Math.max(0, limits.total - used - 1))}…`;
      if (text.length < 2) return out;
      used += text.length;
      out.push({ project: p.name, category, text });
    }
  }
  return out;
}
