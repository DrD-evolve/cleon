import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
// Token blocks hold the only colour literals and size values: the first top-level block, `:root { ... }`.
const root = css.match(/^:root \{[\s\S]*?^\}/m)[0];
const rest = css.replace(root, '');

test('no colour literal outside the token block', () => {
  assert.deepEqual(rest.match(/rgba?\(|hsla?\(|#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
});

test('no font size written outside the token block', () => {
  assert.deepEqual(rest.match(/font-size: *[0-9.]+px|font: *[0-9 ]*[0-9.]+px/g) ?? [], []);
});

test('pink is used for waiting on you only: never on the clock, links or notes', () => {
  for (const sel of ['.clock', '.tile-body a', '.pm-insights']) {
    const rule = rest.match(new RegExp(`^${sel.replace(/[.]/g, '\.')} \{[^}]*\}`, 'm'))?.[0] ?? '';
    assert.ok(rule && !/--(attention|magenta)/.test(rule), `${sel} must not use pink`);
  }
});

test('one rule stops repeating animations for reduced motion and for calm', () => {
  assert.match(rest, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; \}/);
  for (const part of ['*', '*::before', '*::after']) assert.ok(rest.includes(`:root[data-motion="calm"] ${part}`), part);
});

test('buttons, inputs and links get a focus-visible outline in the accent', () => {
  const rule = rest.match(/:focus-visible \{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /outline: 2px solid var\(--accent\)/);
  assert.ok(!/#[\w-]+:focus \{[^}]*outline: none/.test(rest), 'no :focus rule may switch the outline off');
});
