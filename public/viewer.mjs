// Markdown for the page, and the file viewer: the one marked instance every render goes through (notes, ticket and PR
// bodies, files), and showFile, which draws a knowledge file in a tile or in the standalone /view page.
import { marked } from '/vendor/marked.esm.js';
import { esc, markdownSafety, vttTurns, viewKind, fmtSize, escFrameDoc, htmlCharset } from './view-lib.mjs';

// Raw HTML is shown as text, never executed; links and images keep only safe schemes (view-lib.mjs).
marked.use(markdownSafety);
export { marked };

// Markdown file → HTML, with any front matter shown as-is above it.
export function mdHtml(text) {
  if (text == null) return '<p class="placeholder">Not readable.</p>';
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return (fm ? `<pre class="fm">${esc(fm[1])}</pre>` : '') + marked.parse(fm ? text.slice(fm[0].length) : text);
}

// Plain fetches: view.html has none of app.js's helpers.
const getText = url => fetch(url).then(r => r.ok ? r.text() : null).catch(() => null);
// An HTML file's text, read in the encoding it's served in (htmlCharset).
const getHtml = url => fetch(url).then(async r => {
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  try { return new TextDecoder(htmlCharset(bytes, r.headers.get('content-type'))).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}).catch(() => null);
const getJson = url => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
const fileUrl = id => `/api/file?id=${encodeURIComponent(id)}`;
const NOT_READABLE = '<p class="placeholder">Not readable.</p>';
const runs = new WeakMap(); // tile element → its latest showFile call

// A belt item's line above the file: the projects it orbits and why (the quoted mention, the file that links to it, or
// Haiku's reason). `from`: the project whose belt it was opened from, named first; the rest "also orbit".
function orbitsHtml(orbits, from) {
  if (!Array.isArray(orbits)) return '';
  if (!orbits.length) return '<div class="vw-orbits">Orbits no project: nothing names it or links to it.</div>';
  const one = o => `<b>${esc(o.name)}</b>${o.why ? ` <span class="vw-why">${esc(o.why)}</span>` : ''}`;
  const here = orbits.find(o => o.project === from), rest = orbits.filter(o => o !== here);
  return `<div class="vw-orbits">${here ? `Orbits ${one(here)}` : ''}${here && rest.length ? '<br>' : ''}${rest.length ? `${here ? 'Also orbits' : 'Orbits'} ${rest.map(one).join(' · ')}` : ''}</div>`;
}

const turnsHtml = turns => turns.map(t => `<div class="vtt-turn"><span class="vtt-ts">${esc(t.start)}</span> ${t.speaker ? `<b class="vtt-who">${esc(t.speaker)}</b>` : ''}<div>${esc(t.text)}</div></div>`).join('');

// What the file shows as, by its type (viewKind). HTML runs in a sandboxed frame without allow-same-origin, so its
// scripts can't reach this page or act as it (the server sandboxes it too). A PDF goes to the browser's own viewer,
// which refuses to draw inside a frame with a sandbox attribute; the server's CSP sandbox still applies to it.
// `escFrame` (a Knowledge preview): the HTML goes in as srcdoc, in the same sandbox, with escFrameDoc's fixed script
// that tells the page Esc was pressed in it; a keypress inside a frame never reaches the page otherwise.
async function mainHtml(info, id, escFrame) {
  const src = esc(fileUrl(id));
  switch (viewKind(info.ext)) {
    case 'md': return mdHtml(await getText(fileUrl(id)));
    case 'html': if (escFrame) {
      const text = await getHtml(fileUrl(id));
      return text == null ? NOT_READABLE : `<iframe class="vw-frame" sandbox="allow-scripts" srcdoc="${esc(escFrameDoc(text))}" referrerpolicy="no-referrer" title="${esc(info.name)}"></iframe>`;
    } else return `<iframe class="vw-frame" sandbox="allow-scripts" src="${src}" referrerpolicy="no-referrer" title="${esc(info.name)}"></iframe>`;
    case 'pdf': return `<iframe class="vw-frame" src="${src}" title="${esc(info.name)}"></iframe>`;
    case 'image': return `<img class="vw-img" src="${src}" alt="${esc(info.name)}">`;
    case 'office': return `<dl><dt>name</dt><dd>${esc(info.name)}</dd><dt>size</dt><dd>${esc(fmtSize(info.size))}</dd><dt>modified</dt><dd>${esc(new Date(info.mtime).toLocaleString())}</dd></dl>`;
    case 'vtt': {
      const text = await getText(fileUrl(id));
      if (text == null) return NOT_READABLE;
      const turns = vttTurns(text);
      return turns.length ? turnsHtml(turns) : `<pre class="vw-text">${esc(text)}</pre>`;
    }
    default: {
      const text = await getText(fileUrl(id));
      return text == null ? NOT_READABLE : `<pre class="vw-text">${esc(text)}</pre>`;
    }
  }
}

// A knowledge file (by its index id) into a tile's body: a toolbar (the item's versions, newest first; ⧉ to open it in
// its own window; Open in default app for an Office file), then the file. `standalone`: the /view page, which takes its
// title from the file and keeps its address on the version shown. `from`: for a belt item, the project whose belt it was
// opened from. `escFrame`: see mainHtml. A load that finishes after the tile has moved on (the drawer reuses one element for every item) or after
// a newer call writes nothing.
export async function showFile(tileEl, id, { standalone = false, from = null, escFrame = false } = {}) {
  const opts = { standalone, from, escFrame }, key = tileEl.dataset.key, run = (runs.get(tileEl) ?? 0) + 1;
  runs.set(tileEl, run);
  const stale = () => tileEl.dataset.key !== key || runs.get(tileEl) !== run;
  const body = tileEl.querySelector('.tile-body');
  const info = await getJson(`/api/file-info?id=${encodeURIComponent(id)}`);
  if (stale()) return;
  if (!info) { body.innerHTML = NOT_READABLE; return; }
  if (standalone) {
    const title = info.title ?? info.name;
    tileEl.querySelector('.title').textContent = title;
    tileEl.querySelector('.sub').textContent = [info.project, info.group].filter(Boolean).join(' · ');
    document.title = `${title} · Cleon`;
  }
  const office = viewKind(info.ext) === 'office';
  const bar = [
    info.versions ? `<select class="vw-ver" title="Versions, newest first">${info.versions.map(v =>
      `<option value="${esc(v.file)}"${v.file === id ? ' selected' : ''}>${esc(v.name)} · ${esc(new Date(v.mtime).toLocaleDateString())}${v.draft ? ' (draft)' : ''}</option>`).join('')}</select>` : '',
    office ? '<button class="vw-open">Open in default app</button><span class="vw-msg"></span>' : '',
    standalone ? '' : '<button class="vw-pop" title="Open in its own window">⧉</button>',
  ].join('');
  const main = await mainHtml(info, id, escFrame);
  if (stale()) return;
  body.innerHTML = `<div class="vw"><div class="vw-bar">${bar}</div>${orbitsHtml(info.orbits, from)}<div class="vw-main">${main}</div></div>`;
  body.scrollTop = 0;
  const sel = body.querySelector('.vw-ver');
  if (sel) sel.onchange = () => {
    if (standalone) history.replaceState(null, '', `/view?id=${encodeURIComponent(sel.value)}`);
    showFile(tileEl, sel.value, opts);
  };
  const open = body.querySelector('.vw-open');
  if (open) open.onclick = async () => {
    const msg = body.querySelector('.vw-msg');
    msg.textContent = 'Opening…';
    const r = await fetch('/api/file/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      .then(x => x.json()).catch(() => null);
    msg.textContent = r?.ok ? 'Opened' : r?.reason ?? r?.error ?? "Couldn't reach Cleon";
  };
  // One window per item, whichever of its versions it shows: a window of that name is reused rather than opened again,
  // even after this page reloads, and is sent to this version when it shows another (or has gone to another site). A new
  // one opens blank and is sent to /view the same way.
  const pop = body.querySelector('.vw-pop');
  if (pop) pop.onclick = () => {
    const w = window.open('', `cleon-view-${info.item ?? id}`, 'popup,width=980,height=1000');
    if (!w) return;
    const url = `/view?id=${encodeURIComponent(id)}`;
    let shows = null;
    try { shows = w.location.pathname + w.location.search; } catch { /* it went to another site */ }
    if (shows !== url) w.location.href = url;
    w.focus();
  };
}
