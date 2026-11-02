import { marked } from '/vendor/marked.esm.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = ms => {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;
};
// Server down (e.g. mid-restart) yields null, so panels keep their last state instead of throwing.
const api = p => fetch(p).then(r => r.ok ? (r.headers.get('content-type')?.includes('json') ? r.json() : r.text()) : null).catch(() => null);

// Raw HTML inside notes is shown as text, never executed.
marked.use({ renderer: { html: t => esc(t.text ?? t) } });

/* ---------- Tiles: draggable floating windows ---------- */
let tileZ = 10, tileN = 0;
const openTiles = new Map();
// Info tiles open as stacking pop-ups or in one side drawer from the right (a new item replaces
// the last). The choice is per-browser; it applies to tiles opened after it changes.
let tileMode = (() => { try { return localStorage.getItem('mc.tileMode') === 'drawer' ? 'drawer' : 'popup'; } catch { return 'popup'; } })();
function setTileMode(m) {
  tileMode = m;
  try { localStorage.setItem('mc.tileMode', m); } catch { /* not remembered */ }
  if (m === 'popup') closeDrawer();
}
// Where the click that opens a view came from. A view opened from inside another (a task's output
// from a ticket's detail) gets "← back". Window capture runs before every other click handler.
let openedFrom = null;
addEventListener('click', e => { openedFrom = e.target.closest?.('.tile') ?? null; }, true);

// The drawer has the same .tile-bar/.tile-body structure as a pop-up, so every tile view works in it.
// Views opened from inside it stack: the one they replace is kept whole (its nodes, so its buttons and
// live sections still work) and comes back with "← back".
const drawerBack = [];
function showDrawerBack(el) {
  const b = el.querySelector('.back');
  b.hidden = !drawerBack.length;
  b.title = drawerBack.length ? `Back to ${drawerBack.at(-1).title}` : '';
}
function drawerGoBack() {
  const el = $('#drawer'), v = drawerBack.pop();
  if (!el || !v) return;
  el.dataset.key = v.key;
  el.querySelector('.title').textContent = v.title;
  el.querySelector('.sub').textContent = v.sub;
  const body = el.querySelector('.tile-body');
  body.replaceChildren(...v.nodes);
  body.scrollTop = v.scroll;
  showDrawerBack(el);
  refreshTiles(); pollTaskTiles(); // it missed refreshes while it was put aside
}
function drawer(key, title, sub, html) {
  let el = $('#drawer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'drawer';
    el.className = 'tile drawer';
    el.innerHTML = '<div class="tile-bar"><button class="back" hidden>← back</button><span class="title"></span><span class="sub"></span><button class="close" title="Close (Esc)">✕</button></div><div class="tile-body"></div>';
    el.querySelector('.close').onclick = closeDrawer;
    el.querySelector('.back').onclick = drawerGoBack;
    document.body.append(el);
  }
  if (el.dataset.key !== key || !el.classList.contains('open')) {
    const body = el.querySelector('.tile-body');
    if (openedFrom === el && el.classList.contains('open') && el.dataset.key)
      drawerBack.push({ key: el.dataset.key, title: el.querySelector('.title').textContent, sub: el.querySelector('.sub').textContent,
        nodes: [...body.childNodes], scroll: body.scrollTop });
    else drawerBack.length = 0;
    showDrawerBack(el);
    el.dataset.key = key; // late async content checks this before writing (see fileTile)
    el.querySelector('.title').textContent = title;
    el.querySelector('.sub').textContent = sub;
    el.querySelector('.tile-body').innerHTML = html;
    el.querySelector('.tile-body').scrollTop = 0;
  }
  drawerFilled = true; // tells the click-outside handler this click opened the drawer
  requestAnimationFrame(() => el.classList.add('open'));
  return el;
}
function closeDrawer() {
  const el = $('#drawer');
  if (!el) return;
  el.classList.remove('open');
  delete el.dataset.key;
  drawerBack.length = 0;
  el.querySelector('.tile-body').innerHTML = ''; // drop its live sections so refreshes stop touching them
}
addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
// A click in the board closes the drawer — unless that same click opened something in it (a card,
// a flow node). The capture listener runs before any handler, the bubble one after them all.
let drawerFilled = false;
addEventListener('click', () => { drawerFilled = false; }, true);
addEventListener('click', e => {
  const el = $('#drawer');
  if (!el?.classList.contains('open') || drawerFilled || el.contains(e.target) || !e.target.closest?.('main')) return;
  closeDrawer();
});

