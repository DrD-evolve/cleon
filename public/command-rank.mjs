// The command bar's ranking: which of the things the page already holds match what was typed, best first. Pure: it
// takes the items and the text and returns rows; it reads no state, draws nothing and asks for nothing.
//
// An item is { kind, id, name, ticket?, you? }. `ticket` is a ticket id the item answers to; `you` marks one that is
// waiting on the owner. An item showing the server's "(excluded)" stand-in is never ranked, so a withheld name cannot
// appear however it is typed.
export const KINDS = ['view', 'panel', 'session', 'ticket', 'issue', 'pr', 'project'];
export const LIMIT = 8;
const KNOWLEDGE_MIN = 2; // the Knowledge search's own minimum

const WITHHELD = /\(excluded\)/i;
const TICKET = /^[a-z][a-z0-9]*-\d+$/i;
const WORD = /[^\p{L}\p{N}]/u; // a word starts after anything that isn't a letter or a digit

// 0 exact ticket id, 1 start of the name, 2 start of a word, 3 anywhere, -1 no match. `q` is lower case.
function tier(item, q) {
  if (typeof item.ticket === 'string' && item.ticket.toLowerCase() === q) return 0;
  if (typeof item.id === 'string' && TICKET.test(item.id) && item.id.toLowerCase() === q) return 0;
  const name = String(item.name ?? '').toLowerCase(), at = name.indexOf(q);
  if (at < 0) return -1;
  if (at === 0) return 1;
  for (let i = at; i >= 0; i = name.indexOf(q, i + 1)) if (i === 0 || WORD.test(name[i - 1])) return 2;
  return 3;
}

export function rankCommands(items, query, { limit = LIMIT } = {}) {
  const text = String(query ?? '').trim(), q = text.toLowerCase();
  if (!q) return { rows: [], groups: [], knowledge: null };
  const scored = [];
  (items ?? []).forEach((item, i) => {
    if ([item.name, item.ticket, item.id].some(v => typeof v === 'string' && WITHHELD.test(v))) return;
    const t = tier(item, q);
    if (t >= 0) scored.push({ item, t, i, len: String(item.name ?? '').length });
  });
  scored.sort((a, b) => a.t - b.t || Number(Boolean(b.item.you)) - Number(Boolean(a.item.you)) || a.len - b.len || a.i - b.i);
  const kept = scored.slice(0, Math.max(0, limit));
  // Grouped by kind. A group goes by its best row (tier, then waiting on you), the kind order breaking ties, so the
  // first row, the one Enter opens, is never a worse match than one below it. The group holding an exact id hit goes first.
  const order = [...KINDS, ...new Set(kept.map(s => s.item.kind).filter(k => !KINDS.includes(k)))];
  const groups = order.map(kind => ({ kind, top: kept.find(s => s.item.kind === kind), rows: kept.filter(s => s.item.kind === kind).map(s => s.item) }))
    .filter(g => g.rows.length)
    .sort((a, b) => a.top.t - b.top.t || Number(Boolean(b.top.item.you)) - Number(Boolean(a.top.item.you)))
    .map(({ kind, rows }) => ({ kind, rows }));
  if (kept[0]?.t === 0) {
    const lead = groups.findIndex(g => g.kind === kept[0].item.kind);
    groups.unshift(...groups.splice(lead, 1));
  }
  return { rows: groups.flatMap(g => g.rows), groups, knowledge: text.length >= KNOWLEDGE_MIN ? { text } : null };
}
