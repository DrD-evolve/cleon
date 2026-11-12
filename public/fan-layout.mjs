// The fan a selected project's documents open into on the Knowledge map, apart from drawing so it can be tested.
// Pure: no DOM, no clock, no randomness, and the input isn't changed. The page (app.js) imports it, and so do the tests.
//
// Screen pixels, the project at 0,0, angles in radians clockwise from 3 o'clock (the canvas's y points down). The
// documents spread over an arc centred on `dir`, which the page sets to point away from the map's centre. The newest
// `limit` are named: each sits on an outer ring with its name beside it, on the side its angle faces, and the names are
// pushed apart vertically so no two boxes overlap. The rest are plain dots on the arcs inside that ring, and "+N more"
// says how many. Items arrive in the side panel's order (group by group, newest first in a group) and keep it along
// the arc, so a group stays together.

export const FAN = {
  LIMIT: 12, // names drawn; the side panel lists all
  RADIUS: 120, // the ring the named documents sit on
  H: 16, // a name's box height
  GAP: 3, // the least space between two name boxes
  STEP: 0.34, // the widest angle between named neighbours
  SPREAD: 2.2, // the widest arc the fan opens over (about 125 degrees)
  MAX_NAME: 170, // the widest a name is drawn, in px: a longer one is cut short, so a fan fits a narrow panel
  DOT_GAP: 6, // dots this far apart along a row and between rows
  DOT_CAP: 240, // dots drawn; "+N more" still counts the rest
  INNER: 40, // dots start this far out, at the least
  PAD: 7, // between a node and its name
  MORE_W: 72, // the width of "+N more" when the caller doesn't measure it
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MARK = 5; // a named node's mark, at its largest, in px from its centre

// Pure: a project's documents in the side panel's order: its groups in `order`, then any other group as first met, each
// group's documents in the order given (newest first). `groupOf(item)` → its group.
export function fanSeq(items, groupOf, order) {
  const groups = [...order, ...new Set(items.map(groupOf).filter(g => !order.includes(g)))];
  return groups.flatMap(g => items.filter(it => groupOf(it) === g));
}

// Pure: a name's parts ([{ t, c }], the name first, then versions, status, draft) cut to fit `max` px, `measure(text)`
// giving a text's width. The name keeps at least half of `max` (all of it when shorter); what follows it is cut, or
// left out, to fit what's left. A cut ends in "…". Parts that fit come back unchanged.
export function fitName(parts, measure, max = FAN.MAX_NAME) {
  const width = ps => ps.reduce((a, p) => a + measure(p.t), 0);
  if (width(parts) <= max) return parts;
  // The most of `t` that fits in `room` with an ellipsis (a binary search: a name is measured a few times, not once per
  // character); at least one character for a name, else null when even that doesn't fit.
  const cut = (t, room, least) => {
    const ch = [...t];
    if (measure(t) <= room) return t;
    let lo = 0, hi = ch.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measure(`${ch.slice(0, mid).join('')}…`) <= room) lo = mid; else hi = mid - 1; }
    return lo || least ? `${ch.slice(0, Math.max(lo, 1)).join('')}…` : null;
  };
  const [name, ...rest] = parts;
  const out = [{ ...name, t: cut(name.t, Math.max(max - width(rest), Math.min(measure(name.t), max / 2)), true) }];
  let room = max - measure(out[0].t);
  for (const p of rest) {
    const t = cut(p.t, room, false);
    if (t === null) break;
    out.push({ ...p, t });
    room -= measure(t);
  }
  return out;
}

