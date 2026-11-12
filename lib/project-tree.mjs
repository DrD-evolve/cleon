// The project page's file tree: one folder at a time, and a text preview of one file, both confined to a project
// folder listProjects() would list. Nothing here trusts what the browser sends: every ask re-runs resolveIn, and a
// listing grants nothing (the preview resolves the file again).
import { readdir as fsReaddir, lstat as fsLstat, realpath, open, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from './bin.mjs'; // not node's: see bin.mjs
import { ROOT, EXCLUDE, excludesFolder } from './config.mjs';
import { findProjectByKey } from './projects.mjs';
import { cached } from './shared.mjs';

export const TREE_CAP = 2000; // entries returned for one folder; the rest are counted, not sent
export const PREVIEW_MAX = 512 * 1024;
const SNIFF = 8192;
// Folders the tree shows closed and dimmed: large, and rarely what you came to read.
const COLLAPSED = new Set(['.git', 'node_modules', '.venv', '.aws-sam']);

// Pure: `<category>/<name>` → { category, name }, or null. Two non-empty parts, neither `.` nor `..`, no `\`, `:` or NUL.
export function parseKey(key) {
  if (typeof key !== 'string' || /[\\:\0]/.test(key)) return null;
  const parts = key.split('/');
  return parts.length === 2 && parts.every(p => p && p !== '.' && p !== '..') ? { category: parts[0], name: parts[1] } : null;
}

// Pure: a path below the project, as its segments ([] for the project folder), or null. Split on `/` only. Refused:
// `\` (so `..\` and a UNC path), `:` (a drive letter, an NTFS stream), NUL, a leading `/`, an empty segment, `.`, `..`, and a
// segment ending in `.` or a space (Windows drops those, so the name would alias another).
export function checkRel(rel) {
  if (typeof rel !== 'string' || /[\\:\0]/.test(rel)) return null;
  if (rel === '') return [];
  const segs = rel.split('/');
  return segs.every(s => s && s !== '.' && s !== '..' && !/[. ]$/.test(s)) ? segs : null;
}

const norm = p => resolve(p).replace(/\\/g, '/').toLowerCase();

// The project's folder (or a file or folder below it) a key and path name, or null: { project, abs, segs, real }. `want` is
// 'dir' or 'file'. The target must be a plain one (lstat: a link or junction is never followed), MC_EXCLUDE mustn't match
// it, any folder above it in the project, or its real path, and its real path must be where it is written to be under the
// category's real path: a link anywhere below the category (the project folder itself, a folder on the way) or a short name
// makes the two differ. The case of a name may differ (same file on Windows). Hard links aren't caught; a swap before the
// read is caught by readPreview.
export async function resolveIn(key, rel, want, { root = ROOT, exclude = EXCLUDE } = {}) {
  const k = parseKey(key), segs = checkRel(rel);
  if (!k || !segs) return null;
  const project = await findProjectByKey(k.category, k.name, root, exclude);
  if (!project) return null;
  const abs = join(project.path, ...segs);
  // Every folder on the way, as the listing (and the index's walk) would have stopped at an excluded one.
  for (let i = 1; i <= segs.length; i++) if (excludesFolder(join(project.path, ...segs.slice(0, i)), exclude)) return null;
  const st = await fsLstat(abs).catch(() => null);
  if (!st || !(want === 'dir' ? st.isDirectory() : st.isFile())) return null;
  const [real, anchor] = await Promise.all([realpath(abs).catch(() => null), realpath(join(root, k.category)).catch(() => null)]);
  if (!real || !anchor || excludesFolder(real, exclude)) return null;
  if (norm(real) !== norm([anchor, k.name, ...segs].join('/'))) return null;
  return { project, abs, segs, real };
}

// The folder's entries, dirs first then A–Z, the first `cap` of them, with how many more there were. Takes only readdir
// and lstat (default: node's), so it has no means to open a file: a name, a type, a size and a time per entry.
// `keep(fullPath)` leaves an entry out before anything is asked about it.
export async function listFolder(dir, { readdir = fsReaddir, lstat = fsLstat } = {}, { cap = TREE_CAP, keep = () => true } = {}) {
  const typeOf = d => d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'link' : 'other';
  const all = (await readdir(dir, { withFileTypes: true })).filter(d => keep(join(dir, d.name))).map(d => ({ name: d.name, type: typeOf(d) }));
  all.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, 'en') || (a.name < b.name ? -1 : 1));
  const entries = await Promise.all(all.slice(0, cap).map(async e => {
    const st = await lstat(join(dir, e.name)).catch(() => null);
    return { ...e, size: st && e.type === 'file' ? st.size : null, mtime: st ? Math.round(st.mtimeMs) : null };
  }));
  return { entries, more: Math.max(0, all.length - cap) };
}

export const collapsedDir = (name, type) => type === 'dir' && COLLAPSED.has(name.toLowerCase());

