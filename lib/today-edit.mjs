// Today view: the owner's edits to the saved plan. The page names a box and an item by id; the item is looked up again here,
// in the plan's own items and opportunities, so an item is only ever written as a reference to one of them. The page also
// sends minutes after midnight and an owner-typed box title: both are written only after the checks here (the title through
// plain(), the times against the day's hours, the meetings, the other boxes and the box length).
// Pure: each function takes the saved plan and answers { ok: true, plan } (a changed copy) or { ok: false, status, reason }.
import { atMinute, plain, MAX_BOXES, MIN_BOX, MAX_BOX } from './today-plan.mjs';
const no = (status, reason) => ({ ok: false, status, reason });
const WHY = 'Put here by you.';
// After midnight the saved plan is yesterday's until the next run: the page draws it empty, and it is not edited.
const stale = (plan, day) => day !== undefined && plan.day !== day;

// Put an item in a box: fills an empty box, or swaps (the box's old item goes back to "Didn't fit").
export function putItem(plan, boxId, itemId, day) {
  if (!plan) return no(409, 'there is no plan to edit');
  if (stale(plan, day)) return no(409, "the saved plan is not today's");
  const box = typeof boxId === 'string' ? plan.boxes.find(b => b.id === boxId) : null;
  if (!box) return no(404, 'no such box');
  const work = typeof itemId === 'string' ? plan.items.find(i => i.id === itemId) : null;
  const item = work ?? (typeof itemId === 'string' ? plan.opportunities.find(i => i.id === itemId) : null);
  if (!item) return no(404, 'no such item in the plan');
  if (plan.boxes.some(b => b.id !== box.id && b.itemId === item.id)) return no(409, 'that item is already in another box');
  const boxes = plan.boxes.map(b => {
    if (b.id !== box.id) return b;
    const { title, ...rest } = b; // a custom box's own title gives way to the item
    return { ...rest, kind: work ? 'work' : 'opportunity', itemId: item.id, source: item.source, why: WHY, by: 'you' };
  });
  return { ok: true, plan: { ...plan, boxes, edited: true } };
}

// Clear a box: its item goes back to "Didn't fit" and the box stays, empty.
export function clearBox(plan, boxId, day) {
  if (!plan) return no(409, 'there is no plan to edit');
  if (stale(plan, day)) return no(409, "the saved plan is not today's");
  const box = typeof boxId === 'string' ? plan.boxes.find(b => b.id === boxId) : null;
  if (!box) return no(404, 'no such box');
  const boxes = plan.boxes.map(b => (b.id === box.id ? { ...b, itemId: null, source: 'cleared', why: 'Cleared by you.', by: 'you' } : b));
  return { ok: true, plan: { ...plan, boxes, edited: true } };
}

const whole = n => Number.isInteger(n);
const byStart = boxes => [...boxes].sort((a, b) => a.start - b.start || a.end - b.end);
// Bidi marks the planner's plain() lets through except U+061C (the rest are in its CONTROL set).
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// The shared time checks for a new or moved box. `skip`: the box being moved, which does not clash with itself.
function checkTimes(plan, start, end, { day, now, hours }, skip) {
  if (!whole(start) || !whole(end)) return no(400, 'start and end must be whole minutes');
  if (start >= end) return no(400, 'the box must end after it starts');
  if (start < hours.start || end > hours.end) return no(409, 'outside the working hours');
  if (end - start < MIN_BOX) return no(409, `a box is at least ${MIN_BOX} minutes`);
  if (end - start > MAX_BOX) return no(409, `a box is at most ${MAX_BOX} minutes`);
  const s = atMinute(day, start), e = atMinute(day, end);
  if (e <= now) return no(409, 'that time has already passed');
  if ((plan.meetings ?? []).some(m => s < m.end && m.start < e)) return no(409, 'that overlaps a meeting');
  if (plan.boxes.some(b => b.id !== skip && s < b.end && b.start < e)) return no(409, 'that overlaps another box');
  return { ok: true, s, e };
}

// Add a box at the given minutes. With `item` (an id) it holds that item; with a `title` it is an owner-typed box; with
// neither, or a title that is empty once cleaned, it is an empty box.
export function addBox(plan, { start, end, title, item } = {}, ctx) {
  if (!plan) return no(409, 'there is no plan to edit');
  if (stale(plan, ctx.day)) return no(409, "the saved plan is not today's");
  if (title !== undefined && title !== null && typeof title !== 'string') return no(400, 'the title must be text');
  if (item !== undefined && item !== null && typeof item !== 'string') return no(400, 'the item must be an id');
  const t = checkTimes(plan, start, end, ctx, null);
  if (!t.ok) return t;
  if (plan.boxes.length >= MAX_BOXES) return no(409, `a plan holds at most ${MAX_BOXES} boxes`);
  let box;
  if (item) {
    const work = plan.items.find(i => i.id === item);
    const it = work ?? plan.opportunities.find(i => i.id === item);
    if (!it) return no(404, 'no such item in the plan');
    if (plan.boxes.some(b => b.itemId === it.id)) return no(409, 'that item is already in another box');
    box = { kind: work ? 'work' : 'opportunity', itemId: it.id, source: it.source, why: WHY };
  } else {
    const name = plain(String(title ?? '').replace(BIDI, ' '), 120);
    box = name ? { kind: 'task', itemId: null, title: name, source: 'you', why: 'Added by you.' } : { kind: 'work', itemId: null, source: 'you', why: 'Added by you.' };
  }
  const n = Math.max(plan.nextBox ?? 0, ...plan.boxes.map(b => Number(/^b(\d+)$/.exec(b.id)?.[1] ?? -1) + 1));
  const made = { id: `b${n}`, ...box, start: t.s, end: t.e, by: 'you' };
  return { ok: true, plan: { ...plan, boxes: byStart([...plan.boxes, made]), nextBox: n + 1, edited: true } };
}

// Move a box, or resize it: the same call, the new start and end in minutes.
export function moveBox(plan, boxId, start, end, ctx) {
  if (!plan) return no(409, 'there is no plan to edit');
  if (stale(plan, ctx.day)) return no(409, "the saved plan is not today's");
  if (typeof boxId !== 'string') return no(400, 'the box must be an id');
  const box = plan.boxes.find(b => b.id === boxId);
  if (!box) return no(404, 'no such box');
  const t = checkTimes(plan, start, end, ctx, box.id);
  if (!t.ok) return t;
  const boxes = byStart(plan.boxes.map(b => (b.id === box.id ? { ...b, start: t.s, end: t.e, by: 'you' } : b)));
  return { ok: true, plan: { ...plan, boxes, edited: true } };
}

// Remove a box (any box): its item, if it had one, goes back to "Didn't fit".
export function removeBox(plan, boxId, day) {
  if (!plan) return no(409, 'there is no plan to edit');
  if (stale(plan, day)) return no(409, "the saved plan is not today's");
  if (typeof boxId !== 'string') return no(400, 'the box must be an id');
  if (!plan.boxes.some(b => b.id === boxId)) return no(404, 'no such box');
  return { ok: true, plan: { ...plan, boxes: plan.boxes.filter(b => b.id !== boxId), edited: true } };
}