function tile(key, title, sub, html) {
  if (tileMode === 'drawer') return drawer(key, title, sub, html);
  if (openTiles.has(key)) { const t = openTiles.get(key); t.style.zIndex = ++tileZ; t.animate([{ filter: 'brightness(2)' }, {}], 300); return t; }
  const el = document.createElement('div');
  el.className = 'tile';
  el.dataset.key = key;
  const off = (tileN++ % 6) * 28;
  el.style.left = `${Math.max(16, innerWidth / 2 - 280 + off)}px`;
  el.style.top = `${80 + off}px`;
  el.style.zIndex = ++tileZ;
  // Opened from inside another pop-up: "← back" closes this one and brings that one forward.
  const parent = openedFrom && openedFrom.id !== 'drawer' ? openedFrom : null;
  el.innerHTML = `<div class="tile-bar">${parent ? '<button class="back">← back</button>' : ''}<span class="title">${esc(title)}</span><span class="sub">${esc(sub)}</span><button class="close" title="Close">✕</button></div><div class="tile-body">${html}</div>`;
  const close = () => { el.remove(); openTiles.delete(key); };
  el.querySelector('.close').onclick = close;
  if (parent) el.querySelector('.back').onclick = () => {
    close();
    if (parent.isConnected) { parent.style.zIndex = ++tileZ; parent.animate([{ filter: 'brightness(1.6)' }, {}], 300); }
  };
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++tileZ; });
  const bar = el.querySelector('.tile-bar');
  bar.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    const move = m => { el.style.left = `${m.clientX - sx}px`; el.style.top = `${Math.max(0, m.clientY - sy)}px`; };
    addEventListener('pointermove', move);
    addEventListener('pointerup', () => removeEventListener('pointermove', move), { once: true });
  });
  $('#tiles').append(el);
  openTiles.set(key, el);
  return el;
}
// Markdown file → HTML, with any front matter shown as-is above it.
function mdHtml(text) {
  if (text == null) return '<p class="placeholder">Not readable.</p>';
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return (fm ? `<pre class="fm">${esc(fm[1])}</pre>` : '') + marked.parse(fm ? text.slice(fm[0].length) : text);
}
async function fileTile(key, title, sub, url) {
  const t = tile(key, title, sub, '<p class="placeholder">loading…</p>');
  const text = await api(url);
  if (t.dataset.key !== key) return; // the drawer has moved on to another item while this loaded
  t.querySelector('.tile-body').innerHTML = mdHtml(text);
}
const dl = obj => `<dl>${Object.entries(obj).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

/* ---------- Sessions + Herdr ---------- */
let state = { sessions: [], runs: null, herdr: null, projects: [] };

const attentionFor = id => (state.attention ?? []).find(a => a.sessionId === id);
const dialogLine = a => a && (a.title || a.question)
  ? `${a.title ? `${a.title}: ` : ''}${a.question ?? ''}`.replace(/\s+/g, ' ').slice(0, 160) : null;

function renderSessions() {
  const live = state.sessions.filter(s => s.alive);
  $('#sessions-count').textContent = `${live.length} live`;
  $('#sessions').innerHTML = state.sessions.map((s, i) => `
    <div class="card ${esc(s.status)} ${s.alive ? '' : 'dead'} ${attentionFor(s.id) ? 'needs' : ''}" data-i="${i}">
      <div class="t"><span>${esc(s.name)}</span><span class="t-right">${s.alive ? jumpBtn(s) : ''}<span class="chip c-${esc(s.status)}">${esc(s.alive ? s.status : 'gone')}</span></span></div>
      <div class="s">${esc(s.cwd)}</div>
      <div class="s">${s.ticket ? `ticket ${esc(s.ticket)} · ` : ''}updated ${ago(s.updatedAt)}</div>
      ${(a => a ? `<div class="s wk-needs" title="${esc([dialogLine(a), ...[...a.options, ...(a.items ?? [])].map((o, n) => `${n + 1}. ${o}`)].filter(Boolean).join('\n'))}">◆ awaiting you${dialogLine(a) ? ` · ${esc(dialogLine(a))}` : ' · a question is open'}</div>` : '')(attentionFor(s.id))}
    </div>`).join('') || '<div class="placeholder">No sessions.</div>';
  bindJumps($('#sessions'));
  $('#sessions').querySelectorAll('.card').forEach(c => c.onclick = () => {
    const s = state.sessions[c.dataset.i];
    const t = s.ticket && findTicket(s.ticket);
    const el = tile(`session:${s.id}`, s.name, 'claude session', dl({
      status: esc(s.status), alive: s.alive ? 'yes' : 'no (stale session file)', cwd: esc(s.cwd), pid: esc(s.pid),
      kind: esc(s.kind), started: esc(new Date(s.startedAt).toLocaleString()), updated: ago(s.updatedAt), 'session id': esc(s.id),
      ...(t ? { 'flow step': `${stepChip(t)} in ${esc(t.epic)}` } : {}),
      ...(s.alive ? { focus: jumpBtn(s, true) } : {}),
    }));
    bindJumps(el);
  });
}
const jumpBtn = (s, label) => `<button class="jump-btn" data-session="${esc(s.id)}" data-what="${esc(s.name)}" title="Focus this session">⏵${label ? ' focus session' : ''}</button>`;

function renderHerdr() {
  const h = state.herdr;
  if (!h) return;
  if (!h.online) {
    $('#herdr-count').textContent = 'offline';
    $('#herdr').innerHTML = `<div class="placeholder">${esc(h.reason)}</div>`;
    return;
  }
  $('#herdr-count').textContent = `${h.workspaces.length} ws · ${h.agents.length} agents`;
  $('#herdr').innerHTML = h.workspaces.map(w => {
    const agents = h.agents.filter(a => a.session === w.session && a.workspace_id === w.workspace_id);
    return `<div class="card ${esc(w.agent_status)}">
      <div class="t"><span>${esc(w.label || w.workspace_id)}</span><span class="chip c-${esc(w.agent_status)}">${esc(w.agent_status)}</span></div>
      <div class="s">${esc(w.session)} · ${w.tab_count} tabs · ${w.pane_count} panes${w.worktree ? ' · worktree' : ''}</div>
      ${agents.map(a => `<div class="s jump" data-pane="${esc(a.pane_id)}" data-label="${esc(w.label ?? '')}" data-what="${esc(`${w.label || w.workspace_id} · ${a.agent || a.pane_id}`)}" title="focus in herdr">▸ ${esc(a.agent || a.pane_id)} <span class="chip c-${esc(a.agent_status)}">${esc(a.agent_status)}</span></div>`).join('')}
    </div>`;
  }).join('') || '<div class="placeholder">No workspaces.</div>';
  bindJumps($('#herdr'));
}

// A pane is live when herdr lists it in the run's workspace (matched by label, since ids like
// "w2" repeat across sessions).
const livePane = (pane, label) => state.herdr?.online && state.herdr.agents.some(a => a.pane_id === pane
  && (!label || state.herdr.workspaces.some(w => w.session === a.session && w.workspace_id === a.workspace_id && w.label === label)));
// Any element with data-pane or data-ws becomes a jump into herdr.
// Elements with data-session jump to a Claude session (its herdr pane, or its VS Code window).
function bindJumps(root) {
  root.querySelectorAll('[data-pane], [data-ws], [data-session]').forEach(el => el.onclick = e => {
    e.stopPropagation(); // a jump inside a card shouldn't also open the card's tile
    if (el.dataset.session) return jump('/api/session/focus', { id: el.dataset.session }, el, el.dataset.what);
    jump('/api/herdr/focus', { pane: el.dataset.pane || undefined, workspace: el.dataset.ws || undefined, label: el.dataset.label || undefined },
      el, el.dataset.what);
  });
}
async function jump(url, body, el, what) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
  el.classList.toggle('jump-fail', !r.ok);
  el.classList.add('jump-flash');
  setTimeout(() => el.classList.remove('jump-flash'), 900);
  // herdr focus switches the pane; the window raise brings VS Code forward. A plain VS Code terminal
  // can only have its window raised — VS Code can't be told which terminal tab to show.
  toast(!r.ok ? `Couldn't focus ${what}: ${r.reason}`
    : r.via === 'vscode' ? `Raised ${r.raised} — ${what} is in one of its terminals`
    : r.raised ? `Focused ${what} — raised ${r.raised}` : `Focused ${what} in herdr (${r.session}) — switch to your herdr terminal`, !r.ok);
}
function toast(text, bad) {
  const t = document.createElement('div');
  t.className = `toast ${bad ? 'bad' : ''}`;
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

/* ---------- Projects ---------- */
function renderProjects() {
  $('#projects-count').textContent = state.projects.length;
  $('#projects').innerHTML = state.projects.map((p, i) => `
    <div class="card ${p.dirty ? 'busy' : 'idle'}" data-i="${i}">
      <div class="t"><span>${esc(p.name)}</span><span class="chip c-${p.dirty ? 'busy' : 'idle'}">${p.repo ? (p.dirty ? `${p.dirty} changed` : 'clean') : 'no repo'}</span></div>
      <div class="s">${esc(p.category)}${p.branch ? ` · ${esc(p.branch)}` : ''} · ${ago(p.lastCommitAt)}</div>
      ${p.lastSubject ? `<div class="s">${esc(p.lastSubject)}</div>` : ''}
    </div>`).join('');
  $('#projects').querySelectorAll('.card').forEach(c => c.onclick = () => {
    const p = state.projects[c.dataset.i];
    tile(`project:${p.path}`, p.name, p.category, dl({ path: esc(p.path), branch: esc(p.branch ?? '—'),
      'uncommitted files': esc(p.dirty ?? '—'), 'last commit': `${esc(p.lastSubject ?? '—')} (${ago(p.lastCommitAt)})` }));
  });
}

/* ---------- Orchestration flows ---------- */
// One CI verdict per PR. The per-ticket checks feed (≤~60s old) wins over the GitHub summary
// (≤~2min old), so a check that failed and was re-run doesn't linger as "failing".
function ciState(prUrl) {
  const c = Object.values(state.checks ?? {}).find(c => c.url === prUrl);
  if (c) {
    const bad = c.checks.filter(k => k.bucket === 'fail' || k.bucket === 'cancel');
    const verdict = bad.length ? 'failing' : c.checks.some(k => k.bucket === 'pending') ? 'pending' : c.checks.length ? 'passing' : 'none';
    return { state: verdict, failed: bad.map(k => k.name) };
  }
  const p = state.github?.myPrs?.find(p => p.url === prUrl);
  return p ? { state: p.checks, failed: [] } : null;
}
// One chip for a ticket's step everywhere it appears; a held ticket reads "held", not the step it waits for.
// At review·merge, a merge you've already handed to the orchestrator (your prompt, after review
// finished, naming the PR or ticket) is the orchestrator's to finish — not something waiting on you.
function mergeApproved(t, epic = t.epic) {
  if (t.step !== 'human-review' || !t.pr) return false;
  const n = Number(t.pr.split('/').pop());
  const o = (state.orch ?? []).find(o => o.epic === epic);
  return Boolean(o?.approvals?.some(a => (a.prs.includes(n) || a.tickets.includes(t.ticket)) && (!t.since || a.t >= t.since)));
}
// At review·merge, a PR whose CI is still running can't be merged yet, so it isn't waiting on you.
// It flags you once CI finishes, or as soon as a check fails.
const awaitingCi = t => t.step === 'human-review' && Boolean(t.pr) && ciState(t.pr)?.state === 'pending';
const stepChip = t => t.held ? '<span class="chip c-held">⏸ held</span>'
  : mergeApproved(t) ? '<span class="chip c-busy">merge approved</span>'
  : awaitingCi(t) ? '<span class="chip c-busy">awaiting CI</span>'
  : `<span class="chip c-${esc(t.step)}">${esc(t.fixRound ? 'implementing (fix round)' : t.step)}</span>`;
function findTicket(id) {
  for (const r of state.runs?.runs ?? []) { const t = r.tickets.find(t => t.ticket === id); if (t) return { ...t, epic: r.epic, wsId: r.workspace, wsLabel: r.label }; }
  return null;
}

// Flowchart geometry (SVG user units; the svg scales to the panel width).
const FC = { y: 78, x0: 50, dx: 150, r: 15 };
const fcX = i => FC.x0 + i * FC.dx;
const LOOPS = [ // feedback paths from a gate back to an earlier step
  { from: 'plan-gate', to: 'planning', label: 'redirect', lift: 46, taken: () => false },
  { from: 'human-review', to: 'implementing', label: 'changes requested', lift: 58, taken: t => t.fixRound },
];
const shape = (f, x, cls) => f.you
  ? `<polygon class="${cls}" points="${x},${FC.y - 19} ${x + 19},${FC.y} ${x},${FC.y + 19} ${x - 19},${FC.y}"/>`
  : `<circle class="${cls}" cx="${x}" cy="${FC.y}" r="${FC.r}"/>`;
const particle = path => `<circle class="fc-particle" r="3.5"><animateMotion dur="1.3s" repeatCount="indefinite" path="${path}"/></circle>`;

function flowSvg(flow, t) {
  const idx = flow.findIndex(f => f.id === t.step);
  const done = t.step === 'done';
  const parts = [];
  // Forward edges
  for (let i = 0; i < flow.length - 1; i++) {
    const a = fcX(i) + 21, b = fcX(i + 1) - 21, d = `M${a},${FC.y} L${b},${FC.y}`;
    const into = i + 1 === idx && !done; // the edge arriving at the current step
    const live = into && !t.fixRound && !t.held;
    parts.push(`<path class="fc-edge ${into && t.held ? 'held' : i + 1 <= idx ? (live ? 'live' : 'past') : ''}" d="${d}"/>`);
    if (live && !t.stale) parts.push(particle(d));
  }
  // Held: the ticket stopped on the edge before its next step — a pause marker there (reason on hover;
  // the row's info column shows it in full).
  if (t.held && idx > 0) {
    const x = (fcX(idx - 1) + fcX(idx)) / 2, why = t.blockedOn ?? 'blocked';
    parts.push(`<g class="fc-node fc-held" data-step="${esc(t.step)}"><title>Held: ${esc(why)}</title>
      <circle class="held-dot" cx="${x}" cy="${FC.y}" r="11"/>
      <text class="glyph" x="${x}" y="${FC.y}">⏸</text>
      <text class="held-label" x="${x}" y="${FC.y + 30}">HELD</text></g>`);
  }
  // Feedback loops, arcing above the line
  for (const l of LOOPS) {
    const a = fcX(flow.findIndex(f => f.id === l.from)), b = fcX(flow.findIndex(f => f.id === l.to));
    const top = FC.y - 20, c = FC.y - 20 - l.lift;
    const d = `M${a},${top} C${a},${c} ${b},${c} ${b},${top}`;
    const taken = l.taken(t) && !done;
    parts.push(`<path class="fc-loop ${taken ? 'taken' : ''}" d="${d}"/>`,
      `<text class="fc-loop-label ${taken ? 'taken' : ''}" x="${(a + b) / 2}" y="${FC.y - 20 - l.lift * 0.75 - 4}">↺ ${esc(l.label)}</text>`);
    if (taken && !t.stale) parts.push(particle(d));
  }
  // Nodes
  flow.forEach((f, i) => {
    const x = fcX(i);
    const past = i < idx || done, current = i === idx && !done && !t.held;
    const glyph = current ? (t.failed ? '✕' : f.you && !t.approved ? '!' : i + 1) : past ? '✓' : i + 1;
    const label = current && t.fixRound ? 'Fix round' : f.label;
    const rings = current && !t.stale ? ['r1', 'r2', 'r3'].map(r => shape(f, x, `ring ${r}`)).join('') : '';
    parts.push(`<g class="fc-node ${past ? 'past' : ''} ${current ? 'current' : ''}" data-step="${f.id}">
      ${rings}${shape(f, x, 'shape')}
      <text class="glyph" x="${x}" y="${FC.y}">${glyph}</text>
      <text class="label" x="${x}" y="${FC.y + 36}">${esc(label)}${f.you ? ' ◆' : ''}</text>
      ${current ? mutationTag(t.ticket, x) : ''}</g>`);
  });
  return `<svg class="flowchart" viewBox="0 0 1000 148" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

// Small tag under the current step while the PR's mutation-testing jobs run: pulses while
// pending, then settles red (any failed) or green (all done).
function mutationTag(ticket, x) {
  const m = state.checks?.[ticket]?.mutations;
  if (!m) return '';
  const cls = m.failed ? 'fail' : m.done < m.total ? 'pending' : 'pass';
  const text = m.failed ? `🧬 ${m.failed} failed` : `🧬 mutations ${m.done}/${m.total}${m.running ? ` · ${m.running} running` : ''}`;
  return `<text class="fc-mut ${cls}" x="${x}" y="${FC.y + 54}">${esc(text)}</text>`;
}

let flowsKey = '';
function renderFlows() {
  if (!state.runs) return;
  const { flow, runs } = state.runs;
  const showStale = $('#show-stale').checked;
  // Re-rendering restarts the CSS animations, so only redraw when something visible changed.
  const checksKey = Object.entries(state.checks ?? {}).map(([k, c]) => [k, c.mutations, ciState(c.url)]);
  const approvalsKey = (state.orch ?? []).map(o => [o.epic, o.approvals]);
  const key = JSON.stringify([runs, showStale, approvalsKey, state.linear?.issues?.length, state.github?.myPrs, checksKey, Math.floor(Date.now() / 60000)]);
  if (key === flowsKey) return;
  flowsKey = key;
  const issue = id => state.linear?.issues?.find(i => i.identifier === id);
  const visible = runs.filter(r => showStale || r.active || orchFor(r.epic));
  const orphans = (state.orch ?? []).filter(o => !runs.some(r => r.epic === o.epic));
  $('#flows').innerHTML = visible.map(r => {
    const merged = r.tickets.filter(t => t.step === 'done');
    const open = r.tickets.filter(t => t.step !== 'done' && (showStale || !t.stale));
    return `<div class="epic" data-epic="${esc(r.epic)}">
      <div class="epic-head">${esc(r.epic)}<small>${esc(r.label ?? '')}${r.workspace ? ` · herdr ${esc(r.workspace)}` : ''} · ${ago(r.updatedAt)}</small>
        ${merged.length ? `<span class="merged">merged ${merged.map(t => `<span class="chip" data-ticket="${esc(t.ticket)}">✓ ${esc(t.ticket)}</span>`).join('')}</span>` : ''}</div>
      <div class="orch" data-epic="${esc(r.epic)}"></div>
      ${open.map(t => {
        const f = flow.find(f => f.id === t.step);
        const approved = mergeApproved(t, r.epic);
        const ciWait = !approved && awaitingCi(t);
        const where = approved ? 'merge approved · orchestrator merging' : ciWait ? 'review · merge · awaiting CI' : t.held ? `held before ${(f?.label ?? t.step).toLowerCase()}` : t.fixRound ? 'fix round' : f?.label ?? t.step;
        const stepText = `${where}${t.since ? ` · ${ago(t.since).replace(' ago', '')}` : ''}`;
        const awaitsYou = f?.you && !t.held && !t.stale && !approved && !ciWait;
        return `<div class="tk ${awaitsYou ? 'you' : ''} ${t.held ? 'held' : ''} ${t.failed ? 'failed' : ''} ${t.stale ? 'stale' : ''}" data-ticket="${esc(t.ticket)}">
          <div class="tk-info">
            <div class="id">${esc(t.ticket)}</div>
            <div class="title">${esc(issue(t.ticket)?.title ?? '')}</div>
            <div class="step">${awaitsYou ? '<span class="await">◆ awaiting you</span> · ' : ''}${esc(stepText)}${t.stale ? ' · inactive' : ''}</div>
            ${t.held && t.blockedOn ? `<div class="blocked-on">⏸ ${esc(t.blockedOn)}</div>` : ''}
            <div class="tk-act" data-ticket="${esc(t.ticket)}"></div>
            ${t.pr ? `<div class="pr"><a href="${esc(t.pr)}" target="_blank" rel="noopener">PR #${esc(t.pr.split('/').pop())}</a>${(ci => ci ? ` <span class="chip c-${esc(ci.state)}" title="${esc(ci.failed.length ? `failed: ${ci.failed.join(', ')}` : '')}">CI ${esc(ci.state)}</span>` : '')(ciState(t.pr))}</div>` : ''}
          </div>${flowSvg(flow, approved || ciWait ? { ...t, approved: true } : t)}</div>`;
      }).join('')}
    </div>`;
  }).join('') + orphans.map(o => `<div class="epic" data-epic="${esc(o.epic)}">
      <div class="epic-head">${esc(o.epic)}<small>orchestrator running · no run folder yet</small></div>
      <div class="orch" data-epic="${esc(o.epic)}"></div></div>`).join('')
    || '<div class="placeholder">No active orchestration runs. Tick “show inactive” for history.</div>';

  $('#flows').querySelectorAll('.epic').forEach(ep => {
    const epic = ep.dataset.epic;
    ep.querySelectorAll('.merged .chip').forEach(c => c.onclick = () => ticketTile(epic, c.dataset.ticket, null));
    ep.querySelectorAll('.tk').forEach(row => {
      row.querySelector('.id').onclick = () => ticketTile(epic, row.dataset.ticket, null);
      row.querySelectorAll('.fc-node').forEach(n => n.onclick = () => ticketTile(epic, row.dataset.ticket, n.dataset.step));
    });
  });
  renderOrch(); renderWorkers();
}

/* ---------- Orchestrators: what the session driving each epic is doing ---------- */
const orchFor = epic => (state.orch ?? []).find(o => o.epic === epic);
const mins = ms => `${Math.max(0, Math.round(ms / 60000))}m`;
// Strip under each epic's header: status, latest intent, background work, jump to its pane.
function orchStrip(epic) {
  const o = orchFor(epic);
  if (!o) return state.orch ? '<div class="orch-none">no live orchestrator session for this epic</div>' : '';
  const working = !o.turnEnded && o.status !== 'done' && o.status !== 'idle';
  const needs = o.needsYou;
  const phase = needs ? `◆ awaiting you · ${ago(o.lastAt)}` : working ? 'working' : `turn ended · ${ago(o.lastAt)}`;
  const said = needs ? (needs.ask ?? dialogLine(attentionFor(o.sessionId)) ?? 'a question is open in its pane') : o.intent ?? '';
  // Each watcher names what it watches (the epic, one PR's CI…); full text on hover.
  const short = d => (d.length > 34 ? `${d.slice(0, 33)}…` : d);
  const tasks = o.tasks.map(k => taskChip({ ...k, desc: k.kind === 'watch' ? short(k.desc) : k.desc }, `orch-task ${k.kind}`)).join('');
  return `<div class="orch-strip ${needs ? 'needs' : working ? 'working' : 'idle'}" data-epic="${esc(epic)}" title="Open the orchestrator's activity">
    <span class="orch-dot"></span><span class="orch-who">ORCHESTRATOR <b>${esc(o.name)}</b></span><span class="orch-state">${esc(phase)}</span>
    <span class="orch-intent" title="${esc([said, ...(needs?.items ?? []).slice(needs?.why === 'action' ? 1 : 0).map(i => `(you) ${i}`)].join('\n'))}">${esc(said)}${(n => n > 0 ? ` <span class="orch-more">+${n} (you) item${n > 1 ? 's' : ''}</span>` : '')((needs?.items?.length ?? 0) - (needs?.why === 'action' ? 1 : 0))}</span>${tasks}
    <button class="jump-btn" data-session="${esc(o.sessionId)}" data-what="${esc(`${epic} orchestrator`)}" title="Focus the orchestrator">⏵</button></div>`;
}
function renderOrch() {
  document.querySelectorAll('#flows .orch').forEach(el => {
    const html = orchStrip(el.dataset.epic);
    if (html === el._html) return; // only touch the DOM on change, so the pulse isn't restarted
    el.innerHTML = el._html = html;
    bindJumps(el);
    el.querySelector('.orch-strip')?.addEventListener('click', () => orchTile(el.dataset.epic));
  });
}
/* ---------- Background tasks: progress from each task's output file ---------- */
// A task is "quiet" after 10 minutes with no new output (or none at all): dimmed, no pulse, so a
// stuck or buffering command stands out from one that's printing.
const QUIET_MS = 10 * 60_000;
// `narrow`: the flow lane's column. A result usually sits at the end of a line ("… 7 passed, 0 failed"),
// so there the line keeps its end and loses its start.
function taskChip(k, cls = 'wk-task', narrow = false) {
  const o = k.out, now = Date.now();
  const lastOut = o?.size ? o.at : null;
  const quiet = k.kind !== 'watch' && now - (lastOut ?? k.t) > QUIET_MS;
  const age = k.kind === 'watch' && k.until ? `${mins(k.until - now)} left` : mins(now - k.t);
  // Two parts: what it is, then its latest output. In a narrow lane each part is its own line.
  const progress = o == null ? '' : !o.size ? `<span class="tk-prog">no output yet${quiet ? ` · quiet ${mins(now - k.t)}` : ''}</span>`
    : `<span class="tk-prog">› <span class="tk-when">${quiet ? `quiet ${mins(now - o.at)}` : ago(o.at).replace(' ago', '')}</span> · <span class="tk-out">${esc((l => narrow && l.length > 26 ? `…${l.slice(-25)}` : l)(o.lines.at(-1) ?? ''))}</span></span>`;
  const icon = k.kind === 'watch' ? '◎' : '◉';
  return `<span class="${cls} task-chip ${k.kind} ${quiet ? 'quiet' : ''}" data-task="${esc(k.id)}" data-desc="${esc(k.desc)}"
    title="${esc(`${k.desc}\nstarted ${ago(k.t)}${o?.size ? `\nlast output ${ago(o.at)}: ${o.lines.at(-1) ?? ''}` : ''}\nClick for live output`)}"><span class="tk-desc">${icon} ${esc(k.desc)} · ${age}</span>${progress}</span>`;
}
// Tile: the task's last 60 output lines, kept live by pollTaskTiles().
function taskTile(id, desc) {
  tile(`task:${id}`, desc, 'background task output', `<pre class="tile-task" data-task="${esc(id)}"><span class="placeholder">loading…</span></pre>`);
  pollTaskTiles();
}
async function pollTaskTiles() {
  for (const el of document.querySelectorAll('.tile-task')) {
    const r = await api(`/api/task-output?id=${encodeURIComponent(el.dataset.task)}`);
    const html = !r ? '<span class="placeholder">The task has finished or is no longer listed.</span>'
      : !r.size ? '<span class="placeholder">No output yet.</span>'
      : `${esc(r.lines.join('\n'))}\n<span class="placeholder">· last output ${ago(r.at)}</span>`;
    if (html !== el._html) { el.innerHTML = el._html = html; const box = el.closest(".tile-body") ?? el; box.scrollTop = box.scrollHeight; }
  }
}
// Capture phase: a chip inside the orchestrator strip opens its own tile, not the strip's.
document.addEventListener('click', e => {
  const c = e.target.closest?.('.task-chip[data-task]');
  if (!c) return;
  e.stopPropagation();
  taskTile(c.dataset.task, c.dataset.desc);
}, true);

// Activity feed: narration, tool calls (✓/✕, never their output), your prompts, background notices.
const ORCH_ICON = { say: '›', tool: '⚙', note: '◆', you: 'you' };
const hhmm = t => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const feedHtml = events => `<div class="feed">${events.slice().reverse().map(e => `<div class="fe ${e.kind} ${e.ok === false ? 'bad' : ''}">
    <span class="fe-t">${hhmm(e.t)}</span><span class="fe-i">${ORCH_ICON[e.kind]}${e.ok === true ? ' ✓' : e.ok === false ? ' ✕' : ''}</span>
    <span class="fe-x">${esc(e.text)}</span></div>`).join('')}</div>`;
function orchFeed(epic) {
  const o = orchFor(epic);
  if (!o) return '<p class="placeholder">No live orchestrator session.</p>';
  const n = o.needsYou;
  const wants = n ? `<div class="orch-wants"><div class="ck-title">Waiting on you</div>
    ${n.ask && n.why !== 'action' ? `<div class="wk-needs">◆ ${esc(n.ask)}</div>` : ''}
    ${n.items.map(i => `<div class="wk-needs">◆ (you) ${esc(i)}</div>`).join('')}
    ${n.why === 'dialog' && !n.ask ? '<div class="wk-needs">◆ a question is open in its pane</div>' : ''}</div>` : '';
  return wants + feedHtml(o.events);
}

// The ticket's step already flags it as yours (plan gate, review/merge you haven't handed off).
function atGate(ticket) {
  const t = findTicket(ticket);
  return Boolean(t && !t.held && !mergeApproved(t) && (t.step === 'plan-gate' || t.step === 'human-review'));
}

/* ---------- Workers: what each in-flight ticket's pane (and its subagents) is doing ---------- */
// One line under the ticket's step. A subagent doing the work is named, with what it's running,
// so "implementing" isn't all you see while a mutation run grinds in the background.
function workerLine(ticket) {
  const w = state.workers?.[ticket];
  if (!w) return '';
  if (w.needsYou && !atGate(ticket))
    return `<span class="wk-needs">◆ awaiting you</span> <span class="wk-say">${esc(w.needsYou.ask ?? dialogLine(attentionFor(w.sessionId)) ?? 'a question is open in its pane')}</span>`;
  const task = k => taskChip(k, 'wk-task', true);
  const subs = w.subagents.map(s => `<span class="wk-sub">▸ subagent “${esc(s.desc)}” · ${mins(Date.now() - s.since)}</span>`
    + (s.tasks.length ? ` → ${s.tasks.map(task).join(' ')}` : s.intent ? ` <span class="wk-say">${esc(s.intent)}</span>` : '')).join('<br>');
  if (subs) return subs;
  if (w.tasks.length) return w.tasks.map(task).join(' ');
  const last = w.events.at(-1);
  return last ? `<span class="wk-say">${esc(last.text)}</span>` : '';
}
function renderWorkers() {
  document.querySelectorAll('#flows .tk-act').forEach(el => {
    const html = workerLine(el.dataset.ticket);
    if (html !== el._html) el.innerHTML = el._html = html;
  });
}
// Tile section: the worker pane's feed, then each running subagent's recent steps.
function workerSection(ticket) {
  const w = state.workers?.[ticket];
  if (!w) return '';
  return `<div class="ck-title">Worker activity <small>${esc(w.role)} pane ${esc(w.pane)} · ${esc(w.status)}</small></div>`
    + w.subagents.map(s => `<div class="ck-head">Subagent “${esc(s.desc)}” · running ${mins(Date.now() - s.since)}${s.waiting ? ' · waiting on its background work' : ''}</div>`
      + (s.tasks.length ? `<div class="wk-tasks">${s.tasks.map(k => taskChip(k)).join(' ')}</div>` : '')
      + feedHtml(s.events)).join('')
    + (w.tasks.length ? `<div class="ck-head">Background tasks</div><div class="wk-tasks">${w.tasks.map(k => taskChip(k)).join(' ')}</div>` : '')
    + `<div class="ck-head">Worker pane</div>${feedHtml(w.events.slice(-12))}`;
}
function orchTile(epic) {
  const o = orchFor(epic);
  const el = tile(`orch:${epic}`, `${epic} orchestrator`, o?.name ?? '', `<div class="tile-orch" data-epic="${esc(epic)}">${orchFeed(epic)}</div>`
    + (o ? `<div class="artifacts"><button class="jump-btn" data-session="${esc(o.sessionId)}" data-what="${esc(`${epic} orchestrator`)}">⏵ focus orchestrator</button></div>` : ''));
  bindJumps(el);
}

const STEP_FILES = {
  planning: ['plan', 'PLAN.md'], 'plan-gate': ['plan', 'PLAN.md'], implementing: ['KICKOFF.md', 'REDIRECT.md', 'REPORT.md'],
  'self-review': ['REVIEW_KICKOFF.md', 'REVIEW_REPORT.md'], 'human-review': ['REVIEW_REPORT.md'], done: ['REPORT.md'],
};
// CI checks from GitHub for the ticket's PR: mutation jobs first, then the rest; failures lead each group.
// Icons: ✓ pass · ✕ fail · ⊘ cancelled · – skipped · hollow ring queued · ring with a pulsing heartbeat running.
const HEARTBEAT = '<svg class="ck-beat" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><polyline points="3,8.5 5.5,8.5 7,5 9,11 10.5,8.5 13,8.5"/></svg>';
function checkIcon(k) {
  // Running vs queued comes from GitHub's state: queued jobs have a start time too.
  if (k.bucket === 'pending') return k.running
    ? `<span class="ck-ico running" title="running">${HEARTBEAT}</span>`
    : '<span class="ck-ico queued" title="queued — waiting for a runner">◯</span>';
  const [glyph, cls] = { pass: ['✓', 'pass'], fail: ['✕', 'fail'], cancel: ['⊘', 'fail'], skipping: ['–', 'skip'] }[k.bucket] ?? ['?', 'skip'];
  return `<span class="ck-ico ${cls}" title="${esc(k.bucket)}">${glyph}</span>`;
}
function checksSection(id) {
  const c = state.checks?.[id];
  if (!c) return '';
  const dur = k => {
    if (k.bucket === 'pending' && !k.running) return 'queued';
    if (!k.startedAt) return '';
    const s = ((k.completedAt ? Date.parse(k.completedAt) : Date.now()) - Date.parse(k.startedAt)) / 1000;
    return `${s >= 60 ? `${(s / 60) | 0}m` : ''}${(s % 60) | 0}s`;
  };
  const group = (title, list) => !list.length ? '' : `<div class="ck-group"><div class="ck-head">${esc(title)}</div>${list.map(k =>
    `<a class="ck ${k.bucket === 'pending' && !k.running ? 'is-queued' : ''}" href="${esc(k.link)}" target="_blank" rel="noopener">${checkIcon(k)}`
    + `<span class="ck-name">${esc(k.name.replace(/^mutations\s*·\s*/i, ''))}</span><span class="ck-dur">${dur(k)}</span></a>`).join('')}</div>`;
  const m = c.mutations;
  return `<div class="checks"><div class="ck-title">CI checks <small>GitHub · ${ago(c.at)}</small></div>`
    + group(m ? `Mutations · ${m.done}/${m.total} done${m.running ? ` · ${m.running} running` : ''}${m.total - m.done - m.running > 0 ? ` · ${m.total - m.done - m.running} queued` : ''}${m.failed ? ` · ${m.failed} failed` : ''}` : '', c.checks.filter(k => k.mutation))
    + group('Other', c.checks.filter(k => !k.mutation)) + '</div>';
}

// Live panes jump to the pane; closed ones fall back to the run's herdr workspace.
function panesHtml(t) {
  const lbl = esc(t.wsLabel ?? '');
  return t.panes.map(p => livePane(p.pane, t.wsLabel)
    ? `<button class="jump-btn" data-pane="${esc(p.pane)}" data-label="${lbl}" data-what="${esc(`${t.ticket} · ${p.role}`)}">⏵ ${esc(p.role)} ${esc(p.pane)}</button>`
    : t.wsId
      ? `<button class="jump-btn gone" data-ws="${esc(t.wsId)}" data-label="${lbl}" data-what="${esc(t.wsLabel || t.wsId)}" title="pane closed — opens the run's workspace">⏵ ${esc(p.role)} ${esc(p.pane)} · gone → ${esc(t.wsLabel || t.wsId)}</button>`
      : `<span class="pane-gone">${esc(p.role)} ${esc(p.pane)} (gone)</span>`).join(' ') || '—';
}
// Open ticket tiles track live state: panes on every poll, CI checks whenever they refresh.
function refreshTiles() {
  document.querySelectorAll('.tile-panes').forEach(el => {
    const t = findTicket(el.dataset.ticket), html = t && panesHtml(t);
    if (html && html !== el._html) { el.innerHTML = el._html = html; bindJumps(el); }
  });
  document.querySelectorAll('.tile-checks').forEach(el => {
    const html = checksSection(el.dataset.ticket);
    if (html !== el._html) el.innerHTML = el._html = html;
  });
  document.querySelectorAll('.tile-gate').forEach(el => {
    const html = gateSection(el.dataset.ticket);
    if (html !== el._html) { el.innerHTML = el._html = html; bindJumps(el); }
  });
  document.querySelectorAll('.tile-work').forEach(el => {
    const html = workerSection(el.dataset.ticket);
    if (html !== el._html) el.innerHTML = el._html = html;
  });
  document.querySelectorAll('.tile-orch').forEach(el => {
    const html = orchFeed(el.dataset.epic);
    if (html !== el._html) el.innerHTML = el._html = html;
  });
}

// Plan gate, read-only: the question the worker's pane is showing, read off its screen, shown beside
// the plan it asks about. Answering still happens in the pane; the button jumps there.
function gateSection(id) {
  const t = findTicket(id);
  if (!t || t.step !== 'plan-gate' || t.held || t.stale) return '';
  const w = state.workers?.[id], a = w && attentionFor(w.sessionId);
  const jump = w?.sessionId ? `<button class="jump-btn" data-session="${esc(w.sessionId)}" data-what="${esc(`${id} worker`)}">⏵ answer in its pane</button>` : '';
  if (!a?.options?.length) return `<div class="gate"><div class="gate-title">◆ Plan gate</div>
    <p class="placeholder">The plan is ready for your approval. Its question can't be read here: it isn't open in a herdr pane yet, or the worker runs outside herdr.</p>
    <div class="gate-foot">${jump}</div></div>`;
  return `<div class="gate"><div class="gate-title">◆ ${esc(a.title ?? 'Plan gate')}</div>
    <p class="gate-q">${esc(a.question ?? '')}</p>
    <ol class="gate-opts">${a.options.map((o, n) => `<li class="${/\(Recommended\)/i.test(o) ? 'rec' : ''}"><b>${esc(o)}</b>${a.notes?.[n] ? `<span>${esc(a.notes[n])}</span>` : ''}</li>`).join('')}</ol>
    <div class="gate-foot">${jump}<span class="res-dim">Read-only. Answer in the worker's pane.</span></div></div>`;
}
function ticketTile(epic, id, step) {
  const t = findTicket(id);
  if (!t) return;
  const names = step ? STEP_FILES[step] ?? [] : ['plan', ...t.files];
  const avail = names.filter(n => n === 'plan' || t.files.includes(n));
  const prLink = t.pr ? `<a href="${esc(t.pr)}" target="_blank" rel="noopener">${esc(t.pr)}</a>` : '—';
  const atPlanGate = t.step === 'plan-gate' && (!step || step === 'plan-gate');
  const el = tile(`ticket:${id}:${step}`, `${id}${step ? ` · ${step}` : ''}`, epic,
    (atPlanGate ? `<div class="tile-gate" data-ticket="${esc(id)}">${gateSection(id)}</div>` : '') + dl({
    'current step': `${stepChip(t)}${t.held ? ` before ${esc(t.step)} · ${esc(t.blockedOn ?? 'blocked')}` : ''}${t.failed ? ' <span class="chip" style="color:var(--red)">failed</span>' : ''}${t.stale ? ' (inactive)' : ''}`,
    'STAGE file': esc(t.stage ?? '—'), 'REVIEW_STAGE': esc(t.reviewStage ?? '—'), PR: `${prLink} ${esc(t.prState ?? '')}`,
    panes: `<span class="tile-panes" data-ticket="${esc(id)}">${panesHtml(t)}</span>`,
  }) + `<div class="tile-work checks" data-ticket="${esc(id)}">${workerSection(id)}</div>`
    + `<div class="tile-checks" data-ticket="${esc(id)}">${checksSection(id)}</div>`
    + `<div class="artifacts">${avail.map(n => `<button data-n="${esc(n)}">${n === 'plan' ? 'PLANS/' + esc(id) + '-plan.md' : esc(n)}</button>`).join('') || '<span class="placeholder">No artifacts for this step yet.</span>'}</div>`);
  bindJumps(el.querySelector('.tile-panes'));
  if (atPlanGate && !el.querySelector('.gate-plan')) { // a re-opened tile already has its plan
    bindJumps(el.querySelector('.tile-gate'));
    // The plan itself, inline under the question it's about.
    const key = el.dataset.key, plan = document.createElement('div');
    plan.className = 'gate-plan';
    plan.innerHTML = '<p class="placeholder">loading the plan…</p>';
    el.querySelector('.tile-body').append(plan);
    api(`/api/run-file?epic=${encodeURIComponent(epic)}&ticket=${encodeURIComponent(id)}&name=plan`)
      .then(text => { if (el.dataset.key === key) plan.innerHTML = `<div class="gate-plan-h">Plan</div>${mdHtml(text)}`; });
  }
  el.querySelectorAll('.artifacts button').forEach(b => b.onclick = () =>
    fileTile(`rf:${epic}:${id}:${b.dataset.n}`, `${id} · ${b.textContent}`, epic,
      `/api/run-file?epic=${encodeURIComponent(epic)}&ticket=${encodeURIComponent(id)}&name=${encodeURIComponent(b.dataset.n)}`));
}
$('#show-stale').onchange = renderFlows;

/* ---------- Right-column tabs ---------- */
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab-body').forEach(x => { x.hidden = x.id !== b.dataset.tab; });
});
const offline = r => `<div class="placeholder">${esc(r?.reason ?? 'loading…')}</div>`;
const linkOut = url => `<p><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>`;
const mdTile = (key, title, sub, meta, body) => tile(key, title, sub, meta + (body ? marked.parse(body) : '<p class="placeholder">No description.</p>'));

