import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rankCommands, KINDS, LIMIT } from '../public/command-rank.mjs';

const it = (kind, name, extra = {}) => ({ kind, id: name, name, ...extra });
const names = r => r.rows.map(x => x.name);

test('an empty or blank query gives no rows and no Knowledge row', () => {
  const items = [it('session', 'acme-api')];
  for (const q of ['', '   ', undefined]) assert.deepEqual(rankCommands(items, q), { rows: [], groups: [], knowledge: null });
});

test('an exact ticket id comes first, even from a kind that sorts later', () => {
  const items = [it('session', 'ACME-1420 notes'), it('session', 'ACME-142 helper', { ticket: 'ACME-142' }),
    it('issue', 'ACME-14 cache', { id: 'ACME-14', ticket: 'ACME-14' }), it('issue', 'ACME-142', { id: 'ACME-142', ticket: 'ACME-142' })];
  const r = rankCommands(items, 'acme-142');
  assert.equal(r.rows[0].kind, 'issue');
  assert.equal(r.rows[0].id, 'ACME-142');
  assert.equal(r.groups[0].kind, 'issue', 'the group holding the exact hit leads');
  // a longer id is not an exact match for a shorter query
  assert.notEqual(rankCommands([it('issue', 'ACME-1420', { id: 'ACME-1420', ticket: 'ACME-1420' }), it('session', 'acme-14 x')], 'ACME-14').rows[0].id, 'ACME-1420');
});

test('start of name beats start of a word, which beats anywhere', () => {
  const r = rankCommands([it('project', 'xx-portal'), it('project', 'my acme-portal'), it('project', 'portal-api'), it('project', 'reportal')], 'portal');
  assert.deepEqual(names(r), ['portal-api', 'xx-portal', 'my acme-portal', 'reportal']);
});

test('words start after a space, dash, underscore, slash, dot or hash', () => {
  for (const sep of [' ', '-', '_', '/', '.', '#']) {
    const r = rankCommands([it('pr', `zzportal`), it('pr', `acme${sep}portal`)], 'portal');
    assert.equal(r.rows[0].name, `acme${sep}portal`, JSON.stringify(sep));
  }
});

test('a word also starts after a bracket or any other character that is not a letter or digit', () => {
  for (const name of ['acme-1 review (portal)', 'acme:portal', 'acme[portal]', 'acme·portal']) {
    const r = rankCommands([it('session', 'zzportal'), it('session', name)], 'portal');
    assert.equal(r.rows[0].name, name);
  }
});

test('the first row is the best match: a better tier leads whatever its kind', () => {
  const r = rankCommands([it('session', 'acme-report-gen'), it('project', 'portal')], 'port');
  assert.deepEqual(r.groups.map(g => g.kind), ['project', 'session']);
  assert.equal(r.rows[0].name, 'portal');
  const you = rankCommands([it('panel', 'acme panel'), it('pr', 'acme pr', { you: true })], 'acme');
  assert.equal(you.rows[0].name, 'acme pr', 'within a tier, a group led by something waiting on you goes first');
});

test('withheld items take no place in the limit', () => {
  // the withheld ones would rank first (start of name), so dropping them after the cut would leave nothing
  const items = [...Array.from({ length: 10 }, (_, n) => it('project', `acme (excluded) ${n}`)), it('session', 'x acme'), it('session', 'y acme')];
  assert.deepEqual(names(rankCommands(items, 'acme')), ['x acme', 'y acme']);
});

test('waiting on you ranks first within a kind and tier, not above a better match', () => {
  const r = rankCommands([it('session', 'acme-b'), it('session', 'acme-a', { you: true }), it('session', 'x acme-c', { you: true })], 'acme');
  assert.deepEqual(names(r), ['acme-a', 'acme-b', 'x acme-c']);
  const same = rankCommands([it('session', 'acme-longer-name'), it('session', 'acme-y', { you: true })], 'acme');
  assert.equal(same.rows[0].name, 'acme-y');
});

