import { test } from 'node:test';
import assert from 'node:assert/strict';
// Independent of this machine's .env: pin a forward-slash exclusion pattern before the module reads it
// (an existing env var wins over .env, and static imports would load first).
process.env.MC_EXCLUDE = String.raw`C:/dev/ACME-private`;
const { blank, scanLines } = await import('../lib/usage.mjs');

const user = (cwd, content) => JSON.stringify({ type: 'user', timestamp: '2026-11-03T10:00:00Z', cwd, message: { content } });

test('a backslash cwd under a forward-slash MC_EXCLUDE pattern is excluded, and its prompt is not read', () => {
  const st = scanLines([user(String.raw`C:\dev\ACME-private\notes`, 'GOAL: Add a status page (ACME-13).')], blank());
  assert.equal(st.excluded, true);
  assert.equal(st.workTicket, undefined);
  assert.equal(scanLines([user(String.raw`C:\dev\ACME-public`, 'x')], blank()).excluded, false);
});