/* ---------- Linear ---------- */
const PRI = { 1: '⚠', 2: '▲', 3: '■', 4: '▽', 0: '·' };
function renderLinear() {
  const l = state.linear;
  if (!l?.online) { $('#linear-count').textContent = ''; $('#linear').innerHTML = offline(l); return; }
  $('#linear-count').textContent = l.issues.length;
  let lastState = null;
  $('#linear').innerHTML = l.issues.map((i, n) => {
    const head = i.state.name !== lastState ? `<div class="group-h">${esc(lastState = i.state.name)}</div>` : '';
    const run = findTicket(i.identifier);
    return `${head}<div class="card p${i.priority}" data-i="${n}">
      <div class="t"><span><span class="pri" title="${esc(i.priorityLabel)}">${PRI[i.priority] ?? '·'}</span>${esc(i.identifier)}</span>${run && run.step !== 'done' ? stepChip(run) : ''}</div>
      <div class="s" style="white-space:normal">${esc(i.title)}</div>
      <div class="s">${esc(i.project?.name ?? i.team.key)} · ${ago(Date.parse(i.updatedAt))}</div>
    </div>`;
  }).join('') || '<div class="placeholder">Nothing assigned.</div>';
  $('#linear').querySelectorAll('.card').forEach(c => c.onclick = () => {
    const i = l.issues[c.dataset.i];
    mdTile(`linear:${i.identifier}`, `${i.identifier} · ${i.title}`, 'linear', dl({
      state: esc(i.state.name), priority: esc(i.priorityLabel), project: esc(i.project?.name ?? '—'), updated: ago(Date.parse(i.updatedAt)),
    }) + linkOut(i.url), i.description);
  });
}

