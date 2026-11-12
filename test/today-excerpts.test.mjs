import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { parseRead, sectionOf, newestEntry, activeProjects, collectExcerpts, openText, LIMITS } from '../lib/today-excerpts.mjs';
import { plannerInput, todayPrompt } from '../lib/today-plan.mjs';

const NOW = new Date(2026, 10, 12, 8, 5).getTime(), D = 864e5;
const none = /(?!)/;
const proj = (name, o = {}) => ({ name, path: `/work/tools/${name}`, repo: true, lastCommitAt: NOW - 2 * D, ...o });
const CLAUDE_MD = (blockers = 'Waiting on the ACME review.') => `# Notes\nIntro\n\n## Blockers\n${blockers}\n\n## Other\nunrelated text\n`;
const CHANGELOG = '# Changelog\n\n## Unreleased\n\n## 1.2.0 - 2026-11-01\n- Added a thing\n\n## 1.1.0\n- Old news\n';
// A reader over a fake disk that records every path it is asked for.
const disk = files => { const seen = []; return { seen, open: async p => { seen.push(p.replace(/\\/g, '/')); return files[p.replace(/\\/g, '/')] ?? null; } }; };

test('parseRead: only the two known categories, and the rest named so the server can say so', () => {
  assert.deepEqual(parseRead(undefined), { read: [], unknown: [] });
  assert.deepEqual(parseRead(' claude-md , Changelog,source,todo'), { read: ['claude-md', 'changelog'], unknown: ['source', 'todo'] });
});

test('sectionOf: the blockers or next-steps section only, to the next heading of its level, with code stripped', () => {
  assert.equal(sectionOf(CLAUDE_MD()), '## Blockers\nWaiting on the ACME review.');
  assert.equal(sectionOf('# A\n### Next steps\n- one\n- two\n#### sub\ndetail\n### Done\nno'), '### Next steps\n- one\n- two\n#### sub\ndetail');
  assert.equal(sectionOf('## Blockers\n```js\nconst secret = 1;\n```\nreal text\n~~~\nmore code\n~~~\n'), '## Blockers\nreal text');
  assert.equal(sectionOf('## Blockers\n\n## Next\nx'), null, 'an empty section');
  assert.equal(sectionOf('# Notes\ntext\n## Architecture\nTODO: fix this'), null, 'no such section: nothing, and no TODO search');
  assert.equal(sectionOf('## Blockers\n' + 'word '.repeat(400), 100).length, 100);
});

test('newestEntry: the first entry with a body, an empty Unreleased skipped', () => {
  assert.equal(newestEntry(CHANGELOG), '## 1.2.0 - 2026-11-01\n- Added a thing');
  assert.equal(newestEntry('# Changelog\nno entries'), null);
});

test('activeProjects: a commit or an uncommitted change in the last 7 days, newest first; excluded folders out', () => {
  const projects = [proj('old', { lastCommitAt: NOW - 8 * D }), proj('new', { lastCommitAt: NOW - D }), proj('dirty', { lastCommitAt: NOW - 30 * D }),
    proj('stale-dirty', { lastCommitAt: NOW - 30 * D }), proj('nogit', { repo: false, lastCommitAt: null }), proj('secret-x', { lastCommitAt: NOW - D })];
  const dirty = [{ path: '/work/tools/dirty', newestChange: NOW - 3 * D }, { path: '/work/tools/stale-dirty', newestChange: NOW - 9 * D }];
  assert.deepEqual(activeProjects({ projects, dirty, now: NOW, exclude: /secret/i }).map(p => p.name), ['new', 'dirty']);
});

test('with MC_TODAY_READ unset no excerpt is sent and no file is opened', async () => {
  const d = disk({ '/work/tools/acme-web/CLAUDE.md': CLAUDE_MD() });
  assert.deepEqual(await collectExcerpts({ projects: [proj('acme-web')], dirty: [], read: parseRead(undefined).read, now: NOW, exclude: none, open: d.open }), []);
  assert.deepEqual(d.seen, []);
  const p = todayPrompt({ now: NOW, hours: { start: 480, end: 1020 }, input: plannerInput({ candidates: { items: [], opportunities: [] }, excerpts: [] }) });
  assert.ok(p.includes('excerpts: []'));
});

