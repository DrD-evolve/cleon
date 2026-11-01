// Docker: what's running, what Docker's disk holds, and cleanup actions. All through the docker CLI.
//   docker system df -v   images, containers, volumes, build cache with sizes (one call)
//   docker stats          CPU / memory of running containers (only when some are running)
//   docker image inspect  when each image was pulled (Metadata.LastTagTime)
//   docker events         container starts, recorded per image while the server runs — Docker
//                         keeps no "last used" for images, and its event history is lost on restart
//   docker_data.vhdx      Docker Desktop's disk file; it never shrinks when Docker frees space
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = (args, timeout = 30000) => new Promise(resolve =>
  execFile('docker', args, { timeout, windowsHide: true, maxBuffer: 20e6 }, (err, out, errOut) =>
    resolve({ ok: !err, out: out ?? '', err: (errOut || err?.message || '').trim() })));

// Pure: docker's human sizes ("2.344GB", "359.8MB (100%)", "0B", "1.5GiB") → bytes. Docker uses SI units.
export function parseSize(s) {
  const m = String(s ?? '').match(/^([\d.]+)\s*([kKMGTP]?)(i?)B/);
  if (!m) return null;
  const pow = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[m[2]];
  return Math.round(Number(m[1]) * (m[3] ? 1024 : 1000) ** pow);
}
// Pure: "2026-08-27 10:03:39 -0700 PDT" → epoch ms.
export function parseDockerTime(s) {
  const m = String(s ?? '').match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)/);
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : null;
}
// Pure: the forms an image reference takes ("postgres", "docker.io/library/postgres:latest") → one key.
export function normRef(ref) {
  let r = String(ref ?? '').replace(/^docker\.io\//, '').replace(/^library\//, '');
  if (!r.includes('@') && !/:[^/]+$/.test(r)) r += ':latest';
  return r;
}

// Pure: `docker system df -v --format json` + pull times + recorded last use → the panel's view.
export function shapeDf(df, pulled = new Map(), lastUsed = {}) {
  const images = (df.Images ?? []).map(i => {
    const tagged = i.Repository && i.Repository !== '<none>';
    const ref = tagged ? `${i.Repository}:${i.Tag}` : null;
    return { id: i.ID, ref, size: parseSize(i.Size), unique: parseSize(i.UniqueSize), containers: Number(i.Containers) || 0,
      created: parseDockerTime(i.CreatedAt), pulled: pulled.get(i.ID) ?? null };
  });
  const containers = (df.Containers ?? []).map(c => ({ id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status,
    created: parseDockerTime(c.CreatedAt), size: parseSize(c.Size) }));
  // Last use: a start the server saw, or a container (running = now) that still exists, whichever is later.
  for (const im of images) {
    const keys = [im.ref && normRef(im.ref), im.id, im.id.replace(/^sha256:/, '').slice(0, 12)].filter(Boolean);
    let t = Math.max(0, ...keys.map(k => lastUsed[k] ?? 0));
    for (const c of containers) if (keys.includes(normRef(c.image)) || keys.includes(c.image))
      t = Math.max(t, c.state === 'running' ? Date.now() : c.created ?? 0);
    im.lastUsed = t || null;
  }
  const volumes = (df.Volumes ?? []).map(v => ({ name: v.Name, anonymous: /com\.docker\.volume\.anonymous/.test(v.Labels ?? ''),
    links: Number(v.Links) || 0, size: parseSize(v.Size) }));
  const cache = (df.BuildCache ?? []).map(b => ({ size: parseSize(b.Size), inUse: b.InUse === 'true' || b.InUse === true, shared: b.Shared === 'true' || b.Shared === true }));
  const sum = (xs, f = () => true) => xs.filter(f).reduce((a, x) => a + (x.size ?? 0), 0);
  // An image with several tags is one row per tag but takes its space once.
  const uniqImages = [...new Map(images.map(i => [i.id, i])).values()];
  return {
    images, containers, volumes,
    totals: {
      images: { count: uniqImages.length, size: sum(uniqImages), reclaimable: sum(uniqImages, i => !i.containers) },
      containers: { count: containers.length, size: sum(containers), reclaimable: sum(containers, c => c.state !== 'running') },
      // Only anonymous, unattached volumes count: `docker volume prune` leaves named volumes alone.
      volumes: { count: volumes.length, size: sum(volumes), reclaimable: sum(volumes, v => v.anonymous && !v.links) },
      build: { count: cache.length, size: sum(cache), reclaimable: sum(cache, b => !b.inUse && !b.shared) },
    },
  };
}

// ---- Last use, recorded from container-start events while the server runs ----
const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'docker-last-used.json');
let lastUsed = (() => { try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return {}; } })();
let watcher = null;
export function watchDockerEvents() {
  if (watcher) return;
  watcher = spawn('docker', ['events', '--filter', 'type=container', '--filter', 'event=start', '--format', '{{json .}}'], { windowsHide: true });
  let buf = '';
  watcher.stdout.on('data', d => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      try {
        const e = JSON.parse(l), image = e.Actor?.Attributes?.image, t = Math.floor((e.timeNano ?? e.time * 1e9) / 1e6);
        if (image) lastUsed[normRef(image)] = t;
        if (e.from && e.from !== image) lastUsed[normRef(e.from)] = t;
      } catch { /* partial or foreign line */ }
    }
    try { mkdirSync(dirname(STORE), { recursive: true }); writeFileSync(STORE, JSON.stringify(lastUsed, null, 1)); } catch { /* kept in memory */ }
  });
  watcher.on('error', () => {});
  // Docker not running, or restarted: try again in a minute.
  watcher.on('close', () => { watcher = null; setTimeout(watchDockerEvents, 60_000).unref(); });
}

