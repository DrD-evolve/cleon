// /project?key=<category>/<name>: one project full-page. The side panel's content (project-panel.mjs, the same renderers
// the Knowledge panel uses, laid out by the same radialLayout) beside a file tree and a preview. The tree loads one folder
// at a time from /api/project/tree and previews through /api/file (a file the knowledge index holds) or /api/project/file
// (plain text, in a sandbox); a file neither will show offers VS Code on the project's folder, never on the file.
import { mdHtml, showFile } from '/viewer.mjs';
import { esc, fmtSize } from '/view-lib.mjs';
import { mix } from '/palette.mjs';
import { PAL, onPalette, catColor, kmStatusC, kmColors } from '/page-palette.mjs';
import { radialLayout } from '/radial-layout.mjs';
import { panelIndex, relatedProjects } from '/knowledge-panel.mjs';
import { KP_PAGE, kpProjectHtml, kpRelHtml, kpRowsHtml, pmapOpen } from '/project-panel.mjs';

const $ = s => document.querySelector(s);
const key = new URLSearchParams(location.search).get('key') ?? '';
const ago = ms => {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;
};
const dl = obj => `<dl>${Object.entries(obj).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const getJson = url => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
function toast(text, bad, ms = 3500) {
  const t = document.createElement('div');
  t.className = `toast ${bad ? 'bad' : ''}`;
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// The panel's state, as the board keeps it for the side panel.
const kp = { open: new Set(), shown: new Map(), lists: new Map(), relAll: false };
let tree, lay, idx, projects = [], hub = null;
const project = t => projects.find(p => p.path === t.path) ?? { name: t.name, category: t.category, path: t.path };
const ctx = () => ({ lay, tree, byKey: idx.byKey, shares: idx.shares, links: idx.links, hubRim: idx.hubRim, kp, project,
  hue: catColor, pal: PAL, mix, statusC: kmStatusC, esc, ago, dl, items: n => `${n} item${n === 1 ? '' : 's'}`,
  age: ms => (ms ? `${ago(ms).replace(' ago', '')} old` : 'no files'), again: false, full: null });

const renderPanel = () => { $('#pj-panel').innerHTML = kpProjectHtml(ctx(), hub); };
$('#pj-panel').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.rel) location.href = `/project?key=${encodeURIComponent(d.rel)}`;
  else if (d.relall !== undefined) {
    kp.relAll = !kp.relAll;
    const wrap = b.closest('.kp-relwrap');
    wrap.innerHTML = kpRelHtml(ctx(), hub, relatedProjects(hub.key, [idx.shares, idx.links], Infinity));
    wrap.querySelector('[data-relall]')?.focus();
  } else if (d.more) {
    const g = d.more, n = kp.shown.get(g) ?? KP_PAGE;
    kp.shown.set(g, n + KP_PAGE);
    b.insertAdjacentHTML('afterend', kpRowsHtml(ctx(), hub, g, n, n + KP_PAGE));
    b.remove();
  } else if (d.item) {
    const g = b.closest('.kp-list')?.dataset.g, t = g && kp.lists.get(g).find(x => x.id === d.item);
    if (t) showIndexed(t.file, t.name, g === 'belt' ? hub.key : null);
  } else if (d.app) pmapOpen(project(hub.t), d.app, b, { toast });
});
// A section opened or closed stays that way when the panel draws again (a theme change).
$('#pj-panel').addEventListener('toggle', e => {
  const g = e.target.dataset?.g;
  if (g) e.target.open ? kp.open.add(g) : kp.open.delete(g);
}, true);

/* ---------- Preview ---------- */
const pv = $('#pj-pv'), pvBody = () => pv.querySelector('.tile-body'), pvBar = pv.querySelector('.pj-pv-bar');
let pvRun = 0;
function pvStart(name, detail) {
  pv.dataset.key = `pv:${++pvRun}`; // showFile's own stale check: a later pick makes an earlier load write nothing
  pvBar.innerHTML = `<b>${esc(name)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}`;
  pvBody().innerHTML = '<p class="placeholder">loading…</p>';
  return pvRun;
}
function showIndexed(id, name, from) {
  pvStart(name, 'knowledge file');
  showFile(pv, id, { from, escFrame: true });
}
// A file the page can't show: why, and VS Code on the project's folder (the only thing the server will open).
function pvRefused(why) {
  pvBody().innerHTML = `<p class="placeholder">${esc(why)}</p><p><button class="pj-code" title="Open the project folder in VS Code">▸ VS Code (project folder)</button></p>`;
}
pv.addEventListener('click', e => {
  const b = e.target.closest('.pj-code');
  if (b && hub) pmapOpen(project(hub.t), 'vscode', b, { toast });
});
async function showText(path, size, mtime) {
  const run = pvStart(path, [Number.isFinite(size) ? fmtSize(size) : '', mtime ? ago(mtime) : ''].filter(Boolean).join(' · '));
  const r = await fetch(`/api/project/file?${new URLSearchParams({ key, path })}`).catch(() => null);
  if (run !== pvRun) return;
  if (!r) return pvRefused("Couldn't reach Cleon.");
  if (r.status === 403) return pvRefused(`Not shown here: ${(await r.json().catch(() => ({}))).reason ?? 'blocked'}.`);
  if (r.status === 413) return pvRefused('Too large to preview (over 512 KB).');
  if (r.status === 415) return pvRefused('No preview for this type of file.');
  if (!r.ok) return pvRefused('Not found.');
  const text = await r.text();
  if (run !== pvRun) return;
  pvBody().innerHTML = /\.(md|markdown)$/i.test(path) ? `<div class="vw-main">${mdHtml(text)}</div>` : `<pre class="vw-text">${esc(text)}</pre>`;
  pvBody().scrollTop = 0;
}

/* ---------- File tree ---------- */
// A git mark is a letter and a word, never colour alone.
const MARKS = { modified: ['M', 'changed'], untracked: ['U', 'untracked'], ignored: ['I', 'ignored'] };
function rowHtml(e, path) {
  const m = e.git && MARKS[e.git], dir = e.type === 'dir', inert = e.type === 'link' || e.type === 'other', here = path ? `${path}/${e.name}` : e.name;
  const mark = m ? `<span class="pj-mark" data-m="${e.git}" title="${m[1]} in git">${m[0]}</span>` : '';
  const cls = ['pj-row', dir ? 'dir' : 'file', e.collapsed ? 'quiet' : '', inert ? 'inert' : ''].filter(Boolean).join(' ');
  const attrs = `data-path="${esc(here)}" data-type="${e.type}"${e.id ? ` data-id="${esc(e.id)}"` : ''} data-preview="${e.preview}"`
    + `${e.reason ? ` data-reason="${esc(e.reason)}"` : ''}${e.size == null ? '' : ` data-size="${e.size}"`}${e.mtime ? ` data-mtime="${e.mtime}"` : ''}`;
  const glyph = dir ? '▸' : e.type === 'link' ? '↪' : inert ? '·' : '▫';
  return `<li role="treeitem"${dir ? ' aria-expanded="false"' : ''}><button class="${cls}" ${attrs}${inert ? ' disabled' : ''}>`
    + `<span class="pj-tw">${glyph}</span><span class="pj-name">${esc(e.name)}</span>`
    + `${dir || e.size == null ? '' : `<span class="pj-size">${esc(fmtSize(e.size))}</span>`}${mark}</button>${dir ? '<ul role="group" hidden></ul>' : ''}</li>`;
}
async function loadFolder(path, ul) {
  ul.innerHTML = '<li class="pj-note">loading…</li>';
  const d = await getJson(`/api/project/tree?${new URLSearchParams({ key, path })}`);
  if (!d) { ul.innerHTML = '<li class="pj-note">Not available.</li>'; return false; }
  ul.innerHTML = d.entries.map(e => rowHtml(e, path)).join('') + (d.more ? `<li class="pj-note">${d.more} more not shown</li>` : '')
    || '<li class="pj-note">Empty.</li>';
  return true;
}
$('#pj-tree').addEventListener('click', async e => {
  const b = e.target.closest('.pj-row');
  if (!b || b.disabled) return;
  const li = b.parentElement, d = b.dataset;
  document.querySelectorAll('#pj-tree .pj-row.on').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  if (d.type === 'dir') {
    const ul = li.querySelector('ul'), open = li.getAttribute('aria-expanded') === 'true';
    li.setAttribute('aria-expanded', String(!open));
    ul.hidden = open;
    b.querySelector('.pj-tw').textContent = open ? '▸' : '▾';
    if (!open && !ul.dataset.loaded) ul.dataset.loaded = (await loadFolder(d.path, ul)) ? '1' : '';
  } else if (d.preview === 'index') showIndexed(d.id, d.path, null);
  else if (d.preview === 'text') showText(d.path, Number(d.size), Number(d.mtime));
  else { pvStart(d.path, ''); pvRefused(d.preview === 'blocked' ? `Not shown here: ${d.reason ?? 'blocked'}.` : 'No preview for this type of file.'); }
});

/* ---------- Archive readiness ---------- */
// One chip per fact, each [state, words]: hold (look before archiving), ok (clear) or info. The words carry the meaning; the
// colour only tints.
const plural = (c, one) => `${c} ${one}${c === 1 ? '' : 's'}`;
// Linear issues or pull requests already loaded for this project: null = not loaded yet. An item links only for an https address.
const linked = (items, field) => items.map(i => (String(i.url ?? '').startsWith('https://') ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i[field])}</a>` : esc(i[field]))).join(', ');
function refChip(label, r, field) {
  if (!r) return ['info', `${label}s: not loaded yet`];
  if (!r.open) return ['ok', `No open ${label}s of yours`]; // the reads hold only yours (assigned, authored, review asked)
  return ['hold', `${plural(r.open, `open ${label}`)}: ${linked(r.items, field)}${r.open > r.items.length ? ', …' : ''}`, true];
}
function readyChips(d) {
  const g = d.git, m = d.mentions;
  const chips = [['info', d.activity.at ? `Last activity ${ago(d.activity.at)}${d.activity.partial ? ' (scan cut short: at least this recent)' : ''}` : 'No file activity found']];
  if (!g) chips.push(['info', 'Not in git']);
  else if (g.unreadable) chips.push(['hold', 'Git state unreadable']);
  else {
    chips.push(g.uncommitted ? ['hold', plural(g.uncommitted, 'uncommitted change')] : ['ok', 'Nothing uncommitted']);
    // With no remote every commit is "unpushed": one chip says both.
    if (!g.remote) chips.push(['hold', `No remote${g.unpushed ? ` (${plural(g.unpushed, 'local commit')})` : ''}`]);
    else {
      chips.push(g.unpushed ? ['hold', plural(g.unpushed, 'unpushed commit')] : ['ok', 'Nothing unpushed']);
      if (g.upstream === 'none') chips.push(['hold', 'Branch has no upstream']);
      else if (g.upstream === 'gone') chips.push(['hold', 'Upstream branch is gone']);
      else if (g.upstream === 'detached') chips.push(['info', 'Detached HEAD']);
    }
  }
  chips.push(d.env ? ['hold', '.env file present'] : ['ok', 'No .env file']);
  chips.push(d.memory ? ['hold', 'Memory folder present'] : ['ok', 'No memory folder']);
  chips.push(d.mcp === null ? ['info', 'MCP server: unknown'] : d.mcp ? ['hold', 'MCP server: yes'] : ['ok', 'MCP server: no']);
  chips.push(m.claudeMd ? ['hold', 'Named in CLAUDE.md'] : ['ok', 'Not in CLAUDE.md']);
  chips.push(m.workspace ? ['hold', 'Named in a workspace file'] : ['ok', 'Not in a workspace file']);
  if (m.projectList !== null) chips.push(m.projectList ? ['hold', 'In the project list'] : ['ok', 'Not in the project list']);
  chips.push(refChip('Linear issue', d.linear, 'id'), refChip('pull request', d.prs, 'ref'));
  return chips;
}
// A chip's words are escaped here, except where refChip drew links (it escaped their text itself).
const chipHtml = ([s, text, raw]) => `<span class="pj-flag" data-s="${s}">${raw ? text : esc(text)}</span>`;
async function loadReadiness() {
  const d = await getJson(`/api/project/readiness?${new URLSearchParams({ key })}`);
  let html = null;
  try { html = d && readyChips(d).map(chipHtml).join(''); } catch { /* an answer of an unexpected shape */ }
  $('#pj-ready').innerHTML = html || NO_READINESS;
}
const NO_READINESS = 'Archive readiness is not available.';

