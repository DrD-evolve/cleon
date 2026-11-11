// Saved files are written to a temporary file in the same folder and renamed over the target, so a crash
// mid-write leaves the old file whole. Each write has its own temporary name, so saves at once never share one.
import { writeFile, rename, mkdir, unlink, readdir, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

let counter = 0;
// On Windows a rename over a file someone has open (a reader, a virus scan, the indexer) can fail for a moment.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TRIES = 5, WAIT = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// `io` is for tests: { writeFile, rename } to stand in for the real ones.
export async function writeFileAtomic(file, data, { writeFile: write = writeFile, rename: move = rename } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++counter}.tmp`;
  try {
    await write(tmp, data);
    for (let i = 1; ; i++) {
      try { return await move(tmp, file); } catch (e) {
        if (!BUSY.has(e?.code) || i >= TRIES) throw e;
        await sleep(WAIT * 2 ** (i - 1)); // 10, 20, 40, 80 ms
      }
    }
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// Remove temporary files a crash left beside `file`, once they are older than `maxAge` ms (one a live save is
// still writing is newer than that).
export async function sweepTemps(file, maxAge = 60e3) {
  const dir = dirname(file), prefix = `${basename(file)}.`;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (s && Date.now() - s.mtimeMs > maxAge) await unlink(join(dir, name)).catch(() => {});
  }
}