// Pure: items [{ id, mtime?, w? }] (`w`: the width of the name in px, or a function that measures it: only a named
// item's is ever asked for) → { nodes, more, moreBox, box }.
// - nodes: one per item, in order: { id, x, y, named, label? } with label { x0, y0, x1, y1, align } for a named one
//   (align: which end of the box the text is anchored to, 'left' for a name to the right of its node).
// - more: how many were left unnamed; moreBox: the box of "+N more" ({ x0, y0, x1, y1, align }) or null.
// - box: the union of every node, name box and the "+N more" box, and the project's own point; null for no items.
export function fanLayout(items, opts = {}) {
  const o = { limit: FAN.LIMIT, radius: FAN.RADIUS, h: FAN.H, gap: FAN.GAP, step: FAN.STEP, spread: FAN.SPREAD, dotGap: FAN.DOT_GAP,
    dotCap: FAN.DOT_CAP, inner: FAN.INNER, pad: FAN.PAD, moreW: FAN.MORE_W, dir: 0, ...opts };
  const n = items.length;
  if (!n) return { nodes: [], more: 0, moreBox: null, box: null };

  const limit = Math.max(0, Math.floor(o.limit)), R = Math.max(o.radius, o.inner + 20);
  const named = new Set([...items.keys()].sort((a, b) => (items[b].mtime ?? 0) - (items[a].mtime ?? 0) || cmp(items[a].id, items[b].id)).slice(0, limit));
  const m = named.size, more = n - m;

  // The named ones along the arc, in the order given.
  const step = m > 1 ? Math.min(o.spread / (m - 1), o.step) : 0;
  const nodes = new Array(n);
  let j = 0;
  const side = a => (Math.cos(a) >= 0 ? 'left' : 'right'); // the end of its box the text is anchored to
  const boxes = []; // the name boxes (and "+N more"), each to be placed vertically
  items.forEach((it, i) => {
    if (!named.has(i)) return;
    const a = o.dir + (j++ - (m - 1) / 2) * step, x = Math.cos(a) * R, y = Math.sin(a) * R;
    nodes[i] = { id: it.id, x, y, named: true };
    boxes.push({ i, align: side(a), x, y, w: Math.max(0, (typeof it.w === 'function' ? it.w() : it.w) ?? 0) });
  });
  let moreBox = null;
  if (more > 0) {
    // "+N more" carries on from the last name, one step further round the arc.
    const a = o.dir + (m / 2) * Math.max(step, 0.2), x = Math.cos(a) * R, y = Math.sin(a) * R;
    boxes.push({ i: -1, align: side(a), x, y, w: o.moreW });
  }

  // Each side's boxes top to bottom, pushed down where they would touch, then the run is centred back on where it began
  // so a crowd doesn't drift one way.
  for (const al of ['left', 'right']) {
    const run = boxes.filter(b => b.align === al).sort((p, q) => p.y - q.y || p.i - q.i);
    if (!run.length) continue;
    let prev = -Infinity;
    for (const b of run) { b.cy = Math.max(b.y, prev + o.h + o.gap); prev = b.cy; }
    const drift = (run.reduce((s, b) => s + (b.cy - b.y), 0) / run.length);
    for (const b of run) b.cy -= drift * 0.5;
    // Centring can pull a box back into the one above: one more pass down keeps the gap.
    prev = -Infinity;
    for (const b of run) { b.cy = Math.max(b.cy, prev + o.h + o.gap); prev = b.cy; }
  }
  for (const b of boxes) {
    // Out past every named node in its band on its side, not only its own, so no name lies across another's mark.
    const band = boxes.filter(q => q.i >= 0 && q.align === b.align && Math.abs(q.y - b.cy) < o.h / 2 + MARK).map(q => q.x);
    const x0 = b.align === 'left' ? Math.max(b.x, ...band) + o.pad : Math.min(b.x, ...band) - o.pad - b.w;
    const box = { x0, y0: b.cy - o.h / 2, x1: x0 + b.w, y1: b.cy + o.h / 2, align: b.align };
    if (b.i < 0) moreBox = box; else nodes[b.i].label = box;
  }

  // The rest, as dots on inner arcs: columns of rows, so each group's dots stay side by side along the arc.
  const dots = [...items.keys()].filter(i => !named.has(i)).slice(0, o.dotCap);
  if (dots.length) {
    const r0 = o.inner, r1 = R - 14, rows = Math.max(1, Math.floor((r1 - r0) / o.dotGap) + 1), cols = Math.ceil(dots.length / rows);
    const arc = Math.min(o.spread, Math.max(0.5, (m - 1) * step + 0.4, cols * o.dotGap / ((r0 + r1) / 2)));
    dots.forEach((i, k) => {
      const col = Math.floor(k / rows), row = k % rows, a = o.dir + (cols > 1 ? (col / (cols - 1) - 0.5) * arc : 0), r = r0 + row * o.dotGap;
      nodes[i] = { id: items[i].id, x: Math.cos(a) * r, y: Math.sin(a) * r, named: false };
    });
  }
  // A cap on the dots: the ones past it are counted in `more` but have no node of their own; they sit at the project.
  for (let i = 0; i < n; i++) if (!nodes[i]) nodes[i] = { id: items[i].id, x: 0, y: 0, named: false, hidden: true };

  let x0 = 0, y0 = 0, x1 = 0, y1 = 0;
  const take = (a, b, c, d) => { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d); };
  for (const nd of nodes) {
    if (nd.hidden) continue;
    take(nd.x - 3, nd.y - 3, nd.x + 3, nd.y + 3);
    if (nd.label) take(nd.label.x0, nd.label.y0, nd.label.x1, nd.label.y1);
  }
  if (moreBox) take(moreBox.x0, moreBox.y0, moreBox.x1, moreBox.y1);
  return { nodes, more, moreBox, box: { x0, y0, x1, y1 } };
}

// Pure: how far to pan a canvas of W×H so `box` (offsets from the project) round the project at (px, py) lies inside it,
// `margin` px from every edge; centred on the axis it is too big for. Returns the shift to add to the project's screen
// position, which the camera makes by moving the other way; [0, 0] when it already fits or there is no fan.
export function fanRoom(box, px, py, W, H, margin = 12) {
  if (!box) return [0, 0];
  const axis = (lo, hi, p, size) => {
    const a = p + lo, b = p + hi;
    if (b - a > size - 2 * margin) return size / 2 - (a + b) / 2; // too big: centred
    return a < margin ? margin - a : b > size - margin ? size - margin - b : 0;
  };
  return [axis(box.x0, box.x1, px, W), axis(box.y0, box.y1, py, H)];
}
