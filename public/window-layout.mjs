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
