// Today view: the owner's edits to the saved plan. The page names a box and an item by id; the item is looked up again here,
// in the plan's own items and opportunities, so nothing the page sends is ever written except as a reference to one of them.
// Pure: each function takes the saved plan and answers { ok: true, plan } (a changed copy) or { ok: false, status, reason }.
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
  const boxes = plan.boxes.map(b => (b.id === box.id ? { ...b, kind: work ? 'work' : 'opportunity', itemId: item.id, source: item.source, why: WHY, by: 'you' } : b));
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
