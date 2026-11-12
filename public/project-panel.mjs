// One project's panel content, drawn by the Knowledge side panel (app.js) and by the full-page /project view
// (project.mjs): what it is, its git state, buttons that open it, the projects it shares the most with, and what it holds
// (its four groups and its belt, Orbiting), newest first, 25 at a time. Each draw takes a context object instead of
// reading the page's globals:
//   lay, tree, byKey, shares, links, hubRim   the layout and what panelIndex (knowledge-panel.mjs) made of it
//   kp           the panel's state: open (Set), shown (Map), lists (Map), relAll
//   project(t)   a tree project's record from the Projects poll
//   hue(i)       a sector's colour;  pal, mix, statusC  the palette's colours and helpers (page-palette.mjs)
//   esc, ago, dl, items(n), age(ms)   the page's text helpers
//   again        whether the title is a "choose again" button (the side panel's)
//   full         the project page's address, for the side panel's "Full view" link; null on the page itself
// Every name, title, topic and why is set escaped: vault pages and memory notes are untrusted text.
import { KM_SRC, KM_HOW, PMAP_STATE, pmapState } from '/page-palette.mjs';
import { linkReasons, linkWhy, relatedProjects, relatedPage, orbitingOrder } from '/knowledge-panel.mjs';

export const KM_GROUP = { docs: 'Docs & decisions', comms: 'Comms & meetings', outputs: 'Outputs', memory: 'Claude memory' };
export const KP_PAGE = 25, KP_RELATED = 5;
export const KP_SECTIONS = [...Object.entries(KM_GROUP), ['belt', 'Orbiting']];
export const KP_GLYPH = { docs: '●', comms: '■', outputs: '○', memory: '▲' };
export const PMAP_APPS = { herdr: 'herdr', bash: 'Git Bash', vscode: 'VS Code' };
export const kpAge = (ctx, ms) => (ms ? ctx.ago(ms).replace(' ago', '') : '—');
export const kpClip = s => (s && s.length > 140 ? `${s.slice(0, 139)}…` : s ?? '');

