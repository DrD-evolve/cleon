// Today view: where the saved plan's blocks go on a day timeline, and the focus-mode rules. Pure: the page passes the plan
// (as /api/today saves it), the working hours, the pixel length of the time axis and the clock, and draws what comes back.
// `axis` says which way the time runs (across or down); positions are along that axis, and the cross axis is the
// fraction lane/lanes, so the two forms cannot disagree about when anything is.
export const MIN_LEN = 16;      // px: the shortest block drawn, so a 15-minute box stays clickable
const LABEL_PX = 36;            // fewer px an hour than this and the hour labels thin out to every second hour

const pad = n => String(n).padStart(2, '0');
export const hhmm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const atMinute = (day, min) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 0, min).getTime(); };
const snapTo = (n, snap) => Math.round(n / snap) * snap;
// Pure: a pixel offset along the time axis (0..size) as absolute minutes after midnight, snapped and held inside the hours.
export const minuteAt = (px, { size, hours, snap = 15 }) => {
  const min = hours.start + (px / Math.max(1, size)) * (hours.end - hours.start);
  return Math.max(hours.start, Math.min(hours.end, snapTo(min, snap)));
};
// Pure: a pixel distance along the time axis as a snapped number of minutes (negative going back).
export const deltaMinutes = (px, { size, hours, snap = 15 }) => snapTo((px / Math.max(1, size)) * (hours.end - hours.start), snap) || 0;
const todays = (plan, now) => (plan && plan.day === localDay(now) ? plan : null);

// Pure: the day, laid out. `hours`: { start, end } minutes after midnight (used when the plan has none, and for the empty day).
// `open`: a Set of item ids the page still sees open, or null when it doesn't know (nothing is then flagged late).
export function dayLayout({ plan, hours, axis = 'across', size, now, open = null }) {
  const day = localDay(now), mine = todays(plan, now);
  const start = atMinute(day, hours.start), end = atMinute(day, hours.end);
  const span = Math.max(1, end - start), px = Number.isFinite(size) && size > 0 ? size : 0;
  const at = t => ((t - start) / span) * px;
  const out = { axis, day, range: { start, end }, size: px, empty: !mine || (!mine.boxes?.length && !mine.meetings?.length),
    stale: Boolean(plan) && !mine, ticks: [], items: [], bands: [], now: null };

  const perHour = px / (span / 3600e3), every = perHour >= LABEL_PX ? 1 : 2;
  for (let h = Math.ceil(hours.start / 60); h <= Math.floor(hours.end / 60); h++) {
    const t = atMinute(day, h * 60);
    out.ticks.push({ at: t, hour: h, pos: at(t), label: (h - Math.ceil(hours.start / 60)) % every === 0 });
  }
  if (now >= start && now < end) out.now = { at: now, pos: at(now) };
  if (!mine) return out;

  const byId = new Map([...(mine.items ?? []), ...(mine.opportunities ?? [])].map(i => [i.id, i]));
  const raw = [];
  for (const m of mine.meetings ?? []) raw.push({ id: null, boxId: null, tone: 'meeting', itemId: null, title: m.subject ?? '', start: m.start, end: m.end, tentative: m.tentative === true });
  for (const b of mine.boxes ?? []) {
    const it = b.itemId ? byId.get(b.itemId) : null;
    const tone = !b.itemId ? (b.title ? 'custom' : 'empty') : b.kind === 'opportunity' ? 'opportunity' : it?.kind === 'due' ? 'due' : 'ready';
    raw.push({ id: b.id, boxId: b.id, tone, itemId: b.itemId ?? null, title: it?.title ?? (b.itemId ? null : b.title ?? null), start: b.start, end: b.end, tentative: false,
      work: b.kind === 'work' && Boolean(b.itemId) });
  }
  const live = [];
  for (const r of raw) {
    if (!(r.end > r.start) || r.end <= start || r.start >= end) continue;
    if (r.tone === 'meeting' && r.start <= start && r.end >= end) { out.bands.push({ title: r.title, tentative: r.tentative, start: r.start, end: r.end }); continue; }
    live.push({ ...r, clipStart: r.start < start, clipEnd: r.end > end, cs: Math.max(r.start, start), ce: Math.min(r.end, end) });
  }
  // Lanes: blocks that overlap in time form a cluster and share the cross axis; a lane is reused once its block ended.
  live.sort((a, b) => a.cs - b.cs || a.ce - b.ce || (a.tone === 'meeting' ? 0 : 1) - (b.tone === 'meeting' ? 0 : 1));
  let cluster = [], clusterEnd = -Infinity, laneEnds = [];
  const close = () => { for (const c of cluster) c.lanes = laneEnds.length; cluster = []; laneEnds = []; clusterEnd = -Infinity; };
  for (const b of live) {
    if (b.cs >= clusterEnd) close();
    let lane = laneEnds.findIndex(e => e <= b.cs);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = b.ce; b.lane = lane; cluster.push(b); clusterEnd = Math.max(clusterEnd, b.ce);
  }
  close();
  for (const b of live) {
    const len = Math.max(MIN_LEN, at(b.ce) - at(b.cs)), pos = Math.max(0, Math.min(at(b.cs), Math.max(0, px - len)));
    out.items.push({ id: b.id, boxId: b.boxId, tone: b.tone, itemId: b.itemId, title: b.title, start: b.cs, end: b.ce, boxStart: b.start, boxEnd: b.end, pos, len,
      lane: b.lane, lanes: b.lanes, tentative: b.tentative, clipStart: b.clipStart, clipEnd: b.clipEnd,
      past: b.ce <= now, late: b.work && open && b.end <= now && open.has(b.itemId) ? now - b.end : null });
  }
  out.items.sort((a, b) => a.start - b.start || (a.tone === 'meeting' ? 0 : 1) - (b.tone === 'meeting' ? 0 : 1));
  return out;
}