// Pure: `docker system df -v` lists one tag per image, so a second tag of an image disappears from it.
// The rows come from `docker image ls` (one per tag); unique size and container count from df, by id.
export function mergeImages(lsRows, dfImages) {
  const byId = new Map((dfImages ?? []).map(i => [i.ID, i]));
  return lsRows.map(r => ({ ...r, UniqueSize: byId.get(r.ID)?.UniqueSize ?? r.Size, Containers: byId.get(r.ID)?.Containers ?? r.Containers }));
}
async function readDf() {
  const [df, ls] = await Promise.all([run(['system', 'df', '-v', '--format', '{{json .}}']), run(['image', 'ls', '--no-trunc', '--format', '{{json .}}'])]);
  if (!df.ok || !ls.ok) return null;
  const raw = JSON.parse(df.out);
  return { ...raw, Images: mergeImages(ls.out.split('\n').filter(Boolean).map(l => JSON.parse(l)), raw.Images) };
}

// ---- Snapshot ----
const VHDX = join(process.env.LOCALAPPDATA ?? '', 'Docker', 'wsl', 'disk', 'docker_data.vhdx');
export async function sampleDocker() {
  const at = Date.now();
  const [ver, df] = await Promise.all([run(['version', '--format', '{{.Server.Version}}'], 8000), readDf()]);
  const disk = await stat(VHDX).then(s => ({ path: VHDX, size: s.size })).catch(() => null);
  if (!ver.ok || !df) return { at, up: false, error: ver.err.split('\n')[0] || 'docker is not responding', disk };
  const view = shapeDf(df, await pullTimes(df.Images), lastUsed);
  if (view.containers.some(c => c.state === 'running')) {
    const st = await run(['stats', '--no-stream', '--format', '{{json .}}'], 15000);
    const byId = new Map(st.out.split('\n').filter(Boolean).map(l => { try { const s = JSON.parse(l); return [s.ID, s]; } catch { return [null, null]; } }));
    for (const c of view.containers) {
      const s = [...byId.values()].find(s => s && c.id.startsWith(s.ID));
      if (s) Object.assign(c, { cpu: parseFloat(s.CPUPerc), mem: parseSize(s.MemUsage), memPct: parseFloat(s.MemPerc) });
    }
  }
  return { at, up: true, version: ver.out.trim(), disk, ...view };
}
async function pullTimes(images) {
  if (!images.length) return new Map();
  const r = await run(['image', 'inspect', ...images.map(i => i.ID), '--format', '{{.Id}}|{{.Metadata.LastTagTime}}']);
  return new Map(r.out.split('\n').filter(Boolean).map(l => { const [id, t] = l.split('|'); const ms = Date.parse(t); return [id, ms > 0 ? ms : null]; }));
}

// ---- Actions. Each re-checks against a fresh listing; nothing from the browser reaches the CLI unchecked. ----
const PRUNE = {
  containers: ['container', 'prune', '-f'],
  build: ['builder', 'prune', '-f'],
  volumes: ['volume', 'prune', '-f'], // anonymous volumes only (named need -a, which this never passes)
  dangling: ['image', 'prune', '-f'], // untagged images only
};
export async function pruneDocker(what) {
  if (!PRUNE[what]) return { ok: false, reason: `unknown cleanup "${what}"` };
  const r = await run(PRUNE[what], 120000);
  const freed = r.out.match(/Total reclaimed space:\s*(.+)/)?.[1]?.trim();
  return r.ok ? { ok: true, freed: freed ?? '0B' } : { ok: false, reason: r.err.split('\n')[0] };
}
// Removes one image row: by tag when tagged (other tags of the same image stay), by id when not.
// Never forced, so an image a container still uses is refused by Docker itself.
export async function removeImage(id, ref) {
  const df = await readDf();
  if (!df) return { ok: false, reason: 'docker is not responding' };
  const tagOf = i => i.Repository && i.Repository !== '<none>' ? `${i.Repository}:${i.Tag}` : null;
  const im = df.Images.find(i => i.ID === id && tagOf(i) === (ref ?? null));
  if (!im) return { ok: false, reason: 'image no longer exists or was retagged' };
  const tagged = Boolean(ref);
  const r = await run(['image', 'rm', tagged ? ref : id], 60000);
  // Removing one of several tags only untags: Docker prints "Deleted:" only when layers go.
  return r.ok ? { ok: true, freed: /Deleted:/.test(r.out) ? im.UniqueSize : '0B (untagged; another tag still uses the image)' }
    : { ok: false, reason: r.err.split('\n')[0] };
}