/* ---------- GitHub ---------- */
function renderGithub() {
  const g = state.github;
  if (!g?.online) { $('#github-count').textContent = ''; $('#github').innerHTML = offline(g); return; }
  $('#github-count').textContent = g.myPrs.length + g.reviewRequests.length + g.issues.length;
  const all = [];
  const card = (item, kind) => {
    const n = all.push({ item, kind }) - 1;
    const chips = kind === 'mine' ? [
      item.isDraft ? '<span class="chip c-draft">draft</span>' : '',
      `<span class="chip c-${item.checks}">CI ${item.checks}</span>`,
      item.reviewDecision ? `<span class="chip c-${esc(item.reviewDecision)}">${esc(item.reviewDecision.toLowerCase().replace('_', ' '))}</span>` : '',
    ].join('') : '';
    const cls = kind === 'mine' ? { failing: 'blocked', pending: 'busy', passing: 'idle' }[item.checks] ?? '' : kind === 'review' ? 'blocked' : '';
    return `<div class="card ${cls}" data-n="${n}">
      <div class="t"><span>${esc(item.repository.name)}#${item.number}</span><span class="s">${ago(Date.parse(item.updatedAt))}</span></div>
      <div class="s" style="white-space:normal">${esc(item.title)}</div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}</div>`;
  };
  const section = (title, items, kind) => items.length ? `<div class="group-h">${title} (${items.length})</div>${items.map(i => card(i, kind)).join('')}` : '';
  $('#github').innerHTML = section('Review requested', g.reviewRequests, 'review') + section('My pull requests', g.myPrs, 'mine')
    + section('Assigned issues', g.issues, 'issue') || '<div class="placeholder">Nothing open.</div>';
  $('#github').querySelectorAll('.card').forEach(c => c.onclick = () => {
    const { item, kind } = all[c.dataset.n];
    mdTile(`gh:${item.url}`, `${item.repository.name}#${item.number}`, kind === 'issue' ? 'issue' : 'pull request', dl({
      title: esc(item.title), ...(kind === 'mine' ? { CI: esc(item.checks), review: esc(item.reviewDecision ?? '—'), branch: esc(item.branch ?? '—') } : {}),
      updated: ago(Date.parse(item.updatedAt)),
    }) + linkOut(item.url), item.body);
  });
}

