// The Knowledge map's radial layout, apart from drawing so it can be tested: the /api/knowledge tree in, positions out.
// Pure: no DOM, no clock, no randomness, and the tree isn't changed. The page (app.js) imports it, and so do the tests.
//
// World units, MC_ROOT's CLAUDE.md at 0,0; angles in radians, clockwise from 3 o'clock (the canvas's y points down).
// Each category is a sector sized by its share of the items, with a minimum. Its projects are hubs on the first ring,
// the biggest in the middle of the sector; each hub's documents fan outward in a ray, newest nearest the hub. The rim
// holds belt items (vault pages and stray memory notes): each sits at the circular mean angle of the projects it
// orbits, and those that orbit nothing fill the "uncharted" arc, a slot kept free at the bottom.

export const TAU = 2 * Math.PI;
export const GEOM = {
  HEX: 20, // the centre hexagon's radius
  SECTOR: 62, // where each sector's own hub sits
  HUB: 106, // the first ring: project hubs (the least it can be; more projects push it out)
  TIER: 10, // a hub whose slice is too narrow for it steps out by this much, in turn (up to two steps)
  RAY0: 12, // between a hub's edge and its first row of documents
  SP: 5.2, DR: 5.2, MAXCOLS: 8, // a ray: documents this far apart along a row and between rows, in up to 8 columns
  RIM: 292, RIM_GAP: 26, // the rim's least radius, and its gap past the longest ray
  LANE: 6.4, MAXLANE: 6, // rim items this far apart; a crowded spot stacks outward up to MAXLANE deep
  FRAME_GAP: 30, // the outer frame, past the rim's outermost lane
  GAP: 0.06, // between sectors, in radians
  MIN_SHARE: 0.06, // a sector's least share of the circle's weight, however few its items
  SLOT_MID: Math.PI / 2, // the uncharted slot's middle: straight down
  LABEL_SHARE: 0.25, LABEL_MIN: 3, // the top quarter of each sector's hubs (at least 3) are labelled at the default zoom
};
const G = GEOM;
const GROUP_SHAPE = { docs: 'circle', comms: 'square', outputs: 'ring', memory: 'triangle' };

