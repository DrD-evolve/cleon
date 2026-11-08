// Markdown for the page, and the file viewer: the one marked instance every render goes through (notes, ticket and PR
// bodies, files), and showFile, which draws a knowledge file in a tile or in the standalone /view page.
import { marked } from '/vendor/marked.esm.js';
import { esc, markdownSafety, vttTurns, viewKind, fmtSize } from './view-lib.mjs';

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
const getJson = url => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
const fileUrl = id => `/api/file?id=${encodeURIComponent(id)}`;
const NOT_READABLE = '<p class="placeholder">Not readable.</p>';
const runs = new WeakMap(); // tile element → its latest showFile call

const turnsHtml = turns => turns.map(t => `<div class="vtt-turn"><span class="vtt-ts">${esc(t.start)}</span> ${t.speaker ? `<b class="vtt-who">${esc(t.speaker)}</b>` : ''}<div>${esc(t.text)}</div></div>`).join('');

// What the file shows as, by its type (viewKind). HTML runs in a sandboxed frame without allow-same-origin, so its
// scripts can't reach this page or act as it (the server sandboxes it too). A PDF goes to the browser's own viewer,
// which refuses to draw inside a frame with a sandbox attribute; the server's CSP sandbox still applies to it.
async function mainHtml(info, id) {
  const src = esc(fileUrl(id));
  switch (viewKind(info.ext)) {
    case 'md': return mdHtml(await getText(fileUrl(id)));
    case 'html': return `<iframe class="vw-frame" sandbox="allow-scripts" src="${src}" referrerpolicy="no-referrer" title="${esc(info.name)}"></iframe>`;
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
// title from the file and keeps its address on the version shown. A load that finishes after the tile has moved on
// (the drawer reuses one element for every item) or after a newer call writes nothing.
export async function showFile(tileEl, id, { standalone = false } = {}) {
  const opts = { standalone }, key = tileEl.dataset.key, run = (runs.get(tileEl) ?? 0) + 1;
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
  const main = await mainHtml(info, id);
  if (stale()) return;
  body.innerHTML = `<div class="vw"><div class="vw-bar">${bar}</div><div class="vw-main">${main}</div></div>`;
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
  // One window per file: a window of that name is reused (focused) rather than opened again, even after this page
  // reloads; a new one opens blank and is sent to /view.
  const pop = body.querySelector('.vw-pop');
  if (pop) pop.onclick = () => {
    const w = window.open('', `cleon-view-${id}`, 'popup,width=980,height=1000');
    if (!w) return;
    let blank = false;
    try { blank = w.location.href === 'about:blank'; } catch { /* it went to another site: just bring it forward */ }
    if (blank) w.location.href = `/view?id=${encodeURIComponent(id)}`;
    else w.focus();
  };
}
