import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTypeperf, vramByPid, gpuByPid, cpuByPid, parseTasklist } from '../lib/resources.mjs';

const csv = (header, ...rows) => [`"(PDH-CSV 4.0)","${header.join('","')}"`, ...rows.map(r => `"t","${r.join('","')}"`)].join('\r\n');

test('parseTypeperf drops a read whose rows do not line up with its header', () => {
  assert.deepEqual(parseTypeperf(csv(['a', 'b'], [1, 2])), { header: ['a', 'b'], rows: [[1, 2]] });
  // Instances appeared mid-read: values would land on the wrong names, so the read is discarded.
  assert.equal(parseTypeperf(csv(['a', 'b'], [1, 2, 3])), null);
  assert.equal(parseTypeperf(''), null);
});

test('vramByPid sums each pid across GPU adapters', () => {
  const tp = parseTypeperf(csv([
    '\\\\PC\\GPU Process Memory(pid_10_luid_0x1_phys_0)\\Dedicated Usage',
    '\\\\PC\\GPU Process Memory(pid_10_luid_0x2_phys_0)\\Dedicated Usage',
    '\\\\PC\\GPU Process Memory(pid_20_luid_0x1_phys_0)\\Dedicated Usage',
  ], [100, 50, 0]));
  assert.deepEqual([...vramByPid(tp)], [[10, 150]]);
});

test('gpuByPid reports the busiest engine type, like Task Manager', () => {
  const e = (pid, n, type) => `\\\\PC\\GPU Engine(pid_${pid}_luid_0x1_phys_0_eng_${n}_engtype_${type})\\Utilization Percentage`;
  const tp = parseTypeperf(csv([e(10, 0, '3D'), e(10, 1, '3D'), e(10, 2, 'VideoDecode')], [0, 0, 0], [20, 15, 30]));
  assert.deepEqual([...gpuByPid(tp)], [[10, 35]]); // 3D 20+15 beats VideoDecode 30
});

test('cpuByPid turns two CPU-time samples into % of the whole machine', () => {
  // 1 s apart on 4 cores: 1e7 (100 ns units) = 1 s of CPU = 25% of the machine.
  const prev = new Map([[1, 0], [2, 5e6], [3, null]]);
  const cur = new Map([[1, 1e7], [2, 5e6], [3, 1e7], [4, 1e7]]);
  assert.deepEqual([...cpuByPid(prev, cur, 1000, 4)], [[1, 25], [2, 0]]);
  assert.equal(cpuByPid(null, cur, 1000, 4).size, 0); // first sample: no CPU % yet
});

test('parseTasklist reads names, pids and working sets', () => {
  const text = '"System Idle Process","0","Services","0","8 K"\r\n"vmmemWSL","61380","Services","0","9,239,552 K"\r\n"chrome.exe","36756","Console","2","412,004 K"';
  assert.deepEqual(parseTasklist(text), [
    { pid: 61380, name: 'vmmemWSL', ram: 9239552 * 1024 },
    { pid: 36756, name: 'chrome', ram: 412004 * 1024 },
  ]);
});
