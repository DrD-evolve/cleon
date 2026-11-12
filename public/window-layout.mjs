// Where the floating windows of a Map backdrop view start, and how they are kept on screen. Pure: the page passes the
// board's size and gets rectangles back (CSS px, relative to the board under the header).
export const WIN = { KEEP: 80, BAR: 36, TOP: 0, GAP: 12, MIN_W: 220, MIN_H: 120, COL: 340, STRIP: 176 };

// Per view: which panels start in the left column, the right column and the bottom strip. The centre stays clear.
const PLACE = {
  dev: { left: ['sessions', 'herdr'], right: ['side'], bottom: ['flows'] },
  groom: { left: ['groom', 'waiting'], right: ['side'], bottom: [] },
  exec: { left: ['exec', 'usage'], right: ['process'], bottom: [] },
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A window stays reachable: at least KEEP px of it across, and its title bar on screen (not above the board's top,
// not below its bottom edge).
export function clampRect(r, W, H) {
  return { ...r, x: clamp(r.x, WIN.KEEP - r.w, Math.max(WIN.KEEP - r.w, W - WIN.KEEP)), y: clamp(r.y, WIN.TOP, Math.max(WIN.TOP, H - WIN.BAR)) };
}
export const clampRects = (wins, W, H) => Object.fromEntries(Object.entries(wins).map(([id, r]) => [id, clampRect(r, W, H)]));
export const dragRect = (o, dx, dy, W, H) => clampRect({ ...o, x: o.x + dx, y: o.y + dy }, W, H);
// From the bottom-right corner: not smaller than the minimum, not past the board's edge.
export const resizeRect = (o, dx, dy, W, H) => ({ ...o,
  w: clamp(o.w + dx, WIN.MIN_W, Math.max(WIN.MIN_W, W - o.x)), h: clamp(o.h + dy, WIN.MIN_H, Math.max(WIN.MIN_H, H - o.y)) });

// `ids`: the panels to place (Knowledge is the backdrop, not one of them). A panel the view has no place for cascades
// from the middle-left of the free centre, each a step down and right of the last.
export function defaultPlacement(view, ids, W, H) {
  const g = WIN.GAP, spec = PLACE[view] ?? { left: [], right: [], bottom: [] };
  const colW = clamp(Math.round(W * 0.24), WIN.MIN_W, WIN.COL), top = WIN.TOP + g;
  const strip = Math.min(WIN.STRIP, Math.round(H * 0.25));
  const has = id => ids.includes(id);
  const left = spec.left.filter(has), right = spec.right.filter(has), bottom = spec.bottom.filter(has);
  const out = {};
  const colH = H - top - g - (bottom.length ? strip + g : 0);
  const stack = (list, x) => list.forEach((id, i) => {
    const h = Math.round((colH - g * (list.length - 1)) / list.length);
    out[id] = { x, y: top + i * (h + g), w: colW, h };
  });
  stack(left, g);
  stack(right, W - g - colW);
  bottom.forEach((id, i) => {
    const bw = Math.round((W - g * (bottom.length + 1)) / bottom.length);
    out[id] = { x: g + i * (bw + g), y: H - g - strip, w: bw, h: strip };
  });
  // The strip spans the page, so the columns stop above it (colH) and the centre between the columns stays clear.
  let n = 0;
  for (const id of ids) if (!out[id]) {
    const w = Math.min(300, Math.max(WIN.MIN_W, W - 2 * (colW + 2 * g))), h = Math.min(230, Math.max(WIN.MIN_H, H - top - strip - 2 * g));
    out[id] = clampRect({ x: colW + 2 * g + 24 * (n % 6), y: top + 24 * (n % 6), w, h }, W, H);
    n++;
  }
  return out;
}

// ---- saved window state: mc.float.<view> ----
// {v, wins:[{id,x,y,w,h,min}]}; `wins` runs back to front (the stacking order) and its ids are the open windows.
export const FLOAT_V = 1;
const num = Number.isFinite;
export const narrowScreen = W => W < 800; // below this a backdrop view falls back to one column of tiles

export const writeFloatState = wins => JSON.stringify({ v: FLOAT_V, wins: wins.map(w => ({
  id: w.id, x: Math.round(w.x), y: Math.round(w.y), w: Math.round(w.w), h: Math.round(w.h), min: w.min === true || w.min === 1 })) });

// The windows to restore, or null when the value is missing, corrupt or from another version (the view then uses its
// default placement). `validIds`: the panels that exist; an unknown id (a panel since removed) and the map are dropped.
// Rects are made to fit the board (W x H) now, so a state saved on a bigger screen comes back in view.
export function readFloatState(raw, validIds, W, H) {
  let s;
  try { s = JSON.parse(raw); } catch { return null; }
  if (!s || typeof s !== 'object' || s.v !== FLOAT_V || !Array.isArray(s.wins)) return null;
  const seen = new Map();
  for (const e of s.wins) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || ![e.x, e.y, e.w, e.h].every(num)) return null;
    if (e.id === 'knowledge' || !validIds.includes(e.id)) continue;
    seen.delete(e.id); // a duplicate keeps its last entry, in that entry's place
    seen.set(e.id, e);
  }
  if (s.wins.length && !seen.size) return null;
  return [...seen.values()].map(e => {
    const r = clampRect({ x: e.x, y: e.y, w: clamp(e.w, WIN.MIN_W, Math.max(WIN.MIN_W, W)), h: clamp(e.h, WIN.MIN_H, Math.max(WIN.MIN_H, H)) }, W, H);
    return { id: e.id, ...r, h: Math.min(r.h, Math.max(WIN.MIN_H, H - r.y)), min: e.min === true }; // its bottom and grip on the board, as resizeRect keeps them
  });
}