test('a category not listed in MC_TODAY_READ is never read nor sent', async () => {
  const files = { '/work/tools/acme-web/CLAUDE.md': CLAUDE_MD(), '/work/tools/acme-web/CHANGELOG.md': CHANGELOG };
  const only = async read => { const d = disk(files); const ex = await collectExcerpts({ projects: [proj('acme-web')], dirty: [], read, now: NOW, exclude: none, open: d.open }); return { ex, seen: d.seen }; };
  const a = await only(['claude-md']);
  assert.deepEqual([a.ex.map(e => e.category), a.seen], [['claude-md'], ['/work/tools/acme-web/CLAUDE.md']]);
  const b = await only(['changelog']);
  assert.deepEqual([b.ex.map(e => e.category), b.seen], [['changelog'], ['/work/tools/acme-web/CHANGELOG.md']]);
  assert.deepEqual((await only(['claude-md', 'changelog'])).ex.map(e => e.category), ['claude-md', 'changelog']);
});

test('a folder MC_EXCLUDE matches is never opened, nor is an excluded file; text MC_EXCLUDE matches is dropped', async () => {
  const files = { '/work/tools/acme-web/CLAUDE.md': CLAUDE_MD(), '/work/tools/secret-proj/CLAUDE.md': CLAUDE_MD('SECRET-PLAN'),
    '/work/tools/acme-api/CLAUDE.md': CLAUDE_MD('talk to payroll'), '/work/tools/acme-api/CHANGELOG.md': CHANGELOG };
  const d = disk(files);
  const ex = await collectExcerpts({ projects: [proj('acme-web'), proj('secret-proj'), proj('acme-api')], dirty: [], read: ['claude-md', 'changelog'], now: NOW,
    exclude: /secret-proj|payroll|acme-api[\\/]CHANGELOG/i, open: d.open });
  assert.deepEqual(ex.map(e => [e.project, e.category]), [['acme-web', 'claude-md']]);
  assert.ok(!d.seen.some(p => p.includes('secret-proj')), 'an excluded folder was opened');
  assert.ok(!d.seen.some(p => p.includes('acme-api/CHANGELOG')), 'an excluded file was opened');
  assert.ok(!JSON.stringify(ex).includes('SECRET-PLAN') && !JSON.stringify(ex).includes('payroll'));
});

test('a project with no commit and no uncommitted change in the last 7 days is never opened', async () => {
  const d = disk({ '/work/tools/idle/CLAUDE.md': CLAUDE_MD('IDLE-TEXT'), '/work/tools/busy/CLAUDE.md': CLAUDE_MD() });
  const ex = await collectExcerpts({ projects: [proj('idle', { lastCommitAt: NOW - 8 * D }), proj('busy')], dirty: [{ path: '/work/tools/idle', newestChange: NOW - 8 * D }], read: ['claude-md'], now: NOW, exclude: none, open: d.open });
  assert.deepEqual(ex.map(e => e.project), ['busy']);
  assert.deepEqual(d.seen, ['/work/tools/busy/CLAUDE.md']);
});

test('size limits: per excerpt, in total, and in projects', async () => {
  const big = CLAUDE_MD('x'.repeat(5000));
  const projects = Array.from({ length: 12 }, (_, n) => proj(`p${n}`, { lastCommitAt: NOW - n * 1000 }));
  const files = Object.fromEntries(projects.map(p => [`${p.path}/CLAUDE.md`, big]));
  const ex = await collectExcerpts({ projects, dirty: [], read: ['claude-md'], now: NOW, exclude: none, open: disk(files).open });
  assert.ok(ex.every(e => e.text.length <= LIMITS.perExcerpt), 'per excerpt');
  assert.ok(ex.reduce((n, e) => n + e.text.length, 0) <= LIMITS.total, 'in total');
  assert.equal(ex.length, 5, '3000 / 600');
  const few = await collectExcerpts({ projects, dirty: [], read: ['claude-md'], now: NOW, exclude: none, open: disk(files).open, limits: { ...LIMITS, perExcerpt: 100, total: 10000 } });
  assert.equal(few.length, LIMITS.projects, 'at most 8 projects');
  assert.deepEqual(few.map(e => e.project), projects.slice(0, 8).map(p => p.name), 'the most recently active first');
  const tail = await collectExcerpts({ projects, dirty: [], read: ['claude-md'], now: NOW, exclude: none, open: disk(files).open, limits: { ...LIMITS, perExcerpt: 400, total: 1000 } });
  assert.ok(tail.reduce((n, e) => n + e.text.length, 0) <= 1000);
});

