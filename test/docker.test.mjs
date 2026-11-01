import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSize, parseDockerTime, normRef, shapeDf, mergeImages } from '../lib/docker.mjs';

test('parseSize reads docker SI sizes, binary sizes and reclaimable strings', () => {
  assert.equal(parseSize('2.344GB'), 2344000000);
  assert.equal(parseSize('359.8MB (100%)'), 359800000);
  assert.equal(parseSize('0B'), 0);
  assert.equal(parseSize('1.5GiB / 31GiB'), 1610612736);
  assert.equal(parseSize('N/A'), null);
});

test('parseDockerTime keeps the offset', () => {
  assert.equal(parseDockerTime('2026-08-27 10:03:39 -0700 PDT'), Date.parse('2026-08-27T17:03:39Z'));
  assert.equal(parseDockerTime('nope'), null);
});

test('normRef treats the short and fully qualified forms of a reference as one', () => {
  assert.equal(normRef('postgres'), 'postgres:latest');
  assert.equal(normRef('docker.io/library/postgres:16'), 'postgres:16');
  assert.equal(normRef('localhost:5000/app'), 'localhost:5000/app:latest');
  assert.equal(normRef('mcr.microsoft.com/powershell:latest'), 'mcr.microsoft.com/powershell:latest');
});

test('shapeDf: last use from recorded starts and existing containers; only safe space counts as reclaimable', () => {
  const df = {
    Images: [
      { ID: 'sha256:aaa111222333444', Repository: 'postgres', Tag: '16', Size: '642MB', UniqueSize: '641.7MB', Containers: '1', CreatedAt: '2026-08-13 12:16:08 -0700 PDT' },
      { ID: 'sha256:bbb111222333444', Repository: 'node', Tag: '24-slim', Size: '332MB', UniqueSize: '332MB', Containers: '0', CreatedAt: '2026-08-27 10:03:39 -0700 PDT' },
      { ID: 'sha256:ccc111222333444', Repository: '<none>', Tag: '<none>', Size: '10MB', UniqueSize: '10MB', Containers: '0', CreatedAt: '2026-08-27 10:03:39 -0700 PDT' },
    ],
    Containers: [{ ID: 'c1', Names: 'db', Image: 'docker.io/library/postgres:16', State: 'exited', Status: 'Exited (0)', CreatedAt: '2026-10-01 09:00:00 +0000 UTC', Size: '1MB' }],
    Volumes: [
      { Name: 'x', Labels: 'com.docker.volume.anonymous=', Links: '0', Size: '100MB' },
      { Name: 'pgdata', Labels: '', Links: '0', Size: '50MB' },
    ],
    BuildCache: [{ Size: '5MB', InUse: 'false', Shared: 'false' }, { Size: '7MB', InUse: 'true', Shared: 'false' }],
  };
  const v = shapeDf(df, new Map([['sha256:bbb111222333444', 1]]), { 'node:24-slim': 42 });
  assert.equal(v.images[0].lastUsed, Date.parse('2026-10-01T09:00:00Z'));
  assert.equal(v.images[1].lastUsed, 42);
  assert.equal(v.images[1].pulled, 1);
  assert.equal(v.images[2].ref, null);
  assert.equal(v.images[2].lastUsed, null);
  assert.equal(v.totals.images.reclaimable, 342000000);
  assert.equal(v.totals.containers.reclaimable, 1000000);
  assert.equal(v.totals.volumes.reclaimable, 100000000); // the named volume is never counted
  assert.equal(v.totals.build.reclaimable, 5000000);
});

test('shapeDf counts an image with two tags once', () => {
  const im = { ID: 'sha256:aaa', Size: '100MB', UniqueSize: '100MB', Containers: '0' };
  const v = shapeDf({ Images: [{ ...im, Repository: 'a', Tag: '1' }, { ...im, Repository: 'b', Tag: '2' }] });
  assert.equal(v.images.length, 2);
  assert.deepEqual(v.totals.images, { count: 1, size: 100000000, reclaimable: 100000000 });
});

test('mergeImages keeps every tag and takes unique size and containers from df by id', () => {
  const ls = [{ ID: 'sha256:a', Repository: 'node', Tag: '24', Size: '332MB', Containers: 'N/A' },
    { ID: 'sha256:a', Repository: 'mc', Tag: 'x', Size: '332MB', Containers: 'N/A' }];
  const m = mergeImages(ls, [{ ID: 'sha256:a', UniqueSize: '300MB', Containers: '2' }]);
  assert.deepEqual(m.map(i => [i.Repository, i.UniqueSize, i.Containers]), [['node', '300MB', '2'], ['mc', '300MB', '2']]);
});