const norm = a => ((a % TAU) + TAU) % TAU;
// Code-unit order, so ties fall the same way in every runtime (localeCompare depends on the ICU build).
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Newest first: the later modified time, then the name, then the id.
const newestFirst = (a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || cmp(a.name, b.name) || cmp(a.id, b.id);
const hubRadius = count => 2.4 + 1.25 * Math.log(1 + count);
export const projectKey = p => `${p.category}/${p.name}`; // how a belt item's orbits name a project

// Pure: the circular mean of some angles (the direction of their unit vectors' sum), in [0, 2π); null when they cancel
// out (the sum is shorter than 5% of their number).
export function circularMean(angles) {
  let x = 0, y = 0;
  for (const a of angles) { x += Math.cos(a); y += Math.sin(a); }
  return angles.length && Math.hypot(x, y) / angles.length >= 0.05 ? norm(Math.atan2(y, x)) : null;
}

// Pure: the tree → { sectors, hubs, items, rim, uncharted, rings, extent }. Each entry carries its tree node as `t`.
export function radialLayout(tree) {
  const cats = (tree?.children ?? []).filter(c => c.children?.length);
  const projItems = p => p.children?.flatMap(g => (g.children ?? []).map(t => ({ t, group: g.group }))) ?? [];
  const catItems = cats.map(c => c.children.reduce((a, p) => a + (p.count ?? 0), 0));
  const total = catItems.reduce((a, b) => a + b, 0);
  // Belt items, one per file (the index repeats an item in each belt it's in): those orbiting a project in the tree, and
  // those that orbit nothing (the root's belt, and any whose projects are all gone from the tree).
  const keys = new Set(cats.flatMap(c => c.children.map(projectKey)));
  const charted = [], lost = [];
  for (const t of dedupe([...cats.flatMap(c => c.children.flatMap(p => p.belt ?? [])), ...tree?.belt ?? []]))
    ((t.orbits ?? []).some(o => keys.has(o.project)) ? charted : lost).push(t);
  lost.sort((a, b) => cmp(a.topic ?? '', b.topic ?? '') || cmp(a.name, b.name) || cmp(a.file, b.file));
  // The uncharted slot, sized for about three lanes of what orbits nothing; none when nothing does.
  const slot = lost.length ? Math.min(0.9, Math.max(0.3, Math.ceil(lost.length / 3) * G.LANE / G.RIM)) : 0;
  const s0 = G.SLOT_MID - slot / 2, s1 = G.SLOT_MID + slot / 2;
  const avail = TAU - slot - G.GAP * cats.length;
  const weights = catItems.map(n => Math.max(total ? n / total : 0, G.MIN_SHARE)), wsum = weights.reduce((a, b) => a + b, 0);

  // The first ring holds every hub, up to three deep: it grows when they wouldn't fit.
  const allProjects = cats.flatMap(c => c.children);
  const need = allProjects.reduce((a, p) => a + 2 * hubRadius(p.count ?? 0) + 2, 0);
  const R_HUB = Math.max(G.HUB, need / (3 * Math.max(avail, 0.5)));

  const sectors = [], hubs = [], items = [];
  let a = s1 + G.GAP / 2;
  cats.forEach((c, ci) => {
    const span = avail * weights[ci] / wsum, amid = a + span / 2;
    const sector = { id: c.id, t: c, index: ci, name: c.name, projects: c.children.length, items: catItems[ci],
      a0: a, a1: a + span, span, amid: norm(amid), x: Math.cos(amid) * G.SECTOR, y: Math.sin(amid) * G.SECTOR, hubs: [] };
    sectors.push(sector);
    // The biggest projects in the middle of the sector, smaller ones toward its edges; each slice by √items.
    const bySize = [...c.children].sort((x, y) => (y.count ?? 0) - (x.count ?? 0) || cmp(x.name, y.name) || cmp(x.id, y.id));
    const labelled = Math.max(G.LABEL_MIN, Math.ceil(bySize.length * G.LABEL_SHARE));
    const order = [];
    bySize.forEach((p, i) => { if (i % 2 === 0) order.push(p); else order.unshift(p); });
    const ws = order.map(p => Math.max(Math.sqrt(p.count ?? 0), 1.25)), wt = ws.reduce((x, y) => x + y, 0);
    let at = a;
    order.forEach((p, i) => {
      const slice = span * ws[i] / wt, ang = at + slice / 2, r = hubRadius(p.count ?? 0);
      const tier = slice * R_HUB < 2 * r + 5 ? i % 3 : 0, R = R_HUB + tier * G.TIER;
      const own = projItems(p).sort((x, y) => newestFirst(x.t, y.t));
      const hub = { id: p.id, t: p, key: projectKey(p), sector: ci, a0: at, a1: at + slice, slice, ang: norm(ang), tier, R,
        x: Math.cos(ang) * R, y: Math.sin(ang) * R, r, count: p.count ?? 0, rank: bySize.indexOf(p),
        labelled: bySize.indexOf(p) < labelled, newest: own.length ? own[0].t.mtime ?? null : null, items: [], rayEnd: R };
      // The ray: fixed columns along radial lines, rows along arcs, newest nearest the hub.
      const R1 = R + r + G.RAY0, n = own.length;
      const cols = Math.max(1, Math.min(G.MAXCOLS, Math.floor(slice * R1 / G.SP), n || 1)), dth = G.SP / R1;
      own.forEach(({ t, group }, k) => {
        const row = Math.floor(k / cols), inRow = k % cols, rowCount = Math.min(cols, n - row * cols);
        const ia = ang + (inRow - (rowCount - 1) / 2) * dth, iR = R1 + row * G.DR;
        hub.items.push(items.length);
        items.push({ id: t.id, t, hub: hubs.length, group, shape: t.status ? 'diamond' : GROUP_SHAPE[group] ?? 'circle', k,
          ang: norm(ia), R: iR, x: Math.cos(ia) * iR, y: Math.sin(ia) * iR });
      });
      if (n) hub.rayEnd = R1 + (Math.ceil(n / cols) - 1) * G.DR;
      sector.hubs.push(hubs.length);
      hubs.push(hub);
      at += slice;
    });
    a += span + G.GAP;
  });

  // The rim clears the longest ray.
  const R_RIM = Math.max(G.RIM, ...hubs.map(h => h.rayEnd + G.RIM_GAP));
  const byKey = new Map(hubs.map((h, i) => [h.key, i]));
  const rim = [];
  // Each belt item orbiting projects sits at the circular mean of their angles. One that would land in the uncharted
  // slot goes to the slot's nearer edge.
  const span = TAU - slot, rel = x => norm(x - s1);
  const placed = [];
  for (const t of charted) {
    const on = [...new Set(t.orbits.map(o => byKey.get(o.project)).filter(i => i !== undefined))];
    let target = circularMean(on.map(i => hubs[i].ang)) ?? hubs[on[0]].ang;
    if (slot && rel(target) > span) target = rel(target) - span < slot / 2 ? norm(s0 - 0.01) : norm(s1 + 0.01);
    placed.push({ t, hubs: on, target });
  }
  // Crowded spots stack outward into lanes; past MAXLANE deep, an item moves along the rim to the first free spot,
  // and when that would take it into the slot, it opens another lane where it is.
  const sep = G.LANE / R_RIM, last = [];
  for (const p of placed.sort((x, y) => rel(x.target) - rel(y.target) || cmp(x.t.file, y.t.file))) {
    const r = rel(p.target);
    let lane = last.findIndex(v => r - v >= sep), at = r;
    if (lane < 0 && last.length < G.MAXLANE) lane = last.length;
    else if (lane < 0) {
      lane = last.indexOf(Math.min(...last));
      at = last[lane] + sep;
      if (slot && at > span - sep / 2) { lane = last.length; at = r; }
    }
    last[lane] = at;
    const ang = s1 + at, R = R_RIM + lane * G.LANE;
    rim.push({ id: p.t.file, file: p.t.file, t: p.t, hubs: p.hubs, uncharted: false, target: p.target, lane, ang: norm(ang), R,
      x: Math.cos(ang) * R, y: Math.sin(ang) * R });
  }
  // What orbits nothing: rows across the slot, by topic.
  let uncharted = null;
  if (lost.length) {
    const per = Math.max(1, Math.floor(slot * R_RIM / G.LANE) - 1), lanes = Math.ceil(lost.length / per);
    lost.forEach((t, i) => {
      const lane = Math.floor(i / per), j = i % per, cnt = Math.min(per, lost.length - lane * per);
      const ang = G.SLOT_MID + (j - (cnt - 1) / 2) * G.LANE / R_RIM, R = R_RIM + lane * G.LANE;
      rim.push({ id: t.file, file: t.file, t, hubs: [], uncharted: true, lane, ang: norm(ang), R, x: Math.cos(ang) * R, y: Math.sin(ang) * R });
    });
    uncharted = { a0: s0, a1: s1, mid: G.SLOT_MID, n: lost.length, lanes, R: R_RIM };
  }
  const outer = Math.max(R_RIM, ...rim.map(r => r.R));
  const rings = { hex: G.HEX, sector: G.SECTOR, hub: R_HUB, doc: (R_HUB + 2 * G.TIER + R_RIM) / 2, rim: R_RIM, frame: outer + G.FRAME_GAP };
  return { sectors, hubs, items, rim, uncharted, rings, extent: rings.frame + 24 };
}
// One of each file, the first seen.
function dedupe(list) {
  const seen = new Set();
  return list.filter(t => !seen.has(t.file) && seen.add(t.file));
}

// Pure: labels placed greedily in priority order (lowest `pri` first; ties keep their order), each at the first of its
// anchors where its box lies inside the view and overlaps no box already taken (`taken`, then the labels placed).
// A label with no such anchor is left out. Requests: { pri, w, h, anchors: [{ x, y, align: left|right|center,
// base: top|bottom|middle }] } plus whatever the caller wants back; screen pixels. Returns the placed ones, each with
// `x`, `y` (its box's top left, text excluded from the padding) and `box`.
export const LABEL_PAD = 3;
export function placeLabels(requests, { width, height, taken = [] }) {
  const boxes = taken.slice(), out = [];
  const order = requests.map((r, i) => [r, i]).sort((p, q) => p[0].pri - q[0].pri || p[1] - q[1]);
  for (const [r] of order) {
    for (const an of r.anchors) {
      const x = an.align === 'left' ? an.x : an.align === 'right' ? an.x - r.w : an.x - r.w / 2;
      const y = an.base === 'top' ? an.y : an.base === 'bottom' ? an.y - r.h : an.y - r.h / 2;
      const box = { x0: x - LABEL_PAD, y0: y, x1: x + r.w + LABEL_PAD, y1: y + r.h };
      if (box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height) continue;
      if (boxes.some(o => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) continue;
      boxes.push(box);
      out.push({ ...r, x, y, box });
      break;
    }
  }
  return out;
}