/* ---------- Waiting on you: one list, shown in the header count and the tab title, and notified ---------- */
// Everything that needs your input: plan/review gates you haven't handed off, orchestrators and
// workers asking you something or listing "(you)" items, and GitHub review requests.
function alerts() {
  const out = [];
  for (const r of state.runs?.runs ?? []) for (const t of r.tickets) {
    if (t.stale || t.held || mergeApproved(t, r.epic) || awaitingCi(t) || !['plan-gate', 'human-review'].includes(t.step)) continue;
    out.push({ key: `gate:${t.ticket}:${t.step}`, text: `${t.ticket}: ${t.step === 'plan-gate' ? 'plan ready for your approval' : 'PR ready for your review/merge'}` });
  }
  const ask = (n, id) => n.ask ?? dialogLine(attentionFor(id)) ?? 'a question is open in its pane';
  for (const o of state.orch ?? []) if (o.needsYou)
    out.push({ key: `orch:${o.epic}:${ask(o.needsYou, o.sessionId)}`, text: `${o.epic} orchestrator: ${ask(o.needsYou, o.sessionId)}` });
  for (const [k, w] of Object.entries(state.workers ?? {})) if (w.needsYou && !atGate(k))
    out.push({ key: `work:${k}:${ask(w.needsYou, w.sessionId)}`, text: `${k}: ${ask(w.needsYou, w.sessionId)}` });
  const covered = new Set([...(state.orch ?? []).map(o => o.sessionId), ...Object.values(state.workers ?? {}).map(w => w.sessionId)]);
  for (const a of state.attention ?? []) if (!covered.has(a.sessionId))
    out.push({ key: `ask:${a.sessionId}:${a.question ?? a.items?.[0] ?? 'open'}`,
      text: `${a.name}: ${dialogLine(a) ?? a.items?.[0] ?? 'a question is open in its pane'}${a.items?.length > 1 ? ` (+${a.items.length - 1} more)` : ''}` });
  for (const p of state.github?.reviewRequests ?? [])
    out.push({ key: `review:${p.url}`, text: `Review requested: ${p.repository?.name ?? ''}#${p.number} ${p.title}` });
  return out;
}

// Desktop notifications are opt-in (＋ Panels). Each alert notifies once; the first poll only
// records what's already there, so opening the dashboard doesn't replay old items.
let notifyOn = (() => { try { return localStorage.getItem('mc.notify') === 'on'; } catch { return false; } })();
let alertSeen = null;
async function setNotify(on) {
  if (on && 'Notification' in window && Notification.permission !== 'granted') on = (await Notification.requestPermission()) === 'granted';
  notifyOn = on;
  try { localStorage.setItem('mc.notify', on ? 'on' : 'off'); } catch { /* not remembered */ }
}
function notifyAlerts(list) {
  document.title = list.length ? `(${list.length}) Mission Control` : 'Mission Control';
  setFaviconWaiting(list.length);
  // Wait until every source has loaded once, or half the list would look "new" on the next poll.
  if (!state.runs || !state.orch || !state.workers || !state.attention) return;
  const keys = new Set(list.map(a => a.key));
  if (alertSeen && notifyOn && 'Notification' in window && Notification.permission === 'granted') {
    for (const a of list) if (!alertSeen.has(a.key)) {
      const n = new Notification('Mission Control — needs you', { body: a.text, tag: a.key });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }
  alertSeen = keys;
}

/* ---------- Window icon: the radar, drawn live ---------- */
// Calm: a still radar with a cyan blip, drawn once. Something waiting on you: the blip turns magenta
// and sends out a sonar ping, ~12 frames a second, only while there's something waiting. The sweep
// never rotates — activity pulses, it doesn't spin. Mirrors scripts/make-icon.py.
const favCanvas = document.createElement('canvas');
favCanvas.width = favCanvas.height = 64;
let favWaiting = 0, favTimer = null, favLast = '';
function drawFavicon(t) {
  const c = favCanvas.getContext('2d'), S = 64, C = S / 2, R = 25, edge = -50 * Math.PI / 180, span = 95 * Math.PI / 180;
  c.clearRect(0, 0, S, S);
  const plate = c.createLinearGradient(0, 0, 0, S);
  plate.addColorStop(0, '#0a1628'); plate.addColorStop(1, '#050a14');
  c.fillStyle = plate; c.beginPath(); c.roundRect(1, 1, S - 2, S - 2, 13); c.fill();
  c.fillStyle = '#040e1a'; c.beginPath(); c.arc(C, C, R, 0, 2 * Math.PI); c.fill();
  for (let i = 0; i < 24; i++) {                       // fading sweep wedge behind the edge
    const a0 = edge - span * (i + 1) / 24, a1 = edge - span * i / 24;
    c.fillStyle = `rgba(62,240,255,${0.78 * (1 - i / 24)})`;
    c.beginPath(); c.moveTo(C, C); c.arc(C, C, R, a0, a1); c.closePath(); c.fill();
  }
  c.strokeStyle = 'rgba(62,240,255,.95)'; c.lineWidth = 2;  // leading edge
  c.beginPath(); c.moveTo(C, C); c.lineTo(C + R * Math.cos(edge), C + R * Math.sin(edge)); c.stroke();
  c.shadowColor = '#3ef0ff'; c.shadowBlur = 6; c.lineWidth = 3;
  c.beginPath(); c.arc(C, C, R, 0, 2 * Math.PI); c.stroke(); c.shadowBlur = 0;  // outer ring
  const bx = C + 0.30 * C, by = C - 0.36 * C, color = favWaiting ? '#ff4fd8' : '#3ef0ff';
  if (favWaiting) {                                    // sonar ping from the blip
    const p = (t % 1200) / 1200;
    c.strokeStyle = `rgba(255,79,216,${1 - p})`; c.lineWidth = 2;
    c.beginPath(); c.arc(bx, by, 4 + p * 14, 0, 2 * Math.PI); c.stroke();
  }
  c.fillStyle = color; c.shadowColor = color; c.shadowBlur = 8;
  c.beginPath(); c.arc(bx, by, favWaiting ? 6 : 4.5, 0, 2 * Math.PI); c.fill(); c.shadowBlur = 0;
  const url = favCanvas.toDataURL('image/png');
  if (url !== favLast) { $('#favicon').href = favLast = url; }
}
function setFaviconWaiting(n) {
  if (n === favWaiting && (favTimer || !n)) return;
  favWaiting = n;
  clearInterval(favTimer); favTimer = null;
  if (n) favTimer = setInterval(() => drawFavicon(performance.now()), 85);
  else drawFavicon(0);
}
drawFavicon(0);

/* ---------- Header stats ---------- */
function renderStats() {
  const live = state.sessions.filter(s => s.alive);
  const waiting = alerts();
  notifyAlerts(waiting);
  const failing = (state.github?.myPrs ?? []).filter(p => ciState(p.url)?.state === 'failing').length;
  const stats = [
    [live.filter(s => s.status === 'busy').length, 'working', false],
    [live.length, 'sessions', false],
    [waiting.length, 'waiting on you', waiting.length > 0],
    [(state.runs?.runs ?? []).filter(r => r.active).length, 'active epics', false],
    [(state.linear?.issues ?? []).filter(i => i.state.type === 'started').length, 'in progress', false],
    [state.github?.myPrs?.length ?? 0, 'open PRs', false],
    ...(failing ? [[failing, 'CI failing', true]] : []),
  ];
  $('#stats').innerHTML = stats.map(([n, l, hot]) => `<span class="stat ${hot ? 'hot' : ''}" ${l === 'waiting on you' && waiting.length ? `title="${esc(waiting.map(a => a.text).join('\n'))}"` : ''}><b>${n}</b>${l}</span>`).join('');
}
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 1000);

/* ---------- Knowledge graph ---------- */
const GROUP_COLORS = { vault: '#3ef0ff', memory: '#ff4fd8', 'claude-md': '#ffb547' };
const GROUP_NAMES = { vault: 'Obsidian vault', memory: 'Claude memory', 'claude-md': 'CLAUDE.md' };
$('#legend').innerHTML = Object.entries(GROUP_COLORS).map(([g, c]) => `<span><i style="background:${c};box-shadow:0 0 6px ${c}"></i>${GROUP_NAMES[g]}</span>`).join('');