test('ties go to the shorter name, then the original order', () => {
  const r = rankCommands([it('panel', 'acme two'), it('panel', 'acme 1'), it('panel', 'acme 2')], 'acme');
  assert.deepEqual(names(r), ['acme 1', 'acme 2', 'acme two']);
});

test('matching ignores case and surrounding space', () => {
  assert.deepEqual(names(rankCommands([it('view', 'Groom')], '  gROO ')), ['Groom']);
});

test('rows are cut to the limit, best first, then grouped by kind in display order', () => {
  assert.equal(LIMIT, 8);
  const items = [];
  for (let n = 0; n < 12; n++) items.push(it(n % 2 ? 'session' : 'project', `acme-${String(n).padStart(2, '0')}`));
  const r = rankCommands(items, 'acme');
  assert.equal(r.rows.length, 8);
  assert.deepEqual(r.groups.map(g => g.kind), ['session', 'project']);
  assert.deepEqual(r.rows, r.groups.flatMap(g => g.rows), 'rows are the groups, in order');
  assert.ok(r.rows.every(x => ['acme-00', 'acme-01', 'acme-02', 'acme-03', 'acme-04', 'acme-05', 'acme-06', 'acme-07'].includes(x.name)));
  assert.equal(rankCommands(items, 'acme', { limit: 3 }).rows.length, 3);
});

test('groups follow the kind order', () => {
  assert.deepEqual(KINDS, ['view', 'panel', 'session', 'ticket', 'issue', 'pr', 'project']);
  const items = KINDS.slice().reverse().map(k => it(k, `acme ${k}`));
  assert.deepEqual(rankCommands(items, 'acme').groups.map(g => g.kind), KINDS);
});

test('the Knowledge row is offered from two characters, and counts against no limit', () => {
  assert.equal(rankCommands([it('view', 'Groom')], 'g').knowledge, null);
  assert.deepEqual(rankCommands([], 'zz').knowledge, { text: 'zz' });
  const many = Array.from({ length: 20 }, (_, n) => it('session', `acme-${n}`));
  const r = rankCommands(many, '  acme ');
  assert.equal(r.rows.length, 8);
  assert.deepEqual(r.knowledge, { text: 'acme' });
});

test('a name the server withheld never appears, whatever is typed', () => {
  const items = [it('project', '(excluded)'), it('project', '(excluded)-plan.md'), it('session', 'acme-portal'),
    it('ticket', 'ACME-9 plan', { ticket: 'ACME-9' }), it('pr', 'ok', { ticket: '(excluded)' }), { kind: 'issue', id: '(excluded)', name: 'visible title' }];
  for (const q of ['excl', '(ex', '(excluded)', 'plan', 'portal', 'ok', 'visible', 'ACME-9', 'e']) {
    const r = rankCommands(items, q);
    for (const row of r.rows) assert.doesNotMatch(JSON.stringify(row), /\(excluded\)/, q);
  }
  assert.deepEqual(names(rankCommands(items, 'portal')), ['acme-portal']);
  assert.deepEqual(names(rankCommands(items, 'plan')), ['ACME-9 plan']);
  assert.equal(rankCommands(items, '(excluded)').rows.length, 0);
});

test('the input is not changed and the same input ranks the same', () => {
  const items = [it('pr', 'acme b'), it('pr', 'acme a', { you: true })];
  const copy = structuredClone(items);
  const a = rankCommands(items, 'acme'), b = rankCommands(items, 'acme');
  assert.deepEqual(items, copy);
  assert.deepEqual(a, b);
});

test('the module reads nothing and asks for nothing: no fetch, no import, no document', async () => {
  const src = await readFile(new URL('../public/command-rank.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /\bfetch\b|\bimport\b|\bdocument\b|\bwindow\b|XMLHttpRequest|sendBeacon/);
});