// Pure: the saved plan's items and opportunities that are in no box: what "Didn't fit" lists.
export function unplaced(plan) {
  if (!plan) return { work: [], opportunities: [] };
  const used = new Set((plan.boxes ?? []).map(b => b.itemId).filter(Boolean));
  return { work: (plan.items ?? []).filter(i => !used.has(i.id)), opportunities: (plan.opportunities ?? []).filter(i => !used.has(i.id)) };
}

const workBoxes = plan => (plan?.boxes ?? []).filter(b => (b.kind === 'work' && b.itemId) || (b.kind === 'task' && !b.itemId && b.title));
// Pure: focus mode is on while a work box with an item, or one the owner titled, is running in today's plan (an opportunity box, an empty one and a
// finished one don't count). { box, until } or null.
export function focusNow(plan, now) {
  const p = todays(plan, now);
  const box = p && workBoxes(p).find(b => b.start <= now && now < b.end);
  return box ? { box, until: box.end } : null;
}
// Pure: when focus next starts or ends (epoch ms), or null: when a timer should wake the page.
export function nextBoundary(plan, now) {
  const p = todays(plan, now);
  const ts = p ? workBoxes(p).flatMap(b => [b.start, b.end]).filter(t => t > now) : [];
  return ts.length ? Math.min(...ts) : null;
}
// Pure: the page's "needs you" alerts split for focus mode. Only plan gates (`gate: true`) come through while focus is on.
export function splitNotices(alerts, focus) {
  return focus ? { through: alerts.filter(a => a.gate), held: alerts.filter(a => !a.gate) } : { through: alerts, held: [] };
}
// Pure: the alert keys to record as seen after a notify pass. A held one is left out, so it counts as new when focus ends;
// one that was already delivered before focus stays in, so it is not delivered twice.
export function seenAfter(keys, held, seen) {
  return new Set([...keys].filter(k => !held.has(k) || Boolean(seen?.has(k))));
}
