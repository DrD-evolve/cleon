// Today view, part 1: reads the facts lib/today.mjs's rules need. Names, times and an ADR's status word only; no
// file's text is kept. Git runs only on repos that already have uncommitted changes, a few at a time, so the
// all-repos burst that once froze the server doesn't come back.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from './bin.mjs'; // not node's: see bin.mjs
import { excludesFolder, excludesPath } from './config.mjs';
import { eachAtMost } from './projects.mjs';
import { adrStatus, head } from './knowledge.mjs';

const AT_ONCE = 4, MAX_PATHS = 200, MAX_ADRS = 100;
const ADR_DIRS = ['adrs', 'adr', 'decisions', 'decision'];

const gitDefault = (cwd, args) => new Promise(r =>
  execFile('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], { timeout: 5000, windowsHide: true, maxBuffer: 8e6 }, (e, out) => r(e ? null : out)));

// Pure: `git status --porcelain=v2 --branch` (with ahead/behind) → { ahead, paths }.
export function parseDetail(out) {
  const lines = (out ?? '').split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
  const ab = lines.find(l => l.startsWith('# branch.ab '))?.match(/\+(\d+)/);
  const skip = { 1: 8, 2: 9, u: 10 }; // space-separated fields before the path
  const paths = [];
  for (const l of lines) {
    if (l.startsWith('? ')) paths.push(l.slice(2));
    else if (skip[l[0]] && l[1] === ' ') paths.push(l.split(' ').slice(skip[l[0]]).join(' ').split('\t')[0]);
  }
  return { ahead: ab ? Number(ab[1]) : 0, paths };
}

const mtimeOf = p => stat(p).then(s => s.mtimeMs, () => null);
const names = (dir, rx) => readdir(dir, { withFileTypes: true }).then(l => l.filter(d => d.isFile() && rx.test(d.name)).map(d => d.name), () => []);

// The facts for the rules. `git` is the runner (tests pass a stub that counts calls).
export async function readFacts({ projects, plansDirs = [], exclude, git = gitDefault }) {
  const live = projects.filter(p => !excludesFolder(p.path, exclude));
  const dirty = [];
  // Ahead/behind: only where uncommitted changes already exist.
  await eachAtMost(AT_ONCE, live.filter(p => p.repo && p.dirty > 0), async p => {
    const out = await git(p.path, ['status', '--porcelain=v2', '--branch']);
    if (out == null) return;
    const { ahead, paths } = parseDetail(out);
    const times = await Promise.all(paths.slice(0, MAX_PATHS).filter(f => !excludesPath(join(p.path, f), exclude)).map(f => mtimeOf(join(p.path, f))));
    dirty.push({ name: p.name, path: p.path, ahead, newestChange: times.filter(t => t != null).reduce((m, t) => Math.max(m, t), 0) || null });
  });
  const drafts = [], adrs = [];
  await eachAtMost(8, live, async p => {
    const dir = join(p.path, 'communications');
    if (!excludesFolder(dir, exclude)) {
      const files = [];
      for (const name of await names(dir, /\.(md|markdown|html?|txt|docx?)$/i)) {
        if (excludesPath(join(dir, name), exclude)) continue;
        const mtime = await mtimeOf(join(dir, name));
        if (mtime != null) files.push({ name, mtime });
      }
      if (files.length) drafts.push({ project: p.name, path: p.path, files });
    }
    for (const d of ADR_DIRS) {
      const adir = join(p.path, d);
      if (excludesFolder(adir, exclude)) continue;
      for (const name of (await names(adir, /\.(md|markdown)$/i)).slice(0, MAX_ADRS)) {
        const file = join(adir, name);
        if (excludesPath(file, exclude)) continue;
        // Only whether the status reads Proposed leaves this function.
        if (!/^proposed\b/i.test(adrStatus(await head(file)) ?? '')) continue;
        adrs.push({ project: p.name, path: p.path, file: `${d}/${name}`, proposed: true, mtime: await mtimeOf(file) ?? 0 });
      }
    }
  });
  const plans = [];
  for (const dir of plansDirs) {
    if (excludesFolder(dir, exclude)) continue;
    for (const file of await names(dir, /^[A-Z]+-\d+-plan\.md$/)) {
      if (excludesPath(join(dir, file), exclude)) continue;
      const mtime = await mtimeOf(join(dir, file));
      if (mtime != null) plans.push({ ticket: file.replace(/-plan\.md$/, ''), path: dir, file, mtime });
    }
  }
  return { projects: live, dirty, drafts, adrs, plans };
}