// A project's description and git state (refreshed by the 60 s Projects poll).
export function kpGitHtml(ctx, p) {
  const { esc, dl, ago } = ctx, st = pmapState(p);
  return `<p class="pmap-desc">${p.description ? esc(p.description) : '<span class="placeholder">No description (no README, CLAUDE.md or package.json description, or the folder is excluded).</span>'}</p>`
    + dl({ path: esc(p.path), state: `<span style="color:${PMAP_STATE[st][0]}">${PMAP_STATE[st][1]}${p.dirty ? ` (${esc(p.dirty)} files)` : ''}</span>`,
      branch: esc(p.branch ?? '—'), 'last commit': p.repo ? `${esc(p.lastSubject ?? '—')} (${esc(ago(p.lastCommitAt))})` : '—' });
}
// A section's items: a group's newest first (the order of the hub's ray), the belt by topic, newest first in each.
export function kpList(ctx, hub, g) {
  return g === 'belt' ? orbitingOrder(hub.t.belt) : hub.items.map(i => ctx.lay.items[i]).filter(it => it.group === g).map(it => it.t);
}
export function kpProjectHtml(ctx, hub) {
  const { esc, kp } = ctx, t = hub.t, i = ctx.lay.hubs.indexOf(hub), c = ctx.hue(hub.sector);
  for (const [g] of KP_SECTIONS) kp.lists.set(g, kpList(ctx, hub, g));
  const related = relatedProjects(hub.key, [ctx.shares, ctx.links], Infinity);
  return `<div class="kp-head" style="--c:${c}"><div class="kp-eyebrow">${esc(t.category)}</div><h3 class="kp-title">${ctx.again ? `<button class="kp-again" data-again title="Choose again to put the map back">${esc(t.name)}</button>` : esc(t.name)}</h3>`
    + `<div class="kp-chips"><span>${ctx.items(hub.count)}</span><span>${hub.newest ? `newest ${esc(ctx.age(hub.newest))}` : 'no files'}</span>`
    + `<span>${ctx.hubRim[i].length} on the rim</span></div>`
    + `<div class="kp-git" id="kp-git">${kpGitHtml(ctx, ctx.project(t))}</div>`
    + `<div class="pmap-open"><button data-app="herdr" title="Focus the herdr pane in this folder, or open its own herdr session here in a Git Bash window">▸ herdr</button>`
    + '<button data-app="bash" title="Open Git Bash in this folder, running Claude Code">▸ bash</button>'
    + '<button data-app="vscode" title="Open this folder in VS Code">▸ VS Code</button>'
    + (ctx.full ? `<a class="kp-full" href="${esc(ctx.full)}" target="_blank" rel="noopener" title="Open this project in its own page, with its file tree">⤢ Full view</a>` : '') + '</div></div>'
    + `<h4 class="kp-h">Related projects <span>${related.length}</span></h4>`
    + (related.length ? `<div class="kp-relwrap">${kpRelHtml(ctx, hub, related)}</div>` : '<p class="kp-note">No vault page or memory note orbits it and another project, and none of its documents links to one or is linked from one.</p>')
    + `<h4 class="kp-h">What it holds</h4><div class="kp-secs">${KP_SECTIONS.map(([g, label]) => kpSectionHtml(ctx, hub, g, label)).join('')}</div>`;
}
// The related projects, the top KP_RELATED or all of them, then the button that shows all or fewer, so every project
// the header counts is reachable.
export function kpRelHtml(ctx, hub, related) {
  const { esc, kp } = ctx, why = linkReasons(ctx.tree, hub.key), { rows, hidden } = relatedPage(related, kp.relAll, KP_RELATED);
  return `<div class="kp-rel">${rows.map(r => {
    const h = ctx.lay.hubs[ctx.byKey.get(r.key)];
    // Why: how many belt items both share, and how many documents link the two, naming the first linking file.
    const [shared, linked] = r.by, reason = [shared ? `${shared} shared` : '', linked ? `<em style="color:${KM_HOW.link}">${linked} link${linked === 1 ? '' : 's'}</em>` : ''];
    return `<button data-rel="${esc(r.key)}" style="--c:${ctx.hue(h.sector)}" title="${esc(r.key)}"><i></i><b>${esc(r.name)}</b>`
      + `<span>${reason.filter(Boolean).join(' · ')}</span>${linked ? `<span class="kp-why">${esc(linkWhy(why.get(r.key), r.name))}</span>` : ''}</button>`;
  }).join('')}</div>`
    + (related.length > KP_RELATED ? `<button class="kp-more" data-relall aria-expanded="${kp.relAll}">${hidden ? `Show all ${related.length} · ${hidden} more` : 'Show fewer'}</button>` : '');
}
export function kpSectionHtml(ctx, hub, g, label) {
  const { esc, kp } = ctx, list = kp.lists.get(g), cap = g !== 'belt' && hub.t.children?.find(x => x.group === g)?.more;
  const glyph = g === 'belt' ? `<span class="kp-g" style="color:${KM_SRC.vault[0]}">▮</span>` : `<span class="kp-g" style="color:${ctx.hue(hub.sector)}">${KP_GLYPH[g]}</span>`;
  if (!list.length) return `<div class="kp-sec kp-none">${glyph}<span>${esc(label)}</span><b>0</b></div>`;
  return `<details class="kp-sec" data-g="${g}"${kp.open.has(g) ? ' open' : ''}><summary>${glyph}<span>${esc(label)}</span><b>${list.length}${cap ? '+' : ''}</b></summary>`
    + `<div class="kp-list" data-g="${g}">${kpRowsHtml(ctx, hub, g, 0, kp.shown.get(g) ?? KP_PAGE)}</div></details>`;
}
// Rows [from, to) of a section, then "show more" when there are more. The belt's rows sit under their topic.
export function kpRowsHtml(ctx, hub, g, from, to) {
  const { esc, kp } = ctx, list = kp.lists.get(g), c = ctx.hue(hub.sector), end = Math.min(to, list.length);
  const topics = g === 'belt' ? list.reduce((m, b) => m.set(b.topic, (m.get(b.topic) ?? 0) + 1), new Map()) : null;
  let html = '';
  for (let i = from; i < end; i++) {
    const t = list[i];
    if (topics && (i === 0 || list[i - 1].topic !== t.topic)) html += `<div class="kp-topic"><span>${esc(t.topic)}</span><span>${topics.get(t.topic)}</span></div>`;
    html += kpRowHtml(ctx, hub, g, t, c);
  }
  const left = list.length - end;
  return html + (left > 0 ? `<button class="kp-more" data-more="${g}">Show ${Math.min(KP_PAGE, left)} more · ${left} left</button>` : '');
}
export function kpRowHtml(ctx, hub, g, t, c) {
  const { esc, pal } = ctx, belt = g === 'belt', chips = [];
  if (t.versions?.length > 1) chips.push(`<span class="kp-chip">×${t.versions.length}</span>`);
  if (t.status) chips.push(`<span class="kp-chip" style="color:${ctx.statusC(t.status)}">${esc(t.status)}</span>`);
  if (t.draft) chips.push(`<span class="kp-chip" style="color:${pal.working}">draft</span>`);
  if (belt) {
    const how = t.orbits?.find(o => o.project === hub.key)?.how;
    if (how) chips.push(`<span class="kp-chip" style="color:${KM_HOW[how] ?? pal.muted2}">${esc(how)}</span>`);
    if (t.orbits?.length > 1) chips.push(`<span class="kp-chip">orbits ${t.orbits.length}</span>`);
  }
  const glyph = belt ? (t.src === 'vault' ? '▮' : '◎') : t.status ? '◆' : KP_GLYPH[g];
  const col = belt ? KM_SRC[t.src]?.[0] ?? pal.muted2 : t.status ? ctx.mix(c, ctx.statusC(t.status), 0.45) : c;
  return `<div class="kp-it" data-id="${esc(t.id)}"><button class="kp-row" data-item="${esc(t.id)}" aria-expanded="false">`
    + `<span class="kp-g" style="color:${col}">${glyph}</span><span class="kp-name">${esc(t.name)}</span>`
    + `<span class="kp-age" title="${t.mtime ? esc(new Date(t.mtime).toLocaleString()) : ''}">${esc(kpAge(ctx, t.mtime))}</span>`
    + `${chips.length ? `<span class="kp-chips">${chips.join('')}</span>` : ''}${belt && t.why ? `<span class="kp-why">${esc(kpClip(t.why))}</span>` : ''}</button></div>`;
}

// Open a project in herdr, Git Bash or VS Code. `toast` shows the answer; `opened(p, app)` runs after a success (the board
// remembers it under Recently opened).
export async function pmapOpen(p, app, b, { toast, opened = () => {} }) {
  b.disabled = true;
  const r = await fetch('/api/project/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p.path, app }) })
    .then(x => x.json()).catch(() => ({ ok: false, reason: 'no response' }));
  b.disabled = false;
  if (r.ok) opened(p, app);
  const behind = r.raised ? '' : ' — check the taskbar';
  toast(!r.ok ? `Couldn't open ${p.name} in ${PMAP_APPS[app]}: ${r.reason}`
    : app === 'herdr' ? (r.created ? `Started herdr session ${r.session} in a Git Bash window${r.claude ? ', with Claude' : ''}${behind}`
      : r.attached ? `Attached herdr session ${r.session} in a Git Bash window${behind}`
      : `Focused ${p.name}'s pane in herdr (${r.session})${r.raised ? ` — raised ${r.raised}` : ' — switch to its window'}`)
    : app === 'vscode' ? `Opened ${p.name} in VS Code${behind}`
    : `Opened Git Bash with Claude in ${p.name}${behind}`, !r.ok);
}