let graph, graphData, highlight = new Set(), view = 'map', stale = new Set();
try { view = ['map', 'outline', 'links'].includes(localStorage.getItem('mc.kview')) ? localStorage.getItem('mc.kview') : 'map'; } catch { /* default */ }
async function loadGraph(refresh) {
  graphData = await api(`/api/graph${refresh ? '?refresh=1' : ''}`);
  if (!graph) {
    const el = $('#graph');
    graph = new ForceGraph3D(el)
      .backgroundColor('rgba(0,0,0,0)')
      .showNavInfo(false)
      .nodeLabel(n => `<span style="font:12px JetBrains Mono;color:#cfe7ff">${esc(n.name)}</span>`)
      .nodeColor(n => highlight.size && !highlight.has(n.id) ? 'rgba(80,100,130,0.25)' : GROUP_COLORS[n.group])
      .nodeVal(n => n.kind === 'hub' ? 8 : 1 + Math.min(4, (n.size ?? 0) / 4000))
      .nodeOpacity(0.92)
      .nodeResolution(12)
      .linkColor(l => l.kind === 'ref' ? 'rgba(255,79,216,0.55)' : 'rgba(62,240,255,0.18)')
      .linkWidth(l => l.kind === 'ref' ? 0.6 : 0)
      .linkDirectionalParticles(l => l.kind === 'ref' ? 2 : 0)
      .linkDirectionalParticleWidth(1.4)
      .linkDirectionalParticleColor(() => '#ff4fd8')
      .onNodeClick(focusNode);
    function focusNode(n) {
        const d = 90, r = 1 + d / Math.hypot(n.x, n.y, n.z || 1);
        graph.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 900);
        if (n.kind === 'file') openFile(n);
    }
    graph.focusNode = focusNode;
    new ResizeObserver(() => graph.width(el.clientWidth).height(el.clientHeight)).observe(el);
    // Slow idle orbit until the user grabs the camera.
    let angle = 0, dist = null;
    el.addEventListener('pointerdown', () => { orbiting = false; });
    setInterval(() => {
      if (!orbiting || view !== 'map' || !isOpen('knowledge')) return;
      const c = graph.cameraPosition();
      dist ??= Math.hypot(c.x, c.z) || 300;
      angle += 0.0025;
      graph.cameraPosition({ x: dist * Math.sin(angle), y: c.y, z: dist * Math.cos(angle) });
    }, 30);
  }
  graph.graphData(graphData);
  if (links2d) links2d.graphData(linksData());
  // A paused view's layout cools down on wall-clock time, so reheat it when it is next shown.
  stale = new Set(['map', 'links']);
  setView(view);
}
$('#refresh-graph').onclick = () => loadGraph(true);
$('#search').oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  highlight = new Set(q ? graphData.nodes.filter(n => n.name.toLowerCase().includes(q)).map(n => n.id) : []);
  graph.nodeColor(graph.nodeColor());
  if (view === 'outline') renderOutline();
  if (links2d) links2d.nodeCanvasObject(links2d.nodeCanvasObject());
};
// Enter opens the first matching file.
$('#search').onkeydown = e => {
  if (e.key !== 'Enter') return;
  const n = graphData.nodes.find(n => n.kind === 'file' && highlight.has(n.id));
  if (n) view === 'map' ? graph.focusNode(n) : openFile(n);
};

/* ---------- Knowledge views: Map (3D) · Outline (tree) · Links (2D cross-references) ---------- */
// 3d-force-graph swaps link ends for node objects in place, so always read ids through this.
const idOf = x => typeof x === 'object' ? x.id : x;
const refLinks = () => graphData.links.filter(l => l.kind === 'ref');