// Pure: `git status --porcelain=v1 -z` output → Map of repo-relative path (no trailing slash) → 'modified' | 'untracked'
// | 'ignored'. A rename or copy has a second path after its own; it's skipped. With --branch the first record is the
// `## ` header, no path (no status code starts with `#`).
export function parseGitStatus(out) {
  const marks = new Map(), fields = (out ?? '').split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4 || f.startsWith('## ')) continue;
    const xy = f.slice(0, 2);
    marks.set(f.slice(3).replace(/\/$/, ''), xy === '!!' ? 'ignored' : xy === '??' ? 'untracked' : 'modified');
    if (/[RC]/.test(xy)) i++;
  }
  return marks;
}
// Pure: the `## ` header record of the same output → { upstream: 'yes' | 'none' | 'gone' | 'detached', ahead, behind }, or
// null with no header. `## main...origin/main [ahead 1, behind 3]`, `[gone]`, `## main` (no upstream), `## HEAD (no
// branch)`, `## No commits yet on main`.
export function parseBranchHeader(out) {
  const f = (out ?? '').split('\0')[0];
  if (!f.startsWith('## ')) return null;
  const h = f.slice(3), n = re => Number(h.match(re)?.[1] ?? 0);
  if (h.startsWith('HEAD (no branch)')) return { upstream: 'detached', ahead: 0, behind: 0 };
  if (/\[gone\]\s*$/.test(h)) return { upstream: 'gone', ahead: 0, behind: 0 };
  return { upstream: h.includes('...') ? 'yes' : 'none', ahead: n(/ahead (\d+)/), behind: n(/behind (\d+)/) };
}
const STRENGTH = { modified: 3, untracked: 2, ignored: 1 };
// Pure: an entry's mark from the parsed status: its own, else (a folder) the strongest under it, else what an ignored or
// untracked folder above it gives. null when it has none.
export function markOf(marks, rel, isDir) {
  if (!marks?.size) return null;
  const own = marks.get(rel);
  if (own) return own;
  const parts = rel.split('/');
  for (let n = 1; n < parts.length; n++) {
    const up = marks.get(parts.slice(0, n).join('/'));
    if (up === 'ignored' || up === 'untracked') return up;
  }
  if (!isDir) return null;
  let best = null;
  for (const [p, m] of marks) if (p.startsWith(`${rel}/`) && (!best || STRENGTH[m] > STRENGTH[best])) best = m;
  return best;
}

// One status per project, shared for 10 s (a page opening several folders costs one run). git failing (not a repo, a timeout)
// gives no marks, never an error. fsmonitor off and no optional locks: a read must not start a daemon or touch the index.
// gitMarks and gitBranch read the same run: the marks, and the branch header (null when git failed).
const runs = new Map();
function gitRun(path, { run = defaultRun, ttlMs = 10_000 } = {}) {
  let get = runs.get(path);
  if (!get) runs.set(path, get = cached(async () => { const out = await run(path).catch(() => ''); return { marks: parseGitStatus(out), branch: parseBranchHeader(out) }; }, ttlMs));
  return get();
}
export const gitMarks = (path, o) => gitRun(path, o).then(r => r.marks);
export const gitBranch = (path, o) => gitRun(path, o).then(r => r.branch);
const defaultRun = path => new Promise((ok, fail) => execFile('git',
  ['-C', path, '-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain=v1', '--branch', '-z', '--ignored=traditional', '--untracked-files=normal'],
  { timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, out) => (e ? fail(e) : ok(out))));
// Whether the project has a .git of its own (a folder, or a file for a worktree), checked without starting git.
export const hasGit = path => stat(join(path, '.git')).then(() => true, () => false);

// What the page may do with a file, by its name alone. Blocked (case-insensitive): secrets and spreadsheets. Previewable:
// the allow-list. Anything else: none.
const BLOCKED = [[/^\.env/, 'environment file'], [/\.(pem|key|pfx|p12)$/, 'key or certificate'], [/^id_/, 'key file'], [/\.(xlsx|xls|csv)$/, 'spreadsheet or data export']];
const TEXT_EXT = new Set(('md markdown txt log json jsonc yaml yml toml ini cfg conf xml html htm svg css scss js mjs cjs ts tsx jsx py sh bash ps1 psm1 bat cmd c h cpp hpp cc cs java go rs rb php sql vtt gitignore gitattributes editorconfig').split(' '));
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'license', 'readme']);
export function previewClass(name) {
  const n = name.toLowerCase();
  const hit = BLOCKED.find(([re]) => re.test(n));
  if (hit) return { preview: 'blocked', reason: hit[1] };
  const dot = n.lastIndexOf('.');
  return (dot < 0 ? TEXT_NAMES.has(n) : TEXT_EXT.has(n.slice(dot + 1))) ? { preview: 'text' } : { preview: 'none' };
}

// A file's text for the preview, in order: blocked (403), not on the allow-list (415), over the size limit (413), a NUL byte in
// the first 8 KB (415, binary), then read through a handle of at most PREVIEW_MAX. → { status, body } or { status, error, reason? }.
// `real` is the real path resolveIn checked: realpath's answer, never a written path (a short name in it would never match).
// The handle is opened first and then must still be that file (same volume and file id, and the path still resolving
// there), so a folder on the way swapped for a junction before the open is refused, and one swapped after it no longer
// matters: the bytes come from the handle.
export async function readPreview(abs, name, real) {
  const cls = previewClass(name);
  if (cls.preview === 'blocked') return { status: 403, error: 'blocked', reason: cls.reason };
  if (cls.preview !== 'text') return { status: 415, error: 'not a previewable type' };
  const h = await open(abs, 'r').catch(() => null);
  if (!h) return { status: 404, error: 'not found' };
  try {
    const [st, at, now] = await Promise.all([h.stat({ bigint: true }), stat(real, { bigint: true }).catch(() => null),
      realpath(abs).catch(() => null)]);
    if (!st.isFile() || !at || st.ino !== at.ino || st.dev !== at.dev || !now || norm(now) !== norm(real)) return { status: 404, error: 'not found' };
    if (st.size > BigInt(PREVIEW_MAX)) return { status: 413, error: 'too large to preview' };
    const buf = Buffer.alloc(PREVIEW_MAX), { bytesRead } = await h.read(buf, 0, PREVIEW_MAX, 0);
    const bytes = buf.subarray(0, bytesRead);
    if (bytes.subarray(0, SNIFF).includes(0)) return { status: 415, error: 'binary file' };
    return { status: 200, body: bytes.toString('utf8') };
  } finally { await h.close(); }
}
