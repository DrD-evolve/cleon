// Projects: each repo under ROOT's category folders (<ROOT>/<category>/<repo>), with git state.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from './bin.mjs'; // not node's: see bin.mjs

import { ROOT, CATEGORIES, EXCLUDE, excludesFolder as excluded, excludesPath } from './config.mjs';

// The configured category folders, or every folder under the root.
export async function categories(root = ROOT) {
  return CATEGORIES ?? (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name);
}

const git = (cwd, args) => new Promise(r =>
  execFile('git', ['-C', cwd, ...args], { timeout: 5000, windowsHide: true }, (e, out) => r(e ? null : out.trim())));

// Pure: `git status --porcelain=v2 --branch` → { branch, dirty }. A detached HEAD reads "HEAD", as
// `rev-parse --abbrev-ref HEAD` gave it; no output (git failed) gives no branch and nothing dirty.
export function parseStatus(out) {
  const lines = (out ?? '').split('\n').filter(Boolean);
  const head = lines.find(l => l.startsWith('# branch.head '))?.slice(14) ?? null;
  return { branch: head === '(detached)' ? 'HEAD' : head, dirty: lines.filter(l => !l.startsWith('#')).length };
}

// Runs fn over items, at most n at a time.
export async function eachAtMost(n, items, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}
// Folders read at once. Starting a program holds the server up while Windows creates it, so starting
// every repo's git together (~140 programs) froze it for seconds; a few at a time leaves room between.
const SCAN_AT_ONCE = 8;

// Each project folder under the category folders, as { name, category, path }. A category MC_EXCLUDE matches isn't
// read, and a folder it matches isn't returned: an excluded folder is never listed, read or named, not even counted.
async function* projectFolders(root, exclude) {
  for (const category of await categories(root)) {
    const dir = join(root, category);
    if (excluded(dir, exclude)) continue;
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, d.name);
      if (d.isDirectory() && !d.name.startsWith('.') && !excluded(path, exclude)) yield { name: d.name, category, path };
    }
  }
}

export async function listProjects(root = ROOT, exclude = EXCLUDE) {
  const out = [], dirs = [];
  for await (const f of projectFolders(root, exclude)) dirs.push(f);
  await eachAtMost(SCAN_AT_ONCE, dirs, async ({ name, category, path: cwd }) => {
    // A repo of its own has a .git entry (a folder, or a file for a worktree); a folder inside some
    // other repo has none. Checked without starting git, which costs a process per folder.
    const isRepo = await stat(join(cwd, '.git')).then(() => true, () => false);
    const p = { name, category, path: cwd, repo: isRepo, description: await describe(cwd, exclude) };
    if (isRepo) {
      // One status for both the branch and the changed files (ahead/behind isn't shown, so not counted).
      const [status, last] = await Promise.all([
        git(cwd, ['status', '--porcelain=v2', '--branch', '--no-ahead-behind']),
        git(cwd, ['log', '-1', '--format=%ct%x09%s']),
      ]);
      const [ts, ...subject] = (last ?? '').split('\t');
      Object.assign(p, { ...parseStatus(status), lastCommitAt: ts ? Number(ts) * 1000 : null, lastSubject: subject.join('\t') || null });
    }
    out.push(p);
  });
  return out.sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
}

// The project folder at exactly `path`, as listProjects() would list it, or null (so an excluded one is never found).
// Reads only folder listings, never git, so the project map's buttons don't wait on a scan of every repo.
export async function findProject(path, root = ROOT, exclude = EXCLUDE) {
  for await (const f of projectFolders(root, exclude)) if (f.path === path) return f;
  return null;
}

// Pure: the first prose paragraph of a Markdown file, as plain text. Headings, badges, images,
// quotes, lists, tables, code and front matter are skipped, and so is a paragraph wholly in parentheses.
export function firstParagraph(md, max = 400) {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/```[\s\S]*?```/g, '');
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length || lines.some(l => /^(#|!\[|\[!\[|>|[-*+] |\d+\. |\||<)/.test(l))) continue;
    const text = lines.join(' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
    if (!text || /^\(.*\)$/.test(text)) continue;
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }
  return null;
}

// A project's description: its README's first paragraph, else its CLAUDE.md's, else package.json's. A file
// MC_EXCLUDE matches isn't read, as for the knowledge map.
async function describe(dir, exclude) {
  const read = f => (excludesPath(join(dir, f), exclude) ? Promise.reject() : readFile(join(dir, f), 'utf8'));
  for (const f of ['README.md', 'readme.md', 'CLAUDE.md']) {
    const md = await read(f).catch(() => null);
    const text = md && firstParagraph(md);
    if (text) return text;
  }
  const pkg = await read('package.json').then(JSON.parse).catch(() => null);
  return typeof pkg?.description === 'string' && pkg.description.trim() ? pkg.description.trim() : null;
}
