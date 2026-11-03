// Projects: each repo under ROOT's category folders (<ROOT>/<category>/<repo>), with git state.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

import { ROOT, CATEGORIES, EXCLUDE } from './config.mjs';

// The configured category folders, or every folder under the root.
export async function categories(root = ROOT) {
  return CATEGORIES ?? (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name);
}

const git = (cwd, args) => new Promise(r =>
  execFile('git', ['-C', cwd, ...args], { timeout: 5000, windowsHide: true }, (e, out) => r(e ? null : out.trim())));

export async function listProjects(root = ROOT) {
  const out = [];
  for (const category of await categories(root)) {
    const dirs = (await readdir(join(root, category), { withFileTypes: true }).catch(() => []))
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));
    await Promise.all(dirs.map(async d => {
      const cwd = join(root, category, d.name);
      const top = await git(cwd, ['rev-parse', '--show-toplevel']);
      const isRepo = top && top.replace(/\\/g, '/').toLowerCase() === cwd.replace(/\\/g, '/').toLowerCase();
      const p = { name: d.name, category, path: cwd, repo: Boolean(isRepo), description: await describe(cwd) };
      if (isRepo) {
        const [branch, status, last] = await Promise.all([
          git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
          git(cwd, ['status', '--porcelain']),
          git(cwd, ['log', '-1', '--format=%ct%x09%s']),
        ]);
        const [ts, ...subject] = (last ?? '').split('\t');
        Object.assign(p, { branch, dirty: status ? status.split('\n').length : 0,
          lastCommitAt: ts ? Number(ts) * 1000 : null, lastSubject: subject.join('\t') || null });
      }
      out.push(p);
    }));
  }
  return out.sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
}

// The project folder at exactly `path`, as listProjects() would list it, or null. Reads only folder
// listings, never git, so the project map's buttons don't wait on a scan of every repo.
export async function findProject(path, root = ROOT) {
  for (const category of await categories(root)) {
    const d = (await readdir(join(root, category), { withFileTypes: true }).catch(() => []))
      .find(d => d.isDirectory() && !d.name.startsWith('.') && join(root, category, d.name) === path);
    if (d) return { name: d.name, category, path };
  }
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

// A project's description: its README's first paragraph, else its CLAUDE.md's, else package.json's.
// Folders matching MC_EXCLUDE are never read.
async function describe(dir) {
  if (EXCLUDE.test(dir)) return null;
  for (const f of ['README.md', 'readme.md', 'CLAUDE.md']) {
    const md = await readFile(join(dir, f), 'utf8').catch(() => null);
    const text = md && firstParagraph(md);
    if (text) return text;
  }
  const pkg = await readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
  return typeof pkg?.description === 'string' && pkg.description.trim() ? pkg.description.trim() : null;
}

// The project map: the root, every category folder (empty ones too) and the projects in them.
export async function projectMap(root = ROOT) {
  return { root, categories: await categories(root), projects: await listProjects(root) };
}