/* ---------- Load ---------- */
// The same two reads the board makes (/api/knowledge as cached, never ?refresh=1, and /api/projects); no rebuild, no model.
async function init() {
  const [k, p] = await Promise.all([getJson('/api/knowledge'), getJson('/api/projects')]);
  if (!k?.tree) { $('#pj-name').textContent = 'Cleon is not answering'; $('#pj-ready').textContent = NO_READINESS; return; }
  projects = Array.isArray(p) ? p : [];
  tree = k.tree; lay = radialLayout(tree); idx = panelIndex(lay, tree);
  hub = lay.hubs.find(h => h.key === key) ?? null;
  if (!hub) {
    $('#pj-name').textContent = 'Not a known project';
    $('#pj-ready').textContent = NO_READINESS;
    $('#pj-panel').innerHTML = `<p class="kp-note">${esc(key || 'No project named')} is not on the knowledge map (it may be excluded, or gone).</p>`;
    return;
  }
  $('#pj-cat').textContent = hub.t.category;
  $('#pj-cat').style.setProperty('--c', catColor(hub.sector));
  $('#pj-name').textContent = hub.t.name;
  document.title = `${hub.t.name} · Cleon`;
  renderPanel();
  loadReadiness();
  const root = document.createElement('ul');
  root.setAttribute('role', 'group');
  $('#pj-tree').append(root);
  loadFolder('', root);
}
// A theme change: the panel's colours are inline, so it draws again (its open sections and scroll stay).
onPalette(() => {
  kmColors();
  if (!hub) return;
  const top = $('#pj-panel').scrollTop;
  renderPanel();
  $('#pj-panel').scrollTop = top;
});
init();
