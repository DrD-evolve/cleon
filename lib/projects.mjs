// Projects: each repo under ROOT's category folders (<ROOT>/<category>/<repo>), with git state.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

import { ROOT, CATEGORIES } from './config.mjs';

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
      const p = { name: d.name, category, path: cwd, repo: Boolean(isRepo) };
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