function setView(v) {
  view = v;
  try { localStorage.setItem('mc.kview', v); } catch { /* storage blocked — view just isn't remembered */ }
  document.querySelectorAll('#kviews button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('#graph').hidden = v !== 'map'; $('#outline').hidden = v !== 'outline'; $('#links').hidden = v !== 'links';
  const on = isOpen('knowledge');
  v === 'map' && on ? graph?.resumeAnimation() : graph?.pauseAnimation();
  if (v === 'outline') renderOutline();
  if (v === 'links') initLinks();
  v === 'links' && on ? links2d?.resumeAnimation() : links2d?.pauseAnimation();
  const g = { map: graph, links: links2d }[v];
  if (g && stale.delete(v)) g.d3ReheatSimulation();
}
document.querySelectorAll('#kviews button').forEach(b => b.onclick = () => graphData && setView(b.dataset.v));

function renderOutline() {
  const byId = new Map(graphData.nodes.map(n => [n.id, n]));
  const kids = new Map(), hasParent = new Set(), deg = new Map();
  const d = id => deg.get(id) ?? deg.set(id, { in: 0, out: 0 }).get(id);
  for (const l of graphData.links) {
    const a = idOf(l.source), b = idOf(l.target);
    if (l.kind === 'tree') { (kids.get(a) ?? kids.set(a, []).get(a)).push(b); hasParent.add(b); }
    else { d(a).out++; d(b).in++; }
  }
  const searching = highlight.size > 0;
  const files = id => { const n = byId.get(id); return n.kind === 'file' ? [id] : (kids.get(id) ?? []).flatMap(files); };
  const sorted = id => (kids.get(id) ?? []).map(k => byId.get(k))
    .sort((x, y) => (x.kind === 'hub' ? 0 : 1) - (y.kind === 'hub' ? 0 : 1) || x.name.localeCompare(y.name));
  const row = (n, root) => {
    if (n.kind === 'file') {
      if (searching && !highlight.has(n.id)) return '';
      const dg = deg.get(n.id);
      return `<div class="f ${highlight.has(n.id) ? 'hit' : ''}" data-id="${esc(n.id)}" title="${esc(n.name)}"><span class="nm">${esc(n.name)}</span>`
        + (dg?.in || dg?.out ? `<span class="lk">${dg.in ? `<b>←${dg.in}</b> ` : ''}${dg.out ? `→${dg.out}` : ''}</span>` : '') + '</div>';
    }
    const all = files(n.id), shown = searching ? all.filter(f => highlight.has(f)) : all;
    if (!shown.length) return '';
    return `<details class="${root ? 'src' : ''}" ${root || searching ? 'open' : ''} style="--gc:${GROUP_COLORS[n.group]}">`
      + `<summary>${esc(n.name)}<span class="n">${searching ? `${shown.length}/` : ''}${all.length}</span></summary>`
      + sorted(n.id).map(c => row(c)).join('') + '</details>';
  };
  const roots = graphData.nodes.filter(n => n.kind === 'hub' && !hasParent.has(n.id));
  $('#outline').innerHTML = roots.map(r => row(r, true)).join('') || '<div class="placeholder">No matches.</div>';
  $('#outline').querySelectorAll('.f').forEach(f => f.onclick = () => openFile(byId.get(f.dataset.id)));
}

// Links view: only files that reference each other, on a flat canvas. The best-connected files are
// always labelled; the rest show on hover, on a search match, or once zoomed in.
let links2d, labelDeg = Infinity;
function linksData() {
  const refs = refLinks().map(l => ({ source: idOf(l.source), target: idOf(l.target) }));
  const deg = new Map();
  refs.forEach(l => { deg.set(l.source, (deg.get(l.source) ?? 0) + 1); deg.set(l.target, (deg.get(l.target) ?? 0) + 1); });
  labelDeg = [...deg.values()].sort((a, b) => b - a)[11] ?? 0;
  return { nodes: graphData.nodes.filter(n => deg.has(n.id)).map(n => ({ ...n, deg: deg.get(n.id) })), links: refs };
}
function initLinks() {
  if (links2d) return;
  const el = $('#links');
  const radius = n => 2.5 + Math.sqrt(n.deg) * 1.6;
  let fitted = false, hovered = null;
  links2d = new ForceGraph(el)
    .width(el.clientWidth).height(el.clientHeight)
    .cooldownTicks(200)
    .onNodeHover(n => { hovered = n; el.style.cursor = n ? 'pointer' : ''; })
    .backgroundColor('rgba(0,0,0,0)')
    .graphData(linksData())
    .nodeCanvasObject((n, ctx, scale) => {
      const dim = highlight.size && !highlight.has(n.id), c = GROUP_COLORS[n.group], r = radius(n);
      ctx.globalAlpha = dim ? 0.15 : 1;
      ctx.shadowColor = c; ctx.shadowBlur = highlight.has(n.id) ? 14 : 6;
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fill();
      ctx.shadowBlur = 0;
      // Labels for hubs-of-links, matches and the hovered node; everything once zoomed in.
      if (!(scale >= 2.5 || n.deg >= labelDeg || highlight.has(n.id) || n === hovered)) { ctx.globalAlpha = 1; return; }
      ctx.font = `${11 / scale}px JetBrains Mono, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = highlight.has(n.id) ? '#ffffff' : '#cfe7ff';
      ctx.fillText(n.name, n.x, n.y + r + 2 / scale);
      ctx.globalAlpha = 1;
    })
    .nodePointerAreaPaint((n, color, ctx) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x, n.y, radius(n) + 3, 0, 2 * Math.PI); ctx.fill(); })
    .nodeLabel(n => `${esc(n.name)} · ${GROUP_NAMES[n.group]} · ${n.deg} links`)
    .linkColor(() => 'rgba(255,79,216,0.35)')
    .linkDirectionalArrowLength(3).linkDirectionalArrowRelPos(1)
    .linkDirectionalParticles(1).linkDirectionalParticleWidth(1.6).linkDirectionalParticleColor(() => '#ff4fd8')
    .d3VelocityDecay(0.3)
    .onNodeClick(openFile)
    .onEngineStop(() => { if (!fitted) { fitted = true; links2d.zoomToFit(500, 40); } });
  links2d.d3Force('charge').strength(-220);
  links2d.d3Force('link').distance(45);
  // Gentle pull to the origin so small disconnected pairs don't drift off and force a far zoom-out.
  let pulled = [];
  const gravity = alpha => pulled.forEach(n => { n.vx -= n.x * 0.06 * alpha; n.vy -= n.y * 0.06 * alpha; });
  gravity.initialize = nodes => { pulled = nodes; };
  links2d.d3Force('gravity', gravity);
  new ResizeObserver(() => links2d.width(el.clientWidth).height(el.clientHeight)).observe(el);
}
const openFile = n => fileTile(`file:${n.id}`, n.name, GROUP_NAMES[n.group], `/api/file?id=${encodeURIComponent(n.id)}`);

/* ---------- Orbit toggle: off leaves the 3D map still when idle (lighter over RDP) ---------- */
let orbiting = (() => { try { return localStorage.getItem('mc.orbit') !== 'off'; } catch { return true; } })();
const orbitBtn = $('#orbit');
orbitBtn.classList.toggle('on', orbiting);
orbitBtn.onclick = () => {
  orbiting = !orbiting;
  orbitBtn.classList.toggle('on', orbiting);
  try { localStorage.setItem('mc.orbit', orbiting ? 'on' : 'off'); } catch { /* not remembered */ }
};

/* ---------- Board: panels you can drag, resize, remove and add back ---------- */
// One entry per panel; its markup is the <section data-panel="id"> in index.html. A new panel type is
// a new entry plus its section. open/close hooks start and stop whatever work the panel drives.
const PANELS = [
  { id: 'sessions', title: 'Sessions', x: 0, y: 0, w: 3, h: 5 },
  { id: 'herdr', title: 'Herdr', x: 0, y: 5, w: 3, h: 3 },
  { id: 'knowledge', title: 'Knowledge', x: 3, y: 0, w: 6, h: 8,
    open: () => graphData && setView(view), close: () => { graph?.pauseAnimation(); links2d?.pauseAnimation(); } },
  { id: 'side', title: 'Linear · GitHub · Repos · Inbox', x: 9, y: 0, w: 3, h: 8 },
  { id: 'flows', title: 'Orchestration flows', x: 0, y: 8, w: 12, h: 4, open: () => pollChecks() },
  // Not on the default board: add it from ＋ Panels. Sampling runs only while it's shown.
  { id: 'resources', title: 'Resources', x: 0, y: 12, w: 12, h: 6, hidden: true, open: () => pollResources() },
  { id: 'docker', title: 'Docker', x: 0, y: 18, w: 12, h: 6, hidden: true, open: () => pollDocker() },
];
const ROWS = 12; // the default layout fills the viewport in 12 rows
const openPanels = new Set();
const isOpen = id => openPanels.has(id);
let board;
const cellH = () => Math.max(40, Math.floor((innerHeight - 52 - 12) / ROWS));
const readLayout = () => { try { return JSON.parse(localStorage.getItem('mc.layout')); } catch { return null; } };

function mountPanel(p, pos) {
  const item = document.createElement('div');
  item.className = 'grid-stack-item';
  const content = document.createElement('div');
  content.className = 'grid-stack-item-content';
  content.append(document.querySelector(`section[data-panel="${p.id}"]`));
  item.append(content);
  board.el.append(item);
  board.makeWidget(item, { id: p.id, minW: 2, minH: 2, ...pos });
  openPanels.add(p.id);
  p.open?.();
}
function unmountPanel(id) {
  const item = board.el.querySelector(`.grid-stack-item[gs-id="${id}"]`);
  if (!item) return;
  $('#dock').append(item.querySelector('section'));
  board.removeWidget(item, true);
  openPanels.delete(id);
  PANELS.find(p => p.id === id)?.close?.();
}
function saveLayout() {
  if (board.getColumn() !== 12) return; // the one-column phone layout must not overwrite the wide one
  const layout = board.save(false).map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
  try { localStorage.setItem('mc.layout', JSON.stringify(layout)); } catch { /* not remembered */ }
}
function layoutPanels(layout) {
  board.batchUpdate();
  for (const id of [...openPanels]) unmountPanel(id);
  for (const p of PANELS) {
    const pos = layout ? layout.find(l => l.id === p.id) : p.hidden ? null : p;
    if (pos) mountPanel(p, { x: pos.x, y: pos.y, w: pos.w, h: pos.h });
  }
  board.batchUpdate(false);
}
function initBoard() {
  document.querySelectorAll('section[data-panel] .panel-handle').forEach(h => {
    const x = document.createElement('button');
    x.className = 'panel-x'; x.title = 'Remove panel (add it back from ＋ Panels)'; x.textContent = '✕';
    x.onclick = e => { e.stopPropagation(); unmountPanel(h.closest('section').dataset.panel); saveLayout(); };
    h.append(x);
  });
  board = GridStack.init({
    column: 12, cellHeight: cellH(), margin: 6, handle: '.panel-handle', animate: true,
    columnOpts: { breakpoints: [{ w: 800, c: 1 }] },
  }, '#board');
  layoutPanels(readLayout());
  board.on('change', saveLayout);
  addEventListener('resize', () => board.cellHeight(cellH()));

  const list = $('#panels-list');
  const renderList = () => {
    list.innerHTML = PANELS.map(p => `<button data-id="${p.id}" class="${isOpen(p.id) ? 'on' : ''}">${esc(p.title)}</button>`).join('')
      + '<hr><button class="reset">Reset layout</button>'
      + `<hr><div class="menu-label">Info tiles open as</div>${[['popup', 'Pop-ups (stack)'], ['drawer', 'Side drawer (one at a time)']]
        .map(([m, label]) => `<button data-mode="${m}" class="mode ${tileMode === m ? 'on' : ''}">${label}</button>`).join('')}`
      + `<hr><div class="menu-label">When something needs you</div><button class="notify ${notifyOn ? 'on' : ''}">Desktop notifications</button>`;
    list.querySelector('.notify').onclick = async () => { await setNotify(!notifyOn); renderList(); };
    list.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { setTileMode(b.dataset.mode); renderList(); });
    list.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
      const p = PANELS.find(p => p.id === b.dataset.id);
      if (isOpen(p.id)) unmountPanel(p.id); else mountPanel(p, { w: p.w, h: p.h, autoPosition: true });
      saveLayout(); renderList();
    });
    list.querySelector('.reset').onclick = () => {
      try { localStorage.removeItem('mc.layout'); } catch { /* nothing stored */ }
      layoutPanels(null); renderList();
    };
  };
  $('#panels-btn').onclick = e => { e.stopPropagation(); renderList(); list.hidden = !list.hidden; };
  // composedPath, not contains(): a menu click re-renders the list, detaching the clicked button.
  addEventListener('click', e => { if (!e.composedPath().includes(list)) list.hidden = true; });
}

/* ---------- Resources: CPU, RAM, GPU/VRAM, disks, Ollama, and the processes using them ---------- */
const RES_HISTORY = 60; // samples ≈ 10 minutes at the 10s poll
let resSort = (() => { try { return localStorage.getItem('mc.resSort') || 'ram'; } catch { return 'ram'; } })();
const gb = b => b == null ? '—' : b >= 2 ** 40 ? `${(b / 2 ** 40).toFixed(1)} TB` : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`;
const pctTxt = p => p == null ? '—' : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
// Severity reads in words as well as color: never color alone.
const level = p => p >= 95 ? ['crit', 'critical'] : p >= 80 ? ['high', 'high'] : ['ok', ''];

// Sparkline: muted line, current value as an accent dot; each column carries a hover title.
function spark(hist, key, fmt) {
  const pts = hist.map(h => h[key]).filter(v => v != null);
  if (pts.length < 2) return '<svg class="res-spark"></svg>';
  const max = Math.max(100, ...pts), W = 120, H = 26, x = i => (i / (RES_HISTORY - 1)) * W;
  const y = v => H - 2 - (v / max) * (H - 4);
  const line = hist.map((h, i) => h[key] == null ? null : `${x(i)},${y(h[key])}`).filter(Boolean).join(' ');
  const last = hist.at(-1)[key];
  const cols = hist.map((h, i) => `<rect x="${x(i) - W / RES_HISTORY / 2}" y="0" width="${W / RES_HISTORY}" height="${H}"><title>${new Date(h.at).toLocaleTimeString([], { hour12: false })} · ${fmt(h[key])}</title></rect>`).join('');
  return `<svg class="res-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${line}"/>${last != null ? `<circle cx="${x(hist.length - 1)}" cy="${y(last)}" r="2.2"/>` : ''}${cols}</svg>`;
}
function statTile(label, value, sub, pct, hist, key, fmt) {
  const [cls, word] = level(pct ?? 0);
  return `<div class="res-tile ${cls}"><div class="res-label">${esc(label)}${word ? ` <span class="res-word">${word}</span>` : ''}</div>
    <div class="res-value">${value}</div><div class="res-sub">${sub}</div>
    ${pct != null ? `<div class="res-meter"><i style="width:${Math.min(100, pct)}%"></i></div>` : ''}
    ${hist ? spark(hist, key, fmt) : ''}</div>`;
}
function renderResources() {
  const r = state.res;
  if (!r) return;
  const h = state.resHist;
  $('#res-at').textContent = `sampled ${ago(r.at)}`;
  const g = r.gpu, memPct = 100 * r.mem.used / r.mem.total, vramPct = g ? 100 * g.memUsed / g.memTotal : null;
  $('#res-tiles').innerHTML = [
    statTile('CPU', pctTxt(r.cpu.pct), `${r.cpu.cores} threads`, r.cpu.pct, h, 'cpu', pctTxt),
    statTile('RAM', gb(r.mem.used), `of ${gb(r.mem.total)} · ${Math.round(memPct)}%`, memPct, h, 'mem', pctTxt),
    g ? statTile('GPU', pctTxt(g.util), esc(g.name.replace(/^NVIDIA (GeForce )?/, '')), g.util, h, 'gpu', pctTxt) : '',
    g ? statTile('VRAM', gb(g.memUsed), `of ${gb(g.memTotal)} · ${Math.round(vramPct)}%`, vramPct, h, 'vram', pctTxt) : '',
    g ? statTile('GPU temp · power', `${g.temp}°C`, `${Math.round(g.power)} W`, null, h, 'temp', v => `${v}°C`) : '',
    ...r.disks.map(d => statTile(`Disk ${d.drive}`, `${gb(d.free)} free`, `of ${gb(d.total)}`, 100 * (1 - d.free / d.total), null)),
  ].join('');
  const unload = m => { const ms = Date.parse(m.until) - Date.now(); return ms > 0 ? ` · unloads in ${mins(ms)}` : ''; };
  $('#res-ollama').innerHTML = r.ollama == null ? '<span class="res-dim">Ollama: not running</span>'
    : !r.ollama.length ? '<span class="res-dim">Ollama: no models loaded</span>'
    : 'Ollama: ' + r.ollama.map(m => `<b>${esc(m.name)}</b> · ${gb(m.vram)} VRAM${m.vram < m.size ? ` + ${gb(m.size - m.vram)} RAM` : ''}${unload(m)}`).join(' · ');
  // Process table, grouped by app; labelled processes (Claude sessions) keep their own rows.
  const group = $('#res-group').checked, rows = new Map();
  for (const p of r.procs) {
    const key = p.label ?? (group ? p.name : `${p.name}#${p.pid}`);
    const row = rows.get(key) ?? rows.set(key, { name: p.label ?? p.name, pid: p.pid, n: 0, ram: 0, vram: null, cpu: null, gpu: null }).get(key);
    row.n++; row.ram += p.ram ?? 0;
    for (const k of ['vram', 'cpu', 'gpu']) if (p[k] != null) row[k] = (row[k] ?? 0) + p[k];
  }
  const list = [...rows.values()].sort((a, b) => (b[resSort] ?? -1) - (a[resSort] ?? -1)).slice(0, 15);
  const top = Math.max(...list.map(x => x[resSort] ?? 0), 1e-9);
  const cell = (row, k, fmt) => `<td class="${k === resSort ? 'sorted' : ''}">${fmt(row[k])}${k === resSort && row[k] ? `<i class="res-bar" style="width:${100 * row[k] / top}%"></i>` : ''}</td>`;
  const attributed = r.procs.reduce((a, p) => a + (p.cpu ?? 0), 0);
  const hidden = r.cpu.pct != null && r.sources.cpu ? Math.max(0, r.cpu.pct - attributed) : null;
  $('#res-procs').innerHTML = `<table><thead><tr><th>Process</th><th>CPU</th><th>RAM</th><th>VRAM</th><th>GPU</th></tr></thead><tbody>${list.map(x => `<tr>
    <td class="pname" title="${esc(x.name)}${x.n > 1 ? ` · ${x.n} processes` : ` · pid ${x.pid}`}">${esc(x.name)}${x.n > 1 ? ` <span class="res-dim">×${x.n}</span>` : ''}</td>
    ${cell(x, 'cpu', pctTxt)}${cell(x, 'ram', gb)}${cell(x, 'vram', gb)}${cell(x, 'gpu', pctTxt)}</tr>`).join('')}</tbody></table>`
    // CPU Windows won't attribute (protected processes like the WSL VM) is shown, not hidden.
    + (hidden >= 1 ? `<div class="res-note">${pctTxt(hidden)} CPU is in protected processes Windows won't attribute (WSL/Docker VM, Defender, system services).</div>` : '')
    + (!r.sources.cpu ? '<div class="res-note">Per-process CPU appears from the second sample on.</div>' : '');
  document.querySelectorAll('#res-sort button').forEach(b => b.classList.toggle('on', b.dataset.k === resSort));
}
async function pollResources() {
  if (!isOpen('resources')) return;
  const r = await api('/api/resources');
  if (!r) return;
  if (r.at !== state.res?.at) {
    state.res = r;
    state.resHist = [...(state.resHist ?? []), { at: r.at, cpu: r.cpu.pct, mem: 100 * r.mem.used / r.mem.total,
      gpu: r.gpu?.util ?? null, vram: r.gpu ? 100 * r.gpu.memUsed / r.gpu.memTotal : null, temp: r.gpu?.temp ?? null }].slice(-RES_HISTORY);
  }
  renderResources();
}
document.querySelectorAll('#res-sort button').forEach(b => b.onclick = () => {
  resSort = b.dataset.k;
  try { localStorage.setItem('mc.resSort', resSort); } catch { /* not remembered */ }
  renderResources();
});
$('#res-group').onchange = renderResources;

/* ---------- Docker: what's running, what its disk holds, and cleanup ---------- */
// Tile cleanup buttons arm on the first click and act on the second (within 4s). Images are
// marked instead (any number, no timeout) and deleted together from one confirm bar. All of it
// lives here so the 10s re-render doesn't reset it.
const dk = { armed: null, armedUntil: 0, busy: null, msg: null, marked: new Map(), batch: null };
const imgKey = i => `${i.id}|${i.ref}`;
const siBytes = s => { const m = String(s).match(/^([\d.]+)\s*([kKMGT]?)B/); return m ? Number(m[1]) * 1000 ** ({ '': 0, k: 1, K: 1, M: 2, G: 3, T: 4 }[m[2]]) : 0; };
// Space a set of marked rows frees: an image's layers go only when every tag of it is marked.
function markedFrees(images) {
  const ids = new Set([...dk.marked.values()].map(m => m.id));
  return [...ids].reduce((a, id) => {
    const tags = images.filter(i => i.id === id);
    return a + (tags.every(i => dk.marked.has(imgKey(i))) ? tags[0].unique ?? tags[0].size : 0);
  }, 0);
}
const when = ms => ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : null;
const PRUNES = { containers: 'clear stopped', build: 'clear cache', volumes: 'clear unnamed', dangling: 'clear untagged' };
function dkBtn(key, label, freed, payload, disabled = '') {
  const armed = dk.armed === key && Date.now() < dk.armedUntil, busy = dk.busy === key;
  return `<button class="dk-btn ${armed ? 'armed' : ''} ${busy ? 'busy' : ''}" data-key="${esc(key)}" data-payload="${esc(JSON.stringify(payload))}"
    ${disabled || dk.busy ? 'disabled' : ''} title="${esc(disabled || (armed ? 'Click again to confirm' : `Frees about ${gb(freed)}`))}">${busy ? 'working…' : armed ? `confirm · ${gb(freed)}` : esc(label)}</button>`;
}
function dkTile(label, t, prune, sub) {
  const pct = t.size ? 100 * t.reclaimable / t.size : 0;
  return `<div class="res-tile dk-tile"><div class="res-label">${esc(label)} <span class="res-dim">${t.count}</span></div>
    <div class="res-value">${gb(t.size)}</div><div class="res-sub">${sub ?? `${gb(t.reclaimable)} reclaimable`}</div>
    <div class="res-meter" title="${Math.round(pct)}% reclaimable"><i style="width:${pct}%"></i></div>
    ${prune && t.reclaimable > 0 ? dkBtn(`prune:${prune}`, PRUNES[prune], t.reclaimable, { what: prune }) : ''}</div>`;
}
function renderDocker() {
  const d = state.docker;
  if (!d) return;
  $('#dk-at').textContent = d.up ? `engine ${d.version} · sampled ${ago(d.at)}` : 'not running';
  $('#dk-msg').innerHTML = dk.msg ? `<span class="${dk.msg.ok ? '' : 'dk-err'}">${esc(dk.msg.text)}</span>` : '';
  // The disk file grows with use and never shrinks on its own; show it against what Docker holds.
  const held = d.up ? Object.values(d.totals).reduce((a, t) => a + t.size, 0) : null;
  const shrink = `${d.disk?.path}\n\nTo shrink it: quit Docker Desktop, run "wsl --shutdown", then compact the file from an admin shell (Optimize-VHD -Mode Full, or diskpart: compact vdisk).`;
  const diskTile = d.disk ? `<div class="res-tile dk-tile ${held != null && d.disk.size > 2 * held + 2 ** 30 ? 'high' : ''}"><div class="res-label">Disk file</div>
    <div class="res-value">${gb(d.disk.size)}</div><div class="res-sub">${held != null ? `Docker holds ${gb(held)}` : 'docker_data.vhdx'}</div>
    ${held != null ? `<div class="res-meter"><i style="width:${Math.min(100, 100 * held / d.disk.size)}%"></i></div>` : ''}
    <div class="res-note" title="${esc(shrink)}">doesn't shrink when Docker frees space ⓘ</div></div>` : '';
  if (!d.up) {
    $('#dk-tiles').innerHTML = `<div class="placeholder">Docker isn't running${d.error ? ` (${esc(d.error)})` : ''}.</div>${diskTile}`;
    $('#dk-containers').innerHTML = $('#dk-images').innerHTML = '';
    return;
  }
  const T = d.totals, untagged = d.images.filter(i => !i.ref);
  $('#dk-tiles').innerHTML = [
    dkTile('Images', T.images, untagged.length ? 'dangling' : null, `${gb(T.images.reclaimable)} unused · delete below`),
    dkTile('Containers', T.containers, 'containers', `${d.containers.filter(c => c.state === 'running').length} running`),
    dkTile('Volumes', T.volumes, 'volumes', `${gb(T.volumes.reclaimable)} in unnamed volumes`),
    dkTile('Build cache', T.build, 'build'),
    diskTile,
  ].join('');
  $('#dk-containers').innerHTML = d.containers.length ? `<table><thead><tr><th>Container</th><th>Image</th><th>Status</th><th>CPU</th><th>Memory</th></tr></thead><tbody>${
    d.containers.map(c => `<tr class="${c.state === 'running' ? '' : 'dk-stopped'}">
      <td class="pname">${c.state === 'running' ? '<i class="dk-dot"></i>' : ''}${esc(c.name)}</td><td class="pname">${esc(c.image)}</td>
      <td>${esc(c.status)}</td><td>${c.cpu != null ? pctTxt(c.cpu) : '—'}</td><td>${c.mem != null ? gb(c.mem) : '—'}</td></tr>`).join('')}</tbody></table>`
    : '<div class="res-dim">No containers.</div>';
  // Images: least recently used first (never seen, then oldest), the likeliest to delete.
  const imgs = [...d.images].sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0) || b.size - a.size || imgKey(a).localeCompare(imgKey(b)));
  for (const k of dk.marked.keys()) if (!d.images.some(i => imgKey(i) === k)) dk.marked.delete(k);
  const n = dk.marked.size, b = dk.batch;
  const bar = b ? `<div class="dk-batch busy">Deleting ${b.done + 1} of ${b.total}…</div>`
    : n ? `<div class="dk-batch">Delete ${n} image${n > 1 ? 's' : ''} · frees ${gb(markedFrees(d.images))}
        <button class="dk-btn dk-go">confirm</button><button class="dk-btn dk-cancel">cancel</button></div>` : '';
  $('#dk-images').innerHTML = `<table><thead><tr><th>Image</th><th>Size</th><th>Pulled</th><th>Last used</th><th></th></tr></thead><tbody>${
    imgs.map(i => `<tr class="${dk.marked.has(imgKey(i)) ? 'dk-marked' : ''}"><td class="pname" title="${esc(i.id)}">${esc(i.ref ?? `<untagged> ${i.id.replace('sha256:', '').slice(0, 12)}`)}${i.containers ? ` <span class="chip c-busy">${i.containers} container${i.containers > 1 ? 's' : ''}</span>` : ''}</td>
      <td title="${esc(`${gb(i.unique)} unique to this image`)}">${gb(i.size)}</td>
      <td title="${esc(i.created ? `built ${when(i.created)}` : '')}">${esc(when(i.pulled) ?? '—')}</td>
      <td title="${esc(i.lastUsed ? ago(i.lastUsed) : '')}">${i.lastUsed ? esc(when(i.lastUsed)) : '<span class="res-dim">not seen yet</span>'}</td>
      <td>${(why => `<button class="dk-btn dk-mark" data-k="${esc(imgKey(i))}" ${why || b ? 'disabled' : ''} title="${esc(why || (dk.marked.has(imgKey(i)) ? 'Unmark' : 'Mark for deletion'))}">${dk.marked.has(imgKey(i)) ? '✕ unmark' : 'delete'}</button>`)(i.containers ? 'A container uses this image; remove it first' : '')}</td></tr>`).join('')}</tbody></table>
    ${bar}<div class="res-note">Last used = the last container start Mission Control saw (it watches while running; Docker doesn't keep this), or a container that still exists.</div>`;
}
async function pollDocker() {
  if (!isOpen('docker') || dk.batch) return; // rows hold still until a batch delete finishes
  state.docker = await api('/api/docker') ?? state.docker;
  renderDocker();
}
$('#dk-body').addEventListener('click', async e => {
  const b = e.target.closest('.dk-btn');
  if (!b || b.disabled) return;
  if (b.classList.contains('dk-mark')) {
    const k = b.dataset.k, i = state.docker.images.find(i => imgKey(i) === k);
    if (dk.marked.has(k)) dk.marked.delete(k); else if (i) dk.marked.set(k, { id: i.id, ref: i.ref });
    dk.msg = null;
    return renderDocker();
  }
  if (b.classList.contains('dk-cancel')) { dk.marked.clear(); return renderDocker(); }
  if (b.classList.contains('dk-go')) return deleteMarked();
  const key = b.dataset.key;
  if (dk.armed !== key || Date.now() > dk.armedUntil) {
    Object.assign(dk, { armed: key, armedUntil: Date.now() + 4000 });
    renderDocker();
    setTimeout(() => { if (dk.armed === key && Date.now() >= dk.armedUntil) { dk.armed = null; renderDocker(); } }, 4100);
    return;
  }
  Object.assign(dk, { armed: null, busy: key, msg: null });
  renderDocker();
  const url = key.startsWith('prune:') ? '/api/docker/prune' : '/api/docker/image-rm';
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b.dataset.payload })
    .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
  dk.busy = null;
  dk.msg = { ok: r.ok, text: r.ok ? `Done · freed ${r.freed}` : `Failed: ${r.reason}` };
  await pollDocker();
});