test('it opens nothing but each active project\'s CLAUDE.md and CHANGELOG.md: the exact list of paths, and no directory is listed', async () => {
  const d = disk({});
  const projects = [proj('a'), proj('b')];
  await collectExcerpts({ projects, dirty: [], read: ['claude-md', 'changelog'], now: NOW, exclude: none, open: d.open });
  assert.deepEqual(d.seen, ['/work/tools/a/CLAUDE.md', '/work/tools/a/CHANGELOG.md', '/work/tools/b/CLAUDE.md', '/work/tools/b/CHANGELOG.md']);
});

test('on a real temp tree: source code and TODO text never reach the text sent, a link is not followed, the file is read from disk only by name', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'cleon-today-excerpt-')), MARK = 'ZXQ-MARKER-3317';
  try {
    const p = join(root, 'acme-web');
    await mkdir(join(p, 'src'), { recursive: true });
    await writeFile(join(p, 'src', 'app.js'), `// TODO ${MARK}\n// FIXME ${MARK}\nexport const x = 1;\n`);
    await writeFile(join(p, 'README.md'), `${MARK} readme`);
    await writeFile(join(p, 'CLAUDE.md'), `# Project\n// TODO ${MARK}\n## Next steps\n- ship the thing\n\`\`\`\nconst ${MARK} = 1\n\`\`\`\n## Architecture\n${MARK}\n`);
    await writeFile(join(p, 'CHANGELOG.md'), `# Changelog\n## 2.0\n- big change\n## 1.0\n${MARK}\n`);
    const calls = [];
    const spy = async f => { calls.push(f.replace(/\\/g, '/')); return openText(f); };
    const ex = await collectExcerpts({ projects: [{ name: 'acme-web', path: p, lastCommitAt: NOW - D }], dirty: [], read: ['claude-md', 'changelog'], now: NOW, exclude: none, open: spy });
    assert.deepEqual(ex.map(e => e.text), ['## Next steps\n- ship the thing', '## 2.0\n- big change']);
    assert.ok(!JSON.stringify(ex).includes(MARK));
    assert.deepEqual(calls.map(c => c.slice(p.replace(/\\/g, '/').length + 1)), ['CLAUDE.md', 'CHANGELOG.md']);
    // A CLAUDE.md that is a link is refused, not followed.
    const q = join(root, 'linked');
    await mkdir(q);
    await symlink(join(p, 'README.md'), join(q, 'CLAUDE.md')).then(async () => {
      assert.equal(await openText(join(q, 'CLAUDE.md')), null);
    }, () => { /* no symlink right on this machine */ });
    assert.equal(await openText(join(p, 'src')), null, 'a folder');
    assert.equal(await openText(join(p, 'missing.md')), null);
    assert.equal((await openText(join(p, 'CLAUDE.md'), 10)).length, 10, 'only the first bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the text that would go to the planner carries no excluded, unlisted, idle or oversized excerpt', async () => {
  const files = { '/work/tools/acme-web/CLAUDE.md': CLAUDE_MD('WEB-BLOCKER'), '/work/tools/acme-web/CHANGELOG.md': CHANGELOG,
    '/work/tools/secret-proj/CLAUDE.md': CLAUDE_MD('SECRET-BLOCKER'), '/work/tools/idle/CLAUDE.md': CLAUDE_MD('IDLE-BLOCKER') };
  const ex = await collectExcerpts({ projects: [proj('acme-web'), proj('secret-proj'), proj('idle', { lastCommitAt: NOW - 20 * D })], dirty: [], read: ['claude-md'], now: NOW, exclude: /secret/i, open: disk(files).open });
  const prompt = todayPrompt({ now: NOW, hours: { start: 480, end: 1020 }, input: plannerInput({ candidates: { items: [], opportunities: [] }, excerpts: ex }) });
  assert.ok(prompt.includes('WEB-BLOCKER'));
  for (const gone of ['SECRET-BLOCKER', 'IDLE-BLOCKER', 'Added a thing', 'secret-proj']) assert.ok(!prompt.includes(gone), gone);
});