// One at a time, so each result is known; a failure doesn't stop the rest.
async function deleteMarked() {
  const todo = [...dk.marked.values()], failed = [];
  let freed = 0;
  dk.batch = { done: 0, total: todo.length };
  dk.msg = null;
  renderDocker();
  for (const m of todo) {
    const r = await fetch('/api/docker/image-rm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) })
      .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
    if (r.ok) freed += siBytes(r.freed); else failed.push(`${m.ref ?? m.id.slice(7, 19)}: ${r.reason}`);
    dk.batch.done++;
    renderDocker();
  }
  const ok = todo.length - failed.length;
  dk.marked.clear();
  dk.batch = null;
  dk.msg = { ok: !failed.length, text: `Deleted ${ok} of ${todo.length} · freed ${gb(freed)}${failed.length ? ` · failed: ${failed.join('; ')}` : ''}` };
  await pollDocker();
}

/* ---------- Polling ---------- */
async function poll() {
  const [sessions, runs, herdr, orch, workers, attention] = await Promise.all([api('/api/sessions'), api('/api/runs'),
    isOpen('herdr') || isOpen('flows') ? api('/api/herdr') : state.herdr,
    isOpen('flows') ? api('/api/orchestrators') : state.orch,
    isOpen('flows') ? api('/api/workers') : state.workers, api('/api/attention')]);
  Object.assign(state, { sessions: sessions ?? [], runs, herdr, orch: orch ?? state.orch, workers: workers ?? state.workers,
    attention: attention ?? state.attention });
  renderSessions(); renderHerdr(); renderFlows(); renderOrch(); renderWorkers(); renderStats(); refreshTiles();
  pollTaskTiles();
}
async function pollSlow() {
  const [projects, linear, github] = await Promise.all([api('/api/projects'), api('/api/linear'), api('/api/github')]);
  Object.assign(state, { projects: projects ?? [], linear, github });
  renderProjects(); renderLinear(); renderGithub(); renderFlows(); renderStats();
}

async function pollChecks() {
  if (!isOpen('flows')) return;
  state.checks = await api('/api/checks') ?? state.checks;
  renderFlows(); refreshTiles();
}

initBoard();
poll(); pollSlow(); pollChecks(); loadGraph();
setInterval(pollChecks, 30000);
setInterval(pollResources, 10000);
setInterval(pollDocker, 10000);
setInterval(poll, 5000);
setInterval(pollSlow, 60000);
