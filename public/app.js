import { marked, mdHtml, showFile } from '/viewer.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = ms => {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;
};
// Server down (e.g. mid-restart) yields null, so panels keep their last state instead of throwing.
// While the server restarts or stops, polls stand down: they'd fill the browser's six connections to the
// server with cold-cache requests and hold up the check for the new server.
let standDown = false;
const api = p => standDown ? Promise.resolve(null) : fetch(p).then(r => r.ok ? (r.headers.get('content-type')?.includes('json') ? r.json() : r.text()) : null).catch(() => null);
// A timed poll runs one at a time: a tick that comes while the last one is still waiting on a busy
// server is skipped, not stacked on top of it (stacked polls are what piled requests up on the server).
const single = fn => { let running = false; return async () => { if (running) return; running = true; try { await fn(); } finally { running = false; } }; };

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
      <div class="t"><span>${esc(s.name)}${machineChip(s.machine)}</span><span class="t-right">${s.alive ? jumpBtn(s) : ''}<span class="chip c-${esc(s.status)}" title="${esc(statusHint(s))}">${esc(s.alive ? statusLabel(s) : 'gone')}</span></span></div>
      <div class="s">${esc(s.cwd)}</div>
      <div class="s">${s.ticket ? `ticket ${esc(s.ticket)} · ` : ''}updated ${ago(s.updatedAt)}</div>
      ${(state.sessionPrs?.[s.id] ?? []).map(prLine).join('')}
      ${s.alive ? sessionActLine(s.id) : ''}
      ${(a => a ? `<div class="s wk-needs" title="${esc([dialogLine(a), ...[...a.options, ...(a.items ?? [])].map((o, n) => `${n + 1}. ${o}`)].filter(Boolean).join('\n'))}">◆ awaiting you${dialogLine(a) ? ` · ${esc(dialogLine(a))}` : ' · a question is open'}</div>` : '')(attentionFor(s.id))}
    </div>`).join('') || '<div class="placeholder">No sessions.</div>';
  bindJumps($('#sessions'));
  $('#sessions').querySelectorAll('.card').forEach(c => c.onclick = () => {
    const s = state.sessions[c.dataset.i];
    const t = s.ticket && findTicket(ref(s.machine, s.ticket));
    const el = tile(`session:${s.id}`, s.name, s.machine ? `claude session · ${s.machine}` : 'claude session', dl({
      ...(s.machine ? { machine: esc(s.machine) } : {}),
      status: esc(s.status === 'shell' ? `watching (${statusHint(s).toLowerCase()})` : s.status), alive: s.alive ? 'yes' : 'no (stale session file)', cwd: esc(s.cwd), pid: esc(s.pid),
      kind: esc(s.kind), started: esc(new Date(s.startedAt).toLocaleString()), updated: ago(s.updatedAt), 'session id': esc(s.id),
      ...(t ? { 'flow step': `${stepChip(t)} in ${esc(t.epic)}` } : {}),
      ...(s.alive ? { focus: jumpBtn(s, true) } : {}),
    }) + (s.alive ? `<div class="tile-sact" data-session="${esc(s.id)}">${sessionActSection(s.id)}</div>` : '')
      + (prs => prs.length ? `<div class="checks"><div class="ck-head">Pull requests</div>${prs.map(prSection).join('')}</div>` : '')(state.sessionPrs?.[s.id] ?? []));
    bindJumps(el);
  });
}
// Claude Code reports "shell" when a session's turn is over but background work it started is still
// running (a watcher on CI, a backgrounded command): the session wakes when that work reports.
const statusLabel = s => s.status === 'shell' ? 'watching' : s.status;
const statusHint = s => s.status === 'shell' ? 'Turn ended; its background work is still running and will wake it' : s.status;
// Under a session: its latest message, then each open background task.
function sessionActLine(id) {
  const a = state.sessionAct?.[id];
  if (!a) return '';
  return (a.intent ? `<div class="s sa-line"><span class="wk-say">${esc(a.intent)}</span></div>` : '')
    + a.tasks.map(k => `<div class="s">${taskChip(k, 'wk-task', true)}</div>`).join('');
}
// Tile section: the latest message in full width, open background tasks, then the recent feed.
function sessionActSection(id) {
  const a = state.sessionAct?.[id];
  if (!a) return '';
  return `<div class="ck-title">Activity</div>`
    + (a.tasks.length ? `<div class="ck-head">Background tasks</div><div class="wk-tasks">${a.tasks.map(k => taskChip(k)).join(' ')}</div>` : '')
    + feedHtml(a.events);
}
// A PR a session is on, in one line: number, CI state, mutation progress while it runs.
function prLine(url) {
  const ci = ciState(url), m = state.checks?.[`pr:${url}`]?.mutations;
  const mut = m && m.done < m.total ? ` · <span class="pr-mut">🧬 ${m.done}/${m.total}${m.running ? ` · ${m.running} running` : ''}</span>` : '';
  return `<div class="s pr-line">PR #${esc(prNumber(url))}${ci ? ` · <span class="chip c-${esc(ci.state)}">CI ${esc(ci.state)}</span>` : ''}${mut}</div>`;
}
// Tile section for a PR outside any ticket: its link and, while CI isn't green, every check.
const prSection = url => `<div class="pr-title"><a href="${esc(url)}" target="_blank" rel="noopener">${(p => p ? `${esc(p.repository.name)}#${esc(p.number)}</a> ${esc(p.title)}` : `${esc(url)}</a>`)(state.github?.myPrs?.find(p => p.url === url))}${(ci => ci ? ` <span class="chip c-${esc(ci.state)}">CI ${esc(ci.state)}</span>` : '')(ciState(url))}</div>`
  + `<div class="tile-checks" data-ticket="${esc(`pr:${url}`)}">${checksSection(`pr:${url}`)}</div>`;
const jumpBtn = (s, label) => `<button class="jump-btn" data-session="${esc(s.id)}"${s.machine ? ` data-machine="${esc(s.machine)}"` : ''} data-what="${esc(s.name)}" title="Focus this session">⏵${label ? ' focus session' : ''}</button>`;

function renderHerdr() {
  const h = state.herdr;
  if (!h) return;
  if (!h.online) {
    $('#herdr-count').textContent = 'offline';
    $('#herdr').innerHTML = `<div class="placeholder">${esc(h.reason)}</div>`;
    return;
  }
  $('#herdr-count').textContent = `${h.workspaces.length} ws · ${h.agents.length} agents`;
  // A peer's workspaces (`machine`) sit beside this machine's; herdr is off here when only theirs show.
  $('#herdr').innerHTML = (h.localReason ? `<div class="placeholder">This machine: ${esc(h.localReason)}</div>` : '') + h.workspaces.map(w => {
    const agents = h.agents.filter(a => a.session === w.session && a.machine === w.machine && a.workspace_id === w.workspace_id);
    const on = w.machine ? ` data-machine="${esc(w.machine)}"` : '';
    return `<div class="card ${esc(w.agent_status)}">
      <div class="t"><span>${esc(w.label || w.workspace_id)}${machineChip(w.machine)}</span><span class="chip c-${esc(w.agent_status)}">${esc(w.agent_status)}</span></div>
      <div class="s">${w.machine ? `${esc(w.machine)} · ` : ''}${esc(w.session)} · ${w.tab_count} tabs · ${w.pane_count} panes${w.worktree ? ' · worktree' : ''}</div>
      ${agents.map(a => `<div class="s jump" data-pane="${esc(a.pane_id)}"${on} data-label="${esc(w.label ?? '')}" data-what="${esc(`${w.label || w.workspace_id} · ${a.agent || a.pane_id}`)}" title="focus in herdr">▸ ${esc(a.agent || a.pane_id)} <span class="chip c-${esc(a.agent_status)}">${esc(a.agent_status)}</span></div>`).join('')}
    </div>`;
  }).join('') || '<div class="placeholder">No workspaces.</div>';
  bindJumps($('#herdr'));
}

/* herdr updates: a badge in the Herdr panel when herdr's own update check found a newer version, or when
   running servers are still on an older one. Its tile says what's new and has an update button that works
   only at a pause; the server checks the pause again before doing anything. */
let herdrVer = null, herdrVerAt = 0;
const hvUi = { armedUntil: 0, busy: false, msg: null };
const hvTile = () => document.querySelector('.tile-herdr-update');
async function pollHerdrVersion() {
  // Once a minute for the badge; every 10 s while the tile is open, so its pause reading stays current.
  if (!hvTile() && !(isOpen('herdr') && Date.now() - herdrVerAt > 55_000)) return;
  herdrVer = await api('/api/herdr/version') ?? herdrVer;
  herdrVerAt = Date.now();
  renderHerdrVer();
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const andList = xs => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
function renderHerdrVer() {
  const v = herdrVer, b = $('#herdr-ver'), show = Boolean(v?.update || v?.behind?.length);
  b.hidden = !show;
  if (show) {
    b.textContent = v.update ? `⬆ ${v.latest}` : `⟳ ${plural(v.behind.length, 'server')} on old`;
    b.title = v.update ? `herdr ${v.latest} is available (you have ${v.installed})` : `${v.behind.join(', ')}: still on an older herdr than ${v.installed}`;
  }
  const el = hvTile(), html = el && herdrUpdateHtml();
  if (el && html !== el._html) el.innerHTML = el._html = html;
}
// herdr's release notes, as Markdown: raw HTML is already escaped (marked.use above); parsed inertly, so
// nothing loads, then images dropped and links kept only when they're https.
function notesHtml(md) {
  const doc = new DOMParser().parseFromString(marked.parse(md), 'text/html');
  doc.querySelectorAll('img').forEach(i => i.remove());
  doc.querySelectorAll('a').forEach(a => /^https:\/\//.test(a.getAttribute('href') ?? '')
    ? Object.assign(a, { target: '_blank', rel: 'noopener' }) : a.removeAttribute('href'));
  return doc.body.innerHTML;
}
function herdrUpdateHtml() {
  const v = herdrVer;
  if (!v) return '<div class="placeholder">Reading herdr…</div>';
  if (!v.installed) return `<div class="placeholder">${esc(v.reason ?? 'herdr not found')}</div>`;
  const due = v.update || v.behind.length > 0;
  // An update restarts every running server (all are on the old version); otherwise just the ones behind.
  const restarts = v.update ? v.servers.length : v.behind.length;
  const what = v.update ? `Update herdr to ${v.latest}` : `Restart ${plural(v.behind.length, 'server')}`;
  const armed = Date.now() < hvUi.armedUntil;
  const action = !due ? '<span class="res-dim">herdr is up to date.</span>'
    : hvUi.busy || v.updating ? '<button class="dk-btn busy" disabled>updating… (a minute or two)</button>'
    : !v.pause.ok ? `<button class="dk-btn" disabled title="Only at a pause">${esc(what)}</button>`
    : `<button class="dk-btn hv-go ${armed ? 'armed' : ''}" title="${armed ? 'Click again to go ahead' : esc(what)}">${armed ? `confirm: restarts ${plural(restarts, 'server')}` : esc(what)}</button>`;
  const pause = !due ? '' : v.pause.ok ? '<p class="gate-q">Nothing is working or waiting in herdr, and no orchestration is running: a good time.</p>'
    : `<p class="gate-q">Wait for a pause. Still running:</p><ul class="hv-why">${v.pause.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`;
  const servers = v.servers.map(s => `${esc(s.session)} <span class="${v.behind.includes(s.session) ? 'hv-old' : 'res-dim'}">${esc(s.version ?? '?')}</span>`).join(' · ') || 'none running';
  return `<div class="gate"><div class="gate-title">${v.update ? `herdr ${esc(v.latest)} is available` : due ? 'Servers on an older herdr' : 'herdr'}</div>
    ${dl({ installed: esc(v.installed), latest: esc(v.latest ?? '—'), channel: esc(v.channel ?? '—'), 'running servers': servers })}
    ${pause}
    ${due ? `<p class="res-dim">${v.update ? 'Runs <code>herdr update</code>, then restarts' : 'Restarts'} each running server: its agents stop, and herdr restores the workspaces and resumes the Claude panes. Windows Cleon opened on them are reopened where they were.</p>` : ''}
    <div class="gate-opt">${action}</div>
    ${hvUi.msg ? `<div class="gate-msg ${hvUi.msg.ok ? '' : 'bad'}">${esc(hvUi.msg.text)}</div>` : ''}</div>
    ${v.notes ? `<div class="hv-notes"><div class="ck-head">What's new in ${esc(v.latest)}</div>${notesHtml(v.notes)}</div>` : ''}
    <p><a href="https://github.com/herdrdev/herdr/releases" target="_blank" rel="noopener">All herdr releases ↗</a></p>`;
}
$('#herdr-ver').onclick = e => {
  e.stopPropagation();
  tile('herdr-update', 'herdr update', herdrVer?.update ? `${herdrVer.installed} → ${herdrVer.latest}` : 'servers', '<div class="tile-herdr-update"></div>');
  renderHerdrVer();
  pollHerdrVersion();
};
document.addEventListener('click', async e => {
  const b = e.target.closest?.('.hv-go');
  if (!b || b.disabled) return;
  if (Date.now() > hvUi.armedUntil) {
    hvUi.armedUntil = Date.now() + 4000;
    renderHerdrVer();
    setTimeout(renderHerdrVer, 4100);
    return;
  }
  Object.assign(hvUi, { armedUntil: 0, busy: true, msg: null });
  renderHerdrVer();
  const r = await fetch('/api/herdr/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response from the server' }));
  const restarted = r.restarted ?? [], windows = restarted.reduce((a, x) => a + x.windows, 0);
  const text = !r.to ? `Not updated: ${r.reason}`
    : [r.from !== r.to ? `herdr ${r.from} → ${r.to}.` : '',
      restarted.length ? `Restarted ${andList(restarted.map(x => x.session))}${windows ? `, and reopened ${plural(windows, 'window')}` : ''}.` : '',
      r.reason ?? ''].filter(Boolean).join(' ');
  Object.assign(hvUi, { busy: false, msg: { ok: r.ok, text } });
  toast(text, !r.ok);
  herdrVerAt = 0;
  await pollHerdrVersion();
  renderHerdrVer();
});

// A pane is live when herdr lists it in the run's workspace (matched by label, since ids like
// "w2" repeat across sessions).
const livePane = (pane, label, machine) => state.herdr?.online && state.herdr.agents.some(a => a.pane_id === pane && a.machine === machine
  && (!label || state.herdr.workspaces.some(w => w.session === a.session && w.machine === machine && w.workspace_id === a.workspace_id && w.label === label)));
// Any element with data-pane or data-ws becomes a jump into herdr.
// Elements with data-session jump to a Claude session (its herdr pane, or its VS Code window).
// data-machine: the row is a peer's, so the jump is that machine's.
function bindJumps(root) {
  root.querySelectorAll('[data-pane], [data-ws], [data-session]').forEach(el => el.onclick = e => {
    e.stopPropagation(); // a jump inside a card shouldn't also open the card's tile
    const m = onMachine(el.dataset.machine);
    if (el.dataset.session) return jump('/api/session/focus', { id: el.dataset.session, ...m }, el, el.dataset.what);
    jump('/api/herdr/focus', { pane: el.dataset.pane || undefined, workspace: el.dataset.ws || undefined, label: el.dataset.label || undefined, ...m },
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
  // A peer's pane: focused there, and the herdr window here switched to that machine raised (`here`), or which
  // saved machine to switch one to. A hint stays up long enough to read.
  const here = r.ok && r.machine ? r.here : null;
  toast(!r.ok ? `Couldn't focus ${what}${r.machine ? ` on ${r.machine}` : ''}: ${r.reason}`
    : here?.raised ? `Focused ${what} on ${r.machine} — raised your herdr window showing it`
    : here?.switchTo ? `Focused ${what} in herdr (${r.session}) on ${r.machine}. To see it here, switch a herdr window to ${here.switchTo} in its sidebar.`
    : here?.setup ? `Focused ${what} in herdr (${r.session}) on ${r.machine}. To see it here, save it as a herdr machine (${here.setup}), then switch a herdr window to it.`
    // A peer whose jump didn't land in herdr, or any machine run with MC_HEADLESS: no window was touched.
    : r.machine || r.headless ? `Focused ${what} in herdr (${r.session ?? 'its session'}) on ${r.machine ?? 'this machine'}; no window was opened there. Open it with herdr's saved machine.`
    : r.via === 'vscode' ? `Raised ${r.raised} — ${what} is in one of its terminals`
    : r.attached ? `No window showed herdr session ${r.session}, so one was opened on ${what}${r.raised ? '' : ' — check the taskbar'}`
    : r.raised ? `Focused ${what} — raised ${r.raised}` : `Focused ${what} in herdr (${r.session}) — switch to your herdr terminal`, !r.ok,
  here && !here.raised ? 10_000 : undefined);
}
function toast(text, bad, ms = 3500) {
  const t = document.createElement('div');
  t.className = `toast ${bad ? 'bad' : ''}`;
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
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
// A PR's number from its address on either host (…/pull/12, …/pull-requests/12/overview).
const prNumber = url => url.match(/\/pull(?:-requests)?\/(\d+)/)?.[1] ?? url.split('/').pop();
// The source-control host the server reads (MC_SCM): GitHub or Bitbucket.
const scmName = () => state.github?.scm ?? 'GitHub';
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
function mergeApproved(t, epic = t.epic, machine = t.machine) {
  if (t.step !== 'human-review' || !t.pr) return false;
  const n = Number(prNumber(t.pr));
  // An approval from any session that looks like this epic's orchestrator (on the ticket's machine) counts.
  return (state.orch ?? []).filter(o => o.epic === epic && o.machine === machine).some(o => o.approvals?.some(a => (a.prs.includes(n) || a.tickets.includes(t.ticket)) && (!t.since || a.t >= t.since)));
}
// At review·merge, a PR whose CI is still running can't be merged yet, so it isn't waiting on you.
// It flags you once CI finishes, or as soon as a check fails.
const awaitingCi = t => t.step === 'human-review' && Boolean(t.pr) && ciState(t.pr)?.state === 'pending';
const stepChip = t => t.held ? '<span class="chip c-held">⏸ held</span>'
  : mergeApproved(t) ? '<span class="chip c-busy">merge approved</span>'
  : awaitingCi(t) ? '<span class="chip c-busy">awaiting CI</span>'
  : `<span class="chip c-${esc(t.step)}">${esc(t.fixRound ? 'implementing (fix round)' : t.step)}</span>`;
// Peers (MC_PEERS): another machine's rows carry `machine`. Ticket and epic ids can sit on both machines,
// and herdr ids repeat on every machine, so a peer's go by `<machine>|<id>` wherever the page keys them,
// and every action on a peer's row names its machine (the server hands it to that peer).
const ref = (machine, id) => (machine ? `${machine}|${id}` : id);
const unref = key => { const i = String(key).indexOf('|'); return i < 0 ? [undefined, key] : [key.slice(0, i), key.slice(i + 1)]; };
const onMachine = m => (m ? { machine: m } : {});
const machineChip = m => (m ? ` <span class="chip c-machine" title="Runs on ${esc(m)}">${esc(m)}</span>` : '');
// A ticket by its key (`ref`): this machine's when the key names none.
function findTicket(key) {
  const [machine, id] = unref(key);
  for (const r of state.runs?.runs ?? []) {
    if (r.machine !== machine) continue;
    const t = r.tickets.find(t => t.ticket === id);
    if (t) return { ...t, epic: r.epic, wsId: r.workspace, wsLabel: r.label, machine: r.machine, ref: ref(r.machine, t.ticket) };
  }
  return null;
}
// A ticket by its plain id on any machine, this one first (Linear lists tickets, not machines).
const findTicketAnywhere = id => findTicket(id)
  ?? (state.runs?.runs ?? []).filter(r => r.machine && r.tickets.some(t => t.ticket === id)).map(r => findTicket(ref(r.machine, id)))[0] ?? null;

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
  const approvalsKey = (state.orch ?? []).map(o => [o.machine, o.epic, o.approvals]);
  const key = JSON.stringify([runs, showStale, approvalsKey, state.linear?.issues?.length, state.github?.myPrs, checksKey, Math.floor(Date.now() / 60000)]);
  if (key === flowsKey) return;
  flowsKey = key;
  const issue = id => state.linear?.issues?.find(i => i.identifier === id);
  // Epics and tickets go by ref: the same epic can have a run on each machine.
  const visible = runs.filter(r => showStale || r.active || orchFor(ref(r.machine, r.epic)));
  const orphans = (state.orch ?? []).filter(o => !runs.some(r => r.epic === o.epic && r.machine === o.machine));
  $('#flows').innerHTML = visible.map(r => {
    const merged = r.tickets.filter(t => t.step === 'done');
    const open = r.tickets.filter(t => t.step !== 'done' && (showStale || !t.stale));
    const key = ref(r.machine, r.epic);
    return `<div class="epic" data-epic="${esc(key)}">
      <div class="epic-head">${esc(r.epic)}${machineChip(r.machine)}<small>${esc(r.label ?? '')}${r.workspace ? ` · herdr ${esc(r.workspace)}` : ''} · ${ago(r.updatedAt)}</small>
        ${merged.length ? `<span class="merged">merged ${merged.map(t => `<span class="chip" data-ticket="${esc(ref(r.machine, t.ticket))}">✓ ${esc(t.ticket)}</span>`).join('')}</span>` : ''}</div>
      <div class="orch" data-epic="${esc(key)}"></div>
      ${open.map(t => {
        const f = flow.find(f => f.id === t.step);
        const approved = mergeApproved(t, r.epic, r.machine);
        const ciWait = !approved && awaitingCi(t);
        const where = approved ? 'merge approved · orchestrator merging' : ciWait ? 'review · merge · awaiting CI' : t.held ? `held before ${(f?.label ?? t.step).toLowerCase()}` : t.fixRound ? 'fix round' : f?.label ?? t.step;
        const stepText = `${where}${t.since ? ` · ${ago(t.since).replace(' ago', '')}` : ''}`;
        const awaitsYou = f?.you && !t.held && !t.stale && !approved && !ciWait;
        return `<div class="tk ${awaitsYou ? 'you' : ''} ${t.held ? 'held' : ''} ${t.failed ? 'failed' : ''} ${t.stale ? 'stale' : ''}" data-ticket="${esc(ref(r.machine, t.ticket))}">
          <div class="tk-info">
            <div class="id">${esc(t.ticket)}</div>
            <div class="title">${esc(issue(t.ticket)?.title ?? '')}</div>
            <div class="step">${awaitsYou ? '<span class="await">◆ awaiting you</span> · ' : ''}${esc(stepText)}${t.stale ? ' · inactive' : ''}</div>
            ${t.held && t.blockedOn ? `<div class="blocked-on">⏸ ${esc(t.blockedOn)}</div>` : ''}
            <div class="tk-act" data-ticket="${esc(ref(r.machine, t.ticket))}"></div>
            ${t.pr ? `<div class="pr"><a href="${esc(t.pr)}" target="_blank" rel="noopener">PR #${esc(prNumber(t.pr))}</a>${(ci => ci ? ` <span class="chip c-${esc(ci.state)}" title="${esc(ci.failed.length ? `failed: ${ci.failed.join(', ')}` : '')}">CI ${esc(ci.state)}</span>` : '')(ciState(t.pr))}</div>` : ''}
          </div>${flowSvg(flow, approved || ciWait ? { ...t, approved: true } : t)}</div>`;
      }).join('')}
    </div>`;
  }).join('') + orphans.map(o => `<div class="epic" data-epic="${esc(ref(o.machine, o.epic))}">
      <div class="epic-head">${esc(o.epic)}${machineChip(o.machine)}<small>orchestrator running · no run folder yet</small></div>
      <div class="orch" data-epic="${esc(ref(o.machine, o.epic))}"></div></div>`).join('')
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
// More than one live session can look like an epic's orchestrator; the one in a herdr pane is the real one.
// `key`: the epic's ref, so a peer's epic finds the orchestrator on its own machine.
const orchFor = key => { const [machine, epic] = unref(key); const all = (state.orch ?? []).filter(o => o.epic === epic && o.machine === machine); return all.find(o => o.pane) ?? all[0]; };
const mins = ms => `${Math.max(0, Math.round(ms / 60000))}m`;
// Strip under each epic's header: status, latest intent, background work, jump to its pane.
function orchStrip(key) {
  const o = orchFor(key), [machine, epic] = unref(key);
  // With tickets still open, the dead orchestrator can be restarted from here (on its machine).
  const open = state.runs?.runs?.find(r => r.epic === epic && r.machine === machine)?.tickets.some(t => t.step !== 'done');
  if (!o) return state.orch ? `<div class="orch-none">no live orchestrator session for this epic${open ? ` <button class="restart-btn" data-epic="${esc(key)}"
    title="Start a new orchestrator for ${esc(epic)} in its repo's herdr session, as an “orchestrator” tab beside its workers (or in a space of its own if theirs is gone), in the permission mode the last one had. It rebuilds the epic from Linear, its PRs and worktrees.">▸ restart in herdr</button>` : ''}</div>` : '';
  const working = !o.turnEnded && o.status !== 'done' && o.status !== 'idle';
  const needs = o.needsYou;
  const phase = needs ? `◆ awaiting you · ${ago(o.lastAt)}` : working ? 'working' : `turn ended · ${ago(o.lastAt)}`;
  const said = needs ? (needs.ask ?? dialogLine(attentionFor(o.sessionId)) ?? 'a question is open in its pane') : o.intent ?? '';
  // Each watcher names what it watches (the epic, one PR's CI…); full text on hover.
  const short = d => (d.length > 34 ? `${d.slice(0, 33)}…` : d);
  const tasks = o.tasks.map(k => taskChip({ ...k, desc: k.kind === 'watch' ? short(k.desc) : k.desc }, `orch-task ${k.kind}`)).join('');
  return `<div class="orch-strip ${needs ? 'needs' : working ? 'working' : 'idle'}" data-epic="${esc(key)}" title="Open the orchestrator's activity">
    <span class="orch-dot"></span><span class="orch-who">ORCHESTRATOR <b>${esc(o.name)}</b></span><span class="orch-state">${esc(phase)}</span>
    <span class="orch-intent" title="${esc([said, ...(needs?.items ?? []).slice(needs?.why === 'action' ? 1 : 0).map(i => `(you) ${i}`)].join('\n'))}">${esc(said)}${(n => n > 0 ? ` <span class="orch-more">+${n} (you) item${n > 1 ? 's' : ''}</span>` : '')((needs?.items?.length ?? 0) - (needs?.why === 'action' ? 1 : 0))}</span>${tasks}
    <button class="jump-btn" data-session="${esc(o.sessionId)}"${o.machine ? ` data-machine="${esc(o.machine)}"` : ''} data-what="${esc(`${epic} orchestrator`)}" title="Focus the orchestrator">⏵</button></div>`;
}
function renderOrch() {
  document.querySelectorAll('#flows .orch').forEach(el => {
    const html = orchStrip(el.dataset.epic);
    if (html === el._html) return; // only touch the DOM on change, so the pulse isn't restarted
    el.innerHTML = el._html = html;
    bindJumps(el);
    el.querySelector('.orch-strip')?.addEventListener('click', () => orchTile(el.dataset.epic));
    el.querySelector('.restart-btn')?.addEventListener('click', e => restartOrch(e.currentTarget));
  });
}
// The server finds the epic's repo, opens a new workspace in that repo's herdr session running the
// orchestrator, and shows the session's window. The strip goes live once the new session shows up.
async function restartOrch(b) {
  const [machine, epic] = unref(b.dataset.epic);
  b.disabled = true;
  const r = await fetch('/api/runs/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ epic, ...onMachine(machine) }) })
    .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
  b.disabled = false;
  const where = machine ? ` on ${machine}` : '';
  toast(!r.ok ? `Couldn't restart ${epic}'s orchestrator${where}: ${r.reason ?? r.error}`
    : !r.ran ? `Opened ${r.project}'s herdr session${where}, but herdr didn't take the orchestrator command`
    : `Restarted ${epic}'s orchestrator in ${r.project}'s herdr session${where}, space “${r.space}”${r.mode ? ` (${r.mode} mode)` : ''}${r.raised || machine || r.headless ? '' : ' — check the taskbar'}`, !r.ok || !r.ran);
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
  return `<span class="${cls} task-chip ${k.kind} ${quiet ? 'quiet' : ''}" data-task="${esc(k.id)}"${k.machine ? ` data-machine="${esc(k.machine)}"` : ''} data-desc="${esc(k.desc)}"
    title="${esc(`${k.desc}\nstarted ${ago(k.t)}${o?.size ? `\nlast output ${ago(o.at)}: ${o.lines.at(-1) ?? ''}` : ''}\nClick for live output`)}"><span class="tk-desc">${icon} ${esc(k.desc)} · ${age}</span>${progress}</span>`;
}
// Tile: the task's last 60 output lines, kept live by pollTaskTiles().
// A peer's task (`machine`) is read on its machine, through the server.
function taskTile(id, desc, machine) {
  tile(`task:${ref(machine, id)}`, desc, machine ? `background task output · ${machine}` : 'background task output',
    `<pre class="tile-task" data-task="${esc(id)}"${machine ? ` data-machine="${esc(machine)}"` : ''}><span class="placeholder">loading…</span></pre>`);
  pollTaskTiles();
}
async function pollTaskTiles() {
  for (const el of document.querySelectorAll('.tile-task')) {
    const r = await api(`/api/task-output?id=${encodeURIComponent(el.dataset.task)}${el.dataset.machine ? `&machine=${encodeURIComponent(el.dataset.machine)}` : ''}`);
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
  taskTile(c.dataset.task, c.dataset.desc, c.dataset.machine);
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
function orchTile(key) {
  const o = orchFor(key), [machine, epic] = unref(key);
  const el = tile(`orch:${key}`, `${epic} orchestrator${machine ? ` · ${machine}` : ''}`, o?.name ?? '', `<div class="tile-orch" data-epic="${esc(key)}">${orchFeed(key)}</div>`
    + (o ? `<div class="artifacts"><button class="jump-btn" data-session="${esc(o.sessionId)}"${machine ? ` data-machine="${esc(machine)}"` : ''} data-what="${esc(`${epic} orchestrator`)}">⏵ focus orchestrator</button></div>` : ''));
  bindJumps(el);
}

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
  return `<div class="checks"><div class="ck-title">CI checks <small>${esc(scmName())} · ${ago(c.at)}</small></div>`
    + group(m ? `Mutations · ${m.done}/${m.total} done${m.running ? ` · ${m.running} running` : ''}${m.total - m.done - m.running > 0 ? ` · ${m.total - m.done - m.running} queued` : ''}${m.failed ? ` · ${m.failed} failed` : ''}` : '', c.checks.filter(k => k.mutation))
    + group('Other', c.checks.filter(k => !k.mutation)) + '</div>';
}

// Live panes jump to the pane; closed ones fall back to the run's herdr workspace.
function panesHtml(t) {
  const lbl = esc(t.wsLabel ?? ''), on = t.machine ? ` data-machine="${esc(t.machine)}"` : '';
  return t.panes.map(p => livePane(p.pane, t.wsLabel, t.machine)
    ? `<button class="jump-btn" data-pane="${esc(p.pane)}"${on} data-label="${lbl}" data-what="${esc(`${t.ticket} · ${p.role}`)}">⏵ ${esc(p.role)} ${esc(p.pane)}</button>`
    : t.wsId
      ? `<button class="jump-btn gone" data-ws="${esc(t.wsId)}"${on} data-label="${lbl}" data-what="${esc(t.wsLabel || t.wsId)}" title="pane closed — opens the run's workspace">⏵ ${esc(p.role)} ${esc(p.pane)} · gone → ${esc(t.wsLabel || t.wsId)}</button>`
      : `<span class="pane-gone">${esc(p.role)} ${esc(p.pane)} (gone)</span>`).join(' ') || '—';
}
// Open ticket tiles track live state: panes on every poll, CI checks whenever they refresh.
function refreshTiles() {
  document.querySelectorAll('.tile-panes').forEach(el => {
    const t = findTicket(el.dataset.ticket), html = t && panesHtml(t);
    if (html && html !== el._html) { el.innerHTML = el._html = html; bindJumps(el); }
  });
  document.querySelectorAll('.tile-sact').forEach(el => {
    const html = sessionActSection(el.dataset.session);
    if (html !== el._html) el.innerHTML = el._html = html;
  });
  document.querySelectorAll('.tile-checks').forEach(el => {
    const html = checksSection(el.dataset.ticket);
    if (html !== el._html) el.innerHTML = el._html = html;
  });
  document.querySelectorAll('.tile-merge').forEach(el => {
    const html = mergeSection(el.dataset.ticket);
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

// Plan gate: the question the worker's pane is showing, read off its screen, beside the plan it asks
// about. Each option can be chosen here (two clicks); the server re-reads the pane and sends nothing
// unless it still shows exactly this question. A result stays visible for a minute after the gate closes.
const gateUi = { armed: null, armedUntil: 0, busy: null, msg: null };
function gateResult(id) {
  const m = gateUi.msg;
  return m && m.ticket === id && Date.now() - m.at < 60_000
    ? `<div class="gate-msg ${m.ok ? '' : 'bad'}">${esc(m.text)}</div>` : '';
}
// `id`: the ticket's ref (a peer's goes by machine|ticket).
function gateSection(id) {
  const t = findTicket(id);
  if (!t || t.step !== 'plan-gate' || t.held || t.stale) return gateResult(id);
  const w = state.workers?.[id], a = w && attentionFor(w.sessionId);
  const jump = w?.sessionId ? `<button class="jump-btn" data-session="${esc(w.sessionId)}"${t.machine ? ` data-machine="${esc(t.machine)}"` : ''} data-what="${esc(`${t.ticket} worker`)}">⏵ answer in its pane</button>` : '';
  if (!a?.options?.length) return `<div class="gate"><div class="gate-title">◆ Plan gate</div>
    <p class="placeholder">The plan is ready for your approval. Its question can't be read here: it isn't open in a herdr pane yet, or the worker runs outside herdr.</p>
    <div class="gate-foot">${jump}</div></div>`;
  return `<div class="gate"><div class="gate-title">◆ ${esc(a.title ?? 'Plan gate')}</div>
    <p class="gate-q">${esc(a.question ?? '')}</p>
    <ol class="gate-opts">${a.options.map((o, n) => {
      const k = `${id}:${n}`, armed = gateUi.armed === k && Date.now() < gateUi.armedUntil, busy = gateUi.busy === k;
      return `<li class="${/\(Recommended\)/i.test(o) ? 'rec' : ''}"><div class="gate-opt"><b>${esc(o)}</b>
        <button class="dk-btn gate-pick ${armed ? 'armed' : ''} ${busy ? 'busy' : ''}" data-ticket="${esc(id)}" data-n="${n}" ${gateUi.busy ? 'disabled' : ''}
          title="${armed ? 'Click again to send this answer to the worker' : 'Choose this option'}">${busy ? 'sending…' : armed ? 'confirm' : 'choose'}</button></div>
        ${a.notes?.[n] ? `<span>${esc(a.notes[n])}</span>` : ''}</li>`;
    }).join('')}</ol>
    ${gateResult(id)}
    <div class="gate-foot">${jump}<span class="res-dim">Choosing re-reads the pane first; if the question changed, nothing is sent.</span></div></div>`;
}
document.addEventListener('click', async e => {
  const b = e.target.closest?.('.gate-pick');
  if (!b || b.disabled) return;
  const id = b.dataset.ticket, n = Number(b.dataset.n), k = `${id}:${n}`;
  if (gateUi.armed !== k || Date.now() > gateUi.armedUntil) {
    Object.assign(gateUi, { armed: k, armedUntil: Date.now() + 4000 });
    refreshTiles();
    setTimeout(() => { if (gateUi.armed === k && Date.now() >= gateUi.armedUntil) { gateUi.armed = null; refreshTiles(); } }, 4100);
    return;
  }
  const a = attentionFor(state.workers?.[id]?.sessionId), [machine, ticket] = unref(id);
  if (!a?.options?.length) return;
  Object.assign(gateUi, { armed: null, busy: k, msg: null });
  refreshTiles();
  const r = await fetch('/api/gate/answer', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, choice: n, question: a.question, options: a.options, ...onMachine(machine) }) })
    .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response from the server' }));
  gateUi.busy = null;
  gateUi.msg = { ticket: id, at: Date.now(), ok: r.ok, text: r.ok ? `Sent: “${r.chose}”. The worker has it.` : `Not sent: ${r.reason ?? r.error}` };
  refreshTiles();
});
// Review·merge: hand the merge to the orchestrator with one fixed prompt, sent by the server. Allowed
// while CI is still running: then the prompt says "when its CI is green" (only then, or when CI couldn't
// be read). Once the orchestrator's transcript
// shows the prompt, the ticket reads "merge approved".
const mergeUi = { armed: null, armedUntil: 0, busy: null, msg: null };
function mergeSection(id) {
  const t = findTicket(id);
  const m = mergeUi.msg && mergeUi.msg.ticket === id && Date.now() - mergeUi.msg.at < 60_000
    ? `<div class="gate-msg ${mergeUi.msg.ok ? '' : 'bad'}">${esc(mergeUi.msg.text)}</div>` : '';
  if (!t || t.step !== 'human-review' || t.held || t.stale || !t.pr) return m;
  const pr = prNumber(t.pr), ci = ciState(t.pr);
  // No checks entry: CI couldn't be read (no SCM access, or the lookup failed).
  const ciUnknown = !state.checks?.[id];
  const ciChip = ci ? `<span class="chip c-${esc(ci.state)}">CI ${esc(ci.state)}</span>`
    : ciUnknown ? `<span class="chip c-unknown" title="Cleon couldn't read this PR's CI, so the prompt asks the orchestrator to wait for green">CI unknown</span>` : '';
  if (mergeApproved(t)) return `<div class="gate merged-ok"><div class="gate-title">✓ Merge approved</div>
    <p class="gate-q">The orchestrator has it and merges PR #${esc(pr)} when CI is green. ${ciChip}</p>${m}</div>`;
  const armed = mergeUi.armed === id && Date.now() < mergeUi.armedUntil, busy = mergeUi.busy === id;
  // Same rule as the server: mention CI while checks are still running or failing, or couldn't be read.
  const gated = ciUnknown || (state.checks[id].checks ?? []).some(k => ['pending', 'fail', 'cancel'].includes(k.bucket));
  const text = `Merge PR #${pr} for ${t.ticket}${gated ? ' when its CI is green' : ''}.`, o = orchFor(ref(t.machine, t.epic));
  // In a herdr pane the server sends it. Anywhere else nothing can type into the session safely, so the
  // prompt goes on the clipboard and its window comes forward: paste, Enter, and it reads as approved.
  const action = !o ? '<span class="res-dim">No live orchestrator for this epic.</span>'
    : o.pane ? `<button class="dk-btn merge-go ${armed ? 'armed' : ''} ${busy ? 'busy' : ''}" data-ticket="${esc(id)}" ${mergeUi.busy ? 'disabled' : ''}
        title="${armed ? 'Click again to send' : 'Approve the merge'}">${busy ? 'sending…' : armed ? 'confirm' : gated ? 'merge when green' : 'merge'}</button>`
    : `<button class="dk-btn merge-copy" data-ticket="${esc(id)}" data-sid="${esc(o.sessionId)}"${t.machine ? ` data-machine="${esc(t.machine)}"` : ''} data-text="${esc(text)}"
        title="The orchestrator isn't in herdr: copies the prompt and brings its window forward">copy &amp; open</button>`;
  return `<div class="gate"><div class="gate-title">◆ Review · merge</div>
    <p class="gate-q">PR #${esc(pr)} is reviewed and waiting on you. ${ciChip}</p>
    <div class="gate-opt"><span class="res-dim">${o && !o.pane ? 'Paste into the orchestrator' : 'Sends the orchestrator'}: “${esc(text)}”</span>${action}</div>
    ${m}</div>`;
}
document.addEventListener('click', async e => {
  const c = e.target.closest?.('.merge-copy');
  if (!c) return;
  e.stopPropagation();
  const copied = await navigator.clipboard.writeText(c.dataset.text).then(() => true, () => false);
  mergeUi.msg = { ticket: c.dataset.ticket, at: Date.now(), ok: copied,
    text: copied ? "Copied. Paste it into the orchestrator's window and press Enter." : `Couldn't copy; type it: “${c.dataset.text}”` };
  refreshTiles();
  jump("/api/session/focus", { id: c.dataset.sid, ...onMachine(c.dataset.machine) }, c, "the orchestrator");
}, true);
document.addEventListener('click', async e => {
  const b = e.target.closest?.('.merge-go');
  if (!b || b.disabled) return;
  const id = b.dataset.ticket;
  if (mergeUi.armed !== id || Date.now() > mergeUi.armedUntil) {
    Object.assign(mergeUi, { armed: id, armedUntil: Date.now() + 4000 });
    refreshTiles();
    setTimeout(() => { if (mergeUi.armed === id && Date.now() >= mergeUi.armedUntil) { mergeUi.armed = null; refreshTiles(); } }, 4100);
    return;
  }
  Object.assign(mergeUi, { armed: null, busy: id, msg: null });
  refreshTiles();
  const [machine, ticket] = unref(id);
  const r = await fetch('/api/merge/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, ...onMachine(machine) }) })
    .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response from the server' }));
  mergeUi.busy = null;
  mergeUi.msg = { ticket: id, at: Date.now(), ok: r.ok, text: !r.ok ? `Not sent: ${r.reason ?? r.error}`
    : `Sent to the orchestrator: “${r.sent}”${r.ciUnknown ? " Cleon couldn't read this PR's CI, so it asked the orchestrator to wait for green." : ''}` };
  refreshTiles();
});
// `id`: the ticket's ref. The tile names the plain ticket and, for a peer's, its machine.
function ticketTile(epicKey, id, step) {
  const t = findTicket(id);
  if (!t) return;
  const epic = t.epic, plain = t.ticket, on = t.machine ? `&machine=${encodeURIComponent(t.machine)}` : '';
  const names = step ? state.runs?.stepFiles?.[step] ?? [] : ['plan', ...t.files];  // the adapter's, from /api/runs
  const avail = names.filter(n => n === 'plan' || t.files.includes(n));
  const prLink = t.pr ? `<a href="${esc(t.pr)}" target="_blank" rel="noopener">${esc(t.pr)}</a>` : '—';
  const atPlanGate = t.step === 'plan-gate' && (!step || step === 'plan-gate');
  const atMerge = t.step === 'human-review' && (!step || step === 'human-review');
  const el = tile(`ticket:${id}:${step}`, `${plain}${step ? ` · ${step}` : ''}`, t.machine ? `${epic} · ${t.machine}` : epic,
    (atPlanGate ? `<div class="tile-gate" data-ticket="${esc(id)}">${gateSection(id)}</div>` : '')
    + (atMerge ? `<div class="tile-merge" data-ticket="${esc(id)}">${mergeSection(id)}</div>` : '') + dl({
    'current step': `${stepChip(t)}${t.held ? ` before ${esc(t.step)} · ${esc(t.blockedOn ?? 'blocked')}` : ''}${t.failed ? ' <span class="chip" style="color:var(--red)">failed</span>' : ''}${t.stale ? ' (inactive)' : ''}`,
    'STAGE file': esc(t.stage ?? '—'), 'REVIEW_STAGE': esc(t.reviewStage ?? '—'), PR: `${prLink} ${esc(t.prState ?? '')}`,
    panes: `<span class="tile-panes" data-ticket="${esc(id)}">${panesHtml(t)}</span>`,
  }) + `<div class="tile-work checks" data-ticket="${esc(id)}">${workerSection(id)}</div>`
    + `<div class="tile-checks" data-ticket="${esc(id)}">${checksSection(id)}</div>`
    + `<div class="artifacts">${avail.map(n => `<button data-n="${esc(n)}">${n === 'plan' ? 'PLANS/' + esc(plain) + '-plan.md' : esc(n)}</button>`).join('') || '<span class="placeholder">No artifacts for this step yet.</span>'}</div>`);
  bindJumps(el.querySelector('.tile-panes'));
  if (atPlanGate && !el.querySelector('.gate-plan')) { // a re-opened tile already has its plan
    bindJumps(el.querySelector('.tile-gate'));
    // The plan itself, inline under the question it's about.
    const key = el.dataset.key, plan = document.createElement('div');
    plan.className = 'gate-plan';
    plan.innerHTML = '<p class="placeholder">loading the plan…</p>';
    el.querySelector('.tile-body').append(plan);
    api(`/api/run-file?epic=${encodeURIComponent(epic)}&ticket=${encodeURIComponent(plain)}&name=plan${on}`)
      .then(text => { if (el.dataset.key === key) plan.innerHTML = `<div class="gate-plan-h">Plan</div>${mdHtml(text)}`; });
  }
  el.querySelectorAll('.artifacts button').forEach(b => b.onclick = () =>
    fileTile(`rf:${ref(t.machine, epic)}:${plain}:${b.dataset.n}`, `${plain} · ${b.textContent}`, t.machine ? `${epic} · ${t.machine}` : epic,
      `/api/run-file?epic=${encodeURIComponent(epic)}&ticket=${encodeURIComponent(plain)}&name=${encodeURIComponent(b.dataset.n)}${on}`));
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
    const run = findTicketAnywhere(i.identifier);
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

/* ---------- Inbox (lib/scan.mjs) ---------- */
// Teams meetings the calendar scan matched to a project whose transcript isn't filed there yet, grouped by
// project, plus the ones it couldn't match. A flag drops off by itself once a transcript for that day is in the
// project. New flags notify once: the first load only records what's already there.
let inboxSeen = null, inboxTimer = null;
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function renderInbox() {
  const b = state.inbox, el = $('#inbox');
  if (!b) return;
  $('#inbox-count').textContent = b.flags.length || '';
  renderViewTabs();
  if (!b.on && !b.last) {
    el.innerHTML = `<div class="placeholder">The scan is off. With <code>MC_SCAN=1</code> in .env, Cleon checks your calendar a few times a day
      (read-only, through Claude's Microsoft 365 connector) for Teams meetings whose transcript isn't filed in their project yet. See docs/PORTING.md.</div>`;
    return;
  }
  const l = b.last;
  const status = b.scanning ? 'Scanning your calendar…' : !l ? 'No scan yet.'
    : l.ok ? `Scanned ${ago(l.at)}: ${plural(l.found, 'meeting')}${l.complete === false ? ', not every page (read again next time)' : ''} · ${money(l.usd)}`
    : `The last scan failed ${ago(l.at)}: ${l.reason}`;
  const next = b.on && b.next && !b.scanning ? ` · next ${clock(b.next)}` : '';
  const access = { ok: 'Transcripts can be fetched: Ingest opens a Claude session that files one.',
    disabled: "Transcripts can't be fetched yet: Teams has transcript access through Microsoft Graph turned off (EnableGraphTranscriptAccess, set by IT). Download the VTT from the meeting's Recap.",
    error: `The transcript check failed (${b.transcriptError ?? 'no reason given'}). Download the VTT from the meeting's Recap.` }[b.transcripts]
    ?? 'Transcript access is checked on the next scan.';
  const card = (f, matched) => `<div class="card inbox-card${matched ? ' blocked' : ''}" data-id="${esc(f.id)}">
      <div class="t"><span class="inbox-subj" title="${esc(f.subject)}">${esc(f.subject)}</span><span class="s">${esc(day(f.start))} ${esc(clock(f.start))}</span></div>
      <div class="s">${esc(f.organizer ?? '')}${f.why ? ` · ${esc(f.why)}` : ''}</div>
      ${matched ? `<div class="s" title="${esc(`${f.folder}/${f.file}`)}: the folder holding most of this project's transcripts">file as ${esc(f.folder)}/${esc(f.file)}</div>` : ''}
      <div class="inbox-acts">${f.link ? `<a href="${esc(f.link)}" target="_blank" rel="noopener" title="Open the meeting in Outlook">Outlook</a>` : ''}
        ${matched && b.transcripts === 'ok' ? '<button class="ingest" title="Open a Claude session in the project that fetches and files this transcript">Ingest</button>' : ''}
        <button class="dismiss" title="Hide this one; it won't come back">Dismiss</button></div>
    </div>`;
  const groups = new Map();
  for (const f of b.flags) (groups.get(f.project) ?? groups.set(f.project, []).get(f.project)).push(f);
  const spent = b.month?.scans ? ` · ${plural(b.month.scans, 'scan')} in 30 days, ${money(b.month.usd)}` : '';
  el.innerHTML = `<div class="inbox-status"><span>${esc(status)}${esc(next)}</span>
      ${b.on ? `<button class="scan-now" ${b.scanning ? 'disabled' : ''} title="Scan now (a minute or two; it costs about what a scheduled one does)">Scan now</button>` : ''}</div>
    <div class="inbox-note">${esc(access)}${esc(spent)}</div>
    ${b.flags.length ? '' : '<div class="placeholder">No meetings waiting for a transcript.</div>'}
    ${[...groups].map(([p, fs]) => `<div class="group-h">${esc(p)} (${fs.length})</div>${fs.map(f => card(f, true)).join('')}`).join('')}
    ${b.unmatched.length ? `<details class="inbox-unmatched"><summary class="group-h">Not matched to a project (${b.unmatched.length})</summary>${b.unmatched.map(f => card(f, false)).join('')}</details>` : ''}`;
  el.querySelector('.scan-now')?.addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    const r = await inboxAct('/api/inbox/scan', {});
    toast(r.ok ? 'Scanning your calendar: a minute or two' : `Couldn't scan: ${r.reason}`, !r.ok);
    pollInbox();
  });
  el.querySelectorAll('.inbox-card').forEach(c => {
    c.querySelector('.dismiss').onclick = async () => {
      const r = await inboxAct('/api/inbox/dismiss', { id: c.dataset.id });
      if (!r.ok) toast(`Couldn't dismiss: ${r.reason}`, true);
      pollInbox();
    };
    const ingest = c.querySelector('.ingest');
    if (ingest) ingest.onclick = async () => {
      ingest.disabled = true;
      const r = await inboxAct('/api/inbox/ingest', { id: c.dataset.id });
      toast(r.ok ? `Opened a Claude session in herdr (${r.session}) to file the transcript` : `Couldn't start it: ${r.reason}`, !r.ok);
      ingest.disabled = false;
    };
  });
}
const inboxAct = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
async function pollInbox() {
  clearTimeout(inboxTimer);
  const b = await api('/api/inbox');
  if (b) {
    state.inbox = b;
    renderInbox();
    const ids = new Set(b.flags.map(f => f.id));
    const fresh = inboxSeen ? b.flags.filter(f => !inboxSeen.has(f.id)) : [];
    if (fresh.length) {
      const text = fresh.length === 1 ? `Transcript not filed: ${fresh[0].subject} (${fresh[0].project})` : `${fresh.length} meetings need their transcript filed`;
      toast(`Inbox: ${text}`, false, 8000);
      if (notifyOn && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification('Cleon — Inbox', { body: text, tag: `inbox:${fresh[0].id}` });
        n.onclick = () => { window.focus(); n.close(); };
      }
    }
    inboxSeen = ids;
  }
  inboxTimer = setTimeout(pollInbox, state.inbox?.scanning ? 5000 : 30000);
}

/* ---------- Waiting on (lib/waiting.mjs) ---------- */
// What you're waiting for from someone, overdue first. Each Inbox scan looks for the answer in mail and Teams; a
// likely one shows as "maybe answered" with a link, and only you close the item. An overdue item notifies once a
// day; a new "maybe answered" notifies once.
let waitEditing = null, waitMaybeSeen = null;
const dueText = d => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
function waitNotify(text, tag) {
  toast(text, false, 8000);
  if (notifyOn && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification('Cleon — Waiting on', { body: text, tag });
    n.onclick = () => { window.focus(); n.close(); };
  }
}
function renderWaiting() {
  const w = state.waiting;
  if (!w) return;
  $('#waiting-count').textContent = w.items.length || '';
  renderViewTabs();
  const sel = $('#wait-form select[name="project"]');
  const opts = w.projects.map(p => p.id).join('|');
  if (sel.dataset.opts !== opts) {
    const keep = sel.value;
    sel.innerHTML = '<option value="">No project</option>' + w.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    sel.dataset.opts = opts;
    sel.value = keep;
  }
  const names = new Map(w.projects.map(p => [p.id, p.name]));
  const note = !w.scanOn ? "The Inbox scan is off (MC_SCAN), so nothing looks for answers: close items yourself."
    : `Each Inbox scan looks for answers in mail and Teams${w.lastScan ? ` (last ${ago(w.lastScan)})` : ''}.`;
  $('#waiting').innerHTML = `<div class="inbox-note">${esc(note)}</div>` + (w.items.map(i => `<div class="card wait-card ${i.overdue ? 'blocked' : i.maybe ? 'idle' : ''}" data-id="${esc(i.id)}">
      <div class="t"><span class="inbox-subj" title="${esc(i.what)}">${esc(i.what)}</span><span class="s">${i.days ? `${plural(i.days, 'day')}` : 'today'}</span></div>
      <div class="s">from ${esc(i.who)}${i.project ? ` · ${esc(names.get(i.project) ?? i.project)}` : ''}${i.due ? ` · <span class="${i.overdue ? 'wait-late' : ''}">${i.overdue ? 'overdue, ' : ''}due ${esc(dueText(i.due))}</span>` : ''}</div>
      ${i.maybe ? `<div class="s wait-maybe">Maybe answered${i.maybe.from ? ` by ${esc(i.maybe.from)}` : ''}${i.maybe.at ? ` ${ago(i.maybe.at)}` : ''}${i.maybe.why ? `: ${esc(i.maybe.why)}` : ''}</div>` : ''}
      <div class="inbox-acts">${i.maybe?.link ? `<a href="${esc(i.maybe.link)}" target="_blank" rel="noopener" title="Open the message">Message</a>` : ''}
        <button class="close" title="Done: you have it">Close</button>${i.maybe ? '<button class="not-yet" title="That message wasn\'t the answer: keep waiting">Not yet</button>' : ''}
        <button class="edit dismiss">Edit</button></div>
    </div>`).join('') || '<div class="placeholder">Nothing you\'re waiting on. Add what you\'re waiting for above.</div>');
  $('#waiting').querySelectorAll('.wait-card').forEach(c => {
    const i = w.items.find(x => x.id === c.dataset.id);
    c.querySelector('.close').onclick = () => waitAct('/api/waiting/close', { id: i.id }, 'close');
    const ny = c.querySelector('.not-yet');
    if (ny) ny.onclick = () => waitAct('/api/waiting/not-yet', { id: i.id }, 'clear');
    c.querySelector('.edit').onclick = () => {
      const f = $('#wait-form');
      waitEditing = i.id;
      f.what.value = i.what; f.who.value = i.who; f.project.value = i.project ?? ''; f.due.value = i.due ?? '';
      f.querySelector('[type="submit"]').textContent = 'Save';
      f.querySelector('.cancel').hidden = false;
      f.what.focus();
    };
  });
}
function waitFormReset() {
  const f = $('#wait-form');
  f.reset();
  waitEditing = null;
  f.querySelector('[type="submit"]').textContent = 'Add';
  f.querySelector('.cancel').hidden = true;
}
async function waitAct(url, body, what) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
  if (!r.ok) toast(`Couldn't ${what} it: ${r.reason}`, true);
  await pollWaiting();
  return r;
}
$('#wait-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const r = await waitAct('/api/waiting/save', { id: waitEditing ?? undefined, what: f.what.value, who: f.who.value, project: f.project.value, due: f.due.value }, 'save');
  if (r.ok) waitFormReset();
});
$('#wait-form .cancel').onclick = waitFormReset;
async function pollWaiting() {
  const w = await api('/api/waiting');
  if (!w) return;
  state.waiting = w;
  renderWaiting();
  // Notices: each overdue item once a day, and each newly maybe-answered one once (not on the first load).
  const today = new Date().toDateString();
  let told = {};
  try { told = JSON.parse(localStorage.getItem('mc.waitNotified')) ?? {}; } catch { /* nothing remembered */ }
  for (const i of w.items.filter(i => i.overdue && told[i.id] !== today)) { waitNotify(`Overdue: ${i.what} (from ${i.who})`, `wait:${i.id}`); told[i.id] = today; }
  try { localStorage.setItem('mc.waitNotified', JSON.stringify(Object.fromEntries(Object.entries(told).filter(([id]) => w.items.some(i => i.id === id))))); } catch { /* not remembered */ }
  const maybe = new Set(w.items.filter(i => i.maybe).map(i => i.id));
  if (waitMaybeSeen) for (const i of w.items.filter(i => i.maybe && !waitMaybeSeen.has(i.id))) waitNotify(`Maybe answered: ${i.what}${i.maybe.from ? ` (${i.maybe.from})` : ''}`, `wait-maybe:${i.id}`);
  waitMaybeSeen = maybe;
}

/* ---------- Groom queue (lib/groom.mjs) ---------- */
// Everything waiting to be set up, grouped by kind, with the same actions on each item where they apply. The server
// works out what an action does from the item's key; the page only names the action.
const GROOM_GROUPS = { waiting: 'Waiting on', review: 'Review requests', transcript: 'Meetings to file', linear: 'Linear to fill out' };
function renderGroom() {
  const g = state.groom;
  if (!g) return;
  $('#groom-count').textContent = g.items.length || '';
  renderViewTabs();
  const card = i => `<div class="card groom-card" data-key="${esc(i.key)}">
      <div class="t"><span class="inbox-subj" title="${esc(i.title)}">${esc(i.title)}</span><span class="s">${ago(i.at)}</span></div>
      <div class="s" title="${esc(i.sub)}">${esc(i.sub)}</div>
      <div class="inbox-acts">
        ${i.actions.includes('do') ? (i.doLabel === 'Ingest' ? '<button data-act="do" title="Open a Claude session in the project that fetches and files the transcript">Ingest</button>'
          : `<a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.doLabel)}</a>`) : ''}
        ${i.actions.includes('ticket') ? '<button data-act="ticket" title="Open a Claude session in its project running /new-task; you say what the ticket is for">Make a ticket</button>' : ''}
        ${i.actions.includes('wait') ? `<button data-act="wait" title="Track it in Waiting on, from ${esc(i.who)}">Wait on it</button>` : ''}
        ${i.actions.includes('snooze') ? '<span class="groom-snooze">snooze <button data-act="snooze-tomorrow" title="Hide until 8:00 tomorrow">Tomorrow</button><button data-act="snooze-monday" title="Hide until 8:00 next Monday">Monday</button></span>' : ''}
        ${i.actions.includes('dismiss') ? `<button class="dismiss" data-act="dismiss" title="${i.kind === 'waiting' ? 'Close it in Waiting on' : 'Hide it for good'}">${i.kind === 'waiting' ? 'Close' : 'Dismiss'}</button>` : ''}
      </div></div>`;
  const groups = Object.entries(GROOM_GROUPS).map(([k, label]) => [label, g.items.filter(i => i.kind === k)]).filter(([, is]) => is.length);
  $('#groom').innerHTML = (g.missing.length ? `<div class="inbox-note">Not read: ${esc(g.missing.join('; '))}.</div>` : '')
    + (groups.map(([label, is]) => `<div class="group-h">${esc(label)} (${is.length})</div>${is.map(card).join('')}`).join('')
      || '<div class="placeholder">Nothing to groom.</div>');
  $('#groom').querySelectorAll('.groom-card [data-act]').forEach(b => b.onclick = async () => {
    const key = b.closest('.groom-card').dataset.key, action = b.dataset.act;
    b.disabled = true;
    const r = await fetch('/api/groom/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, action }) })
      .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
    if (!r.ok) toast(`Couldn't ${b.textContent.toLowerCase()}: ${r.reason}`, true);
    else if (r.session) toast(`Opened a Claude session in herdr (${r.session})${action === 'ticket' ? ' running /new-task' : ''}`);
    else if (action === 'wait') toast('Added to Waiting on');
    await Promise.all([pollGroom(), pollInbox(), pollWaiting()]);
  });
}
async function pollGroom() {
  const g = await api('/api/groom');
  if (!g) return;
  state.groom = g;
  renderGroom();
}

/* ---------- Exec summary (lib/exec.mjs) ---------- */
// One card per decision: the number, last week's, the change (green when it moved the good way), what to do about it,
// and where it comes from. Read only while the panel is on the board.
function renderExec() {
  const e = state.exec;
  if (!e) return;
  $('#exec-at').textContent = `built ${ago(e.at)}`;
  const tone = c => !c.change || ['same', 'new'].includes(c.change) || !c.good ? '' : (c.change.startsWith('-') === (c.good === 'down') ? 'exec-good' : 'exec-bad');
  $('#exec').innerHTML = e.cards.map(c => `<div class="exec-card" data-card="${esc(c.id)}">
      <div class="res-label">${esc(c.title)}</div>
      <div class="exec-value">${esc(c.value)}${c.change ? ` <span class="exec-change ${tone(c)}">${esc(c.change)}</span>` : ''}</div>
      <div class="res-sub">${c.prev != null ? `last week ${esc(c.prev)}` : 'last week: not recorded yet'}</div>
      ${c.sub ? `<div class="res-sub" title="${esc(c.sub)}">${esc(c.sub)}</div>` : ''}
      <div class="exec-action">${esc(c.action)}</div>
      <div class="exec-source">${esc(c.source)}</div>
    </div>`).join('');
}
async function pollExec() {
  if (!isOpen('exec')) return;
  state.exec = await api('/api/exec') ?? state.exec;
  renderExec();
}

/* ---------- GitHub ---------- */
function renderGithub() {
  const g = state.github;
  $('button[data-tab="github"]').firstChild.textContent = `${scmName()} `;
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
    }) + linkOut(item.url) + (kind === 'mine' ? `<div class="tile-checks" data-ticket="${esc(`pr:${item.url}`)}">${checksSection(`pr:${item.url}`)}</div>` : ''), item.body);
  });
}

/* ---------- Waiting on you: one list, shown in the header count and the tab title, and notified ---------- */
// Everything that needs your input: plan/review gates you haven't handed off, orchestrators and
// workers asking you something or listing "(you)" items, and GitHub review requests.
function alerts() {
  const out = [];
  // A peer's items say which machine they're on (` · worker`) and are keyed by ref.
  const on = m => (m ? ` · ${m}` : '');
  for (const r of state.runs?.runs ?? []) for (const t of r.tickets) {
    if (t.stale || t.held || mergeApproved(t, r.epic, r.machine) || awaitingCi(t) || !['plan-gate', 'human-review'].includes(t.step)) continue;
    out.push({ key: `gate:${ref(r.machine, t.ticket)}:${t.step}`, text: `${t.ticket}${on(r.machine)}: ${t.step === 'plan-gate' ? 'plan ready for your approval' : 'PR ready for your review/merge'}` });
  }
  const ask = (n, id) => n.ask ?? dialogLine(attentionFor(id)) ?? 'a question is open in its pane';
  for (const o of state.orch ?? []) if (o.needsYou)
    out.push({ key: `orch:${ref(o.machine, o.epic)}:${ask(o.needsYou, o.sessionId)}`, text: `${o.epic} orchestrator${on(o.machine)}: ${ask(o.needsYou, o.sessionId)}` });
  for (const [k, w] of Object.entries(state.workers ?? {})) if (w.needsYou && !atGate(k))
    out.push({ key: `work:${k}:${ask(w.needsYou, w.sessionId)}`, text: `${unref(k)[1]}${on(w.machine)}: ${ask(w.needsYou, w.sessionId)}` });
  const covered = new Set([...(state.orch ?? []).map(o => o.sessionId), ...Object.values(state.workers ?? {}).map(w => w.sessionId)]);
  for (const a of state.attention ?? []) if (!covered.has(a.sessionId))
    out.push({ key: `ask:${a.sessionId}:${a.question ?? a.items?.[0] ?? 'open'}`,
      text: `${a.name}${on(a.machine)}: ${dialogLine(a) ?? a.items?.[0] ?? 'a question is open in its pane'}${a.items?.length > 1 ? ` (+${a.items.length - 1} more)` : ''}` });
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
// Keep the screen awake (opt-in, ＋ Panels): a browser screen wake lock. The browser drops it whenever this
// window is hidden or minimized, so it's taken again each time the window shows.
let wakeOn = (() => { try { return localStorage.getItem('mc.wake') === 'on'; } catch { return false; } })();
let wakeLock = null, wakePending = false;
async function holdWake() {
  if (!wakeOn || wakeLock || wakePending || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  wakePending = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* refused (e.g. battery saver); tried again the next time the window shows */ }
  wakePending = false;
}
async function setWake(on) {
  wakeOn = on;
  try { localStorage.setItem('mc.wake', on ? 'on' : 'off'); } catch { /* not remembered */ }
  if (on) await holdWake(); else { await wakeLock?.release(); wakeLock = null; }
}
document.addEventListener('visibilitychange', holdWake);
holdWake();

function notifyAlerts(list) {
  document.title = list.length ? `(${list.length}) Cleon` : 'Cleon';
  if (state.alertCount !== list.length) { state.alertCount = list.length; renderViewTabs(); }
  setFaviconWaiting(list.length);
  // Wait until every source has loaded once, or half the list would look "new" on the next poll.
  if (!state.runs || !state.orch || !state.workers || !state.attention) return;
  const keys = new Set(list.map(a => a.key));
  if (alertSeen && notifyOn && 'Notification' in window && Notification.permission === 'granted') {
    for (const a of list) if (!alertSeen.has(a.key)) {
      const n = new Notification('Cleon — needs you', { body: a.text, tag: a.key });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }
  alertSeen = keys;
}

/* ---------- Window icon: the eye, drawn live ---------- */
// Calm: a cyan eye, drawn once. Something waiting on you: the eye turns magenta and a sonar ping pulses
// out from the pupil, ~12 frames a second, only while there's something waiting. It pulses, never spins.
// Mirrors scripts/make-icon.py.
const favCanvas = document.createElement('canvas');
favCanvas.width = favCanvas.height = 64;
let favWaiting = 0, favTimer = null, favLast = '';
function drawFavicon(t) {
  const c = favCanvas.getContext('2d'), S = 64, C = S / 2, k = S * 0.58, lc = 0.448 * k, lr = 0.848 * k, la = Math.atan2(0.448, 0.72);
  const color = favWaiting ? '#ff4fd8' : '#3ef0ff', rgb = favWaiting ? '255,79,216' : '62,240,255';
  c.clearRect(0, 0, S, S);
  const plate = c.createLinearGradient(0, 0, 0, S);
  plate.addColorStop(0, '#0a1628'); plate.addColorStop(1, '#050a14');
  c.fillStyle = plate; c.beginPath(); c.roundRect(1, 1, S - 2, S - 2, 13); c.fill();
  c.beginPath();                                        // the eye: two lid arcs meeting at the corners
  c.arc(C, C + lc, lr, -Math.PI + la, -la);
  c.arc(C, C - lc, lr, la, Math.PI - la);
  c.closePath();
  c.fillStyle = '#040e1a'; c.fill();
  c.strokeStyle = color; c.lineWidth = 3.5; c.shadowColor = color; c.shadowBlur = 6; c.stroke();
  c.save(); c.clip();
  c.fillStyle = `rgba(${rgb},.18)`; c.beginPath(); c.arc(C, C, 0.28 * k, 0, 2 * Math.PI); c.fill();
  c.lineWidth = 4; c.beginPath(); c.arc(C, C, 0.28 * k, 0, 2 * Math.PI); c.stroke();  // iris
  c.shadowBlur = 0;
  c.fillStyle = '#02060c'; c.beginPath(); c.arc(C, C, 0.12 * k, 0, 2 * Math.PI); c.fill();  // pupil
  c.restore();
  if (favWaiting) {                                    // sonar ping from the pupil
    const p = (t % 1200) / 1200;
    c.strokeStyle = `rgba(255,79,216,${1 - p})`; c.lineWidth = 2;
    c.beginPath(); c.arc(C, C, 0.3 * k + p * 0.6 * k, 0, 2 * Math.PI); c.stroke();
  }
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
  $('#stats').innerHTML = stats.map(([n, l, hot]) => `<span class="stat ${hot ? 'hot' : ''}" ${l === 'waiting on you' && waiting.length ? `title="${esc(waiting.map(a => a.text).join('\n'))}"` : ''}><b>${n}</b>${l}</span>`).join('')
    // Each peer (MC_PEERS): up, or why not. While one is down its rows aren't shown, so this says so.
    // Each links to that peer's own Cleon page (through its tunnel).
    + (state.peers ?? []).map(p => { const tag = p.url ? 'a' : 'span';
      return `<${tag} class="stat peer ${p.online ? '' : 'off'}"${p.url ? ` href="${esc(p.url)}/" target="_blank" rel="noopener"` : ''} title="${esc(peerNote(p))}"><b>${p.online ? '●' : '○'}</b>${esc(p.name)}${p.online ? '' : ' offline'}</${tag}>`; }).join('');
}
// A peer's tooltip. Up, it can still lack an endpoint (an older Cleon) or fail one: those rows alone are left out.
const peerNote = p => (!p.online ? `${p.name}'s Cleon at ${p.url ?? '(no port yet)'} isn't answering (${p.error}). Its rows are hidden until it does.`
  : `${p.name}'s Cleon at ${p.url}: its rows show here, tagged ${p.name}. Click to open its page.`
    + (p.missing?.length ? `\nIt's on an older Cleon, without ${p.missing.join(', ')}. Update it to show those here too.` : '')
    + (p.failing?.length ? `\n${p.failing.map(f => `${f.path} answered HTTP ${f.status}`).join(', ')}, so those rows are left out.` : ''))
  + (p.tunnel ? `\n${tunnelNote(p.tunnel)}` : '');
// The SSH tunnel this Cleon runs to a peer (MC_PEERS name=ssh://<host>): running, or why not and when it tries again.
const tunnelNote = t => `SSH tunnel to ${t.target}, on port ${t.port}: ${t.state === 'running' ? 'running'
  : t.state === 'waiting' ? `down, trying again ${t.retryAt > Date.now() ? `in ${Math.ceil((t.retryAt - Date.now()) / 1000)} s` : 'now'}` : t.state}`
  + (t.error && (t.state !== 'running' || t.restarts) ? `. ssh said: ${t.error}` : '')
  + (t.state === 'waiting' && /permission denied/i.test(t.error ?? '') ? " (a refused key: tried again once a minute, so the peer's sshd doesn't block this machine)" : '');
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 1000);

/* ---------- Knowledge map: MC_ROOT at the centre, then its categories, each project and its documents ---------- */
// One level at a time: the centre and its children, nothing else (the tree comes from lib/knowledge.mjs). Clicking a
// node makes it the centre; the breadcrumb goes back up. Positions are computed, not simulated, and nodes can't be
// dragged, so nothing moves under the cursor. A project with uncommitted changes pulses amber (work in progress);
// clean is green; no repo is dim. That state comes from the Projects poll (/api/projects, every 60 s).
const PMAP_STATE = { clean: ['#4dff9a', 'clean'], dirty: ['#ffb547', 'uncommitted changes'], norepo: ['#6c84a3', 'no repo'] };
const pmapState = p => !p.repo ? 'norepo' : p.dirty ? 'dirty' : 'clean';
// One colour per group, for the group, its documents and the legend below project level.
const KM_GROUPS = { docs: ['#ffb547', 'Docs & decisions'], comms: ['#3ef0ff', 'Comms & meetings'], outputs: ['#4dff9a', 'Outputs'], memory: ['#ff4fd8', 'Claude memory'] };
const legendHtml = entries => entries.map(([c, l]) => `<span><i style="background:${c};box-shadow:0 0 6px ${c}"></i>${esc(l)}</span>`).join('');

let kmap = null, kmData = null, kmShape = '', kmNodes = new Map(), kmCentre = 'root', kmCols = false, kmLines = [];
// id → { node, parent id }: the breadcrumb, an item's project and group, and the way back up after a rescan.
function kmIndex(tree) {
  const m = new Map();
  const walk = (n, parent) => { m.set(n.id, { node: n, parent }); n.children?.forEach(c => walk(c, n.id)); };
  walk(tree, null);
  return m;
}
const kmParent = id => kmNodes.get(kmNodes.get(id)?.parent)?.node ?? null;
const kmPath = id => { const out = []; for (let x = id; kmNodes.has(x); x = kmNodes.get(x).parent) out.unshift(kmNodes.get(x).node); return out; };
// A project's description and git state from the Projects poll, found by path; until it arrives, what the tree says.
let kmProjOf = null, kmProjBy = new Map();
function kmProject(t) {
  if (kmProjOf !== state.projects) { kmProjOf = state.projects; kmProjBy = new Map(state.projects.map(p => [p.path, p])); }
  return kmProjBy.get(t.path) ?? { name: t.name, category: t.category, path: t.path };
}
// Nothing in it to drill into: dimmed, and clicks pass it by.
const kmEmpty = t => (t.kind === 'group' || t.kind === 'cat') && !t.count;
const KM_CLIP = 44, KM_RING = 14, KM_ROW = 20;
const kmClip = s => s.length > KM_CLIP ? `${s.slice(0, KM_CLIP - 1)}…` : s;
function kmLabel(t) {
  if (t.kind === 'root') return t.name;
  if (t.kind === 'item') return kmClip(t.name) + (t.versions?.length > 1 ? ` ×${t.versions.length}` : '') + (t.status ? ` · ${t.status}` : '') + (t.draft ? ' · draft' : '');
  return `${kmClip(t.name)} (${t.more ? '400+' : t.count})`;
}
const kmTip = t => t.kind === 'root' ? kmData?.root ?? t.name : t.kind === 'cat' ? `${t.name}: ${t.count} projects`
  : t.kind === 'proj' ? t.path : t.kind === 'group' ? `${t.name}: ${t.more ? '400+' : t.count} items`
  : [t.rel, t.versions ? `${t.versions.length} versions, newest shown` : '', t.status ? `status: ${t.status}` : '', t.draft ? 'draft' : ''].filter(Boolean).join(' · ');
const kmGroupOf = t => t.kind === 'group' ? t.group : t.kind === 'item' ? kmParent(t.id)?.group : null;

// The centre at 0,0 and its children, for zoom k: up to 14 in a ring with labels running outward, more in columns to
// its right, one label per row. Columns take as many rows as the panel's height holds at that zoom, then share the
// children evenly (25 in columns of up to 24 are two of 13, not 24 and 1). Labels are drawn 1/sqrt(k) graph units per
// pixel of text, so their room (and the column width) depends on k too. Returns the nodes and the box they and their
// labels fill.
function kmLayout(c, k, height) {
  const kids = c.children ?? [], s = Math.sqrt(k), g = kmGroupOf(c), cols = kids.length > KM_RING;
  const nodes = [{ id: c.id, t: c, g, centre: true, x: 0, y: 0 }];
  let box;
  if (!cols) {
    const R = Math.max(110, 16 * kids.length);
    kids.forEach((t, i) => {
      const a = -Math.PI / 2 + 2 * Math.PI * (i + 0.5) / kids.length;
      nodes.push({ id: t.id, t, g: t.group ?? g, x: R * Math.cos(a), y: R * Math.sin(a) });
    });
    const lw = 14 + 6.2 * Math.max(0, ...kids.map(t => kmLabel(t).length)) / s, cw = 12 + 3.4 * kmLabel(c).length / s;
    box = kids.length ? { x0: -R - lw, x1: R + lw, y0: -R - 30 / s, y1: R + 30 / s } : { x0: -cw, x1: cw, y0: -24, y1: 24 + 16 / s };
  } else {
    const rowsMax = Math.min(40, Math.max(8, Math.floor((height / k - 40) / KM_ROW)));
    const ncols = Math.ceil(kids.length / rowsMax), perCol = Math.ceil(kids.length / ncols);
    const colW = 30 + 6.2 * Math.max(...kids.map(t => kmLabel(t).length)) / s;
    kids.forEach((t, i) => nodes.push({ id: t.id, t, g: t.group ?? g, x: 90 + Math.floor(i / perCol) * colW, y: (i % perCol - (perCol - 1) / 2) * KM_ROW }));
    const cw = 24 + 6.8 * kmLabel(c).length / s, h = (perCol - 1) / 2 * KM_ROW + 20 / s; // the centre's label is on its left
    box = { x0: -cw, x1: 90 + ncols * colW, y0: -h, y1: h };
  }
  for (const n of nodes) { n.fx = n.x; n.fy = n.y; }
  return { nodes, box, cols };
}

// Lay the centre out and zoom to fit it, labels included, but never below 0.7 for a ring or 0.9 for columns, so labels
// stay legible: a group too wide for that shows its left end (the centre and the first columns), and the rest pans.
// A ring's place doesn't change with the zoom, so its fit is refined a few times. Columns do change (rows and widths
// follow the zoom), so they take the largest zoom, from 2.5 down in steps of 0.05, whose own layout fits the panel.
function kmShow(animate = true) {
  const el = $('#kmap'), c = kmNodes.get(kmCentre)?.node;
  if (!kmap || !c || !el.clientWidth || !el.clientHeight) return;
  const W = el.clientWidth, H = el.clientHeight;
  let k = 1, lay;
  if ((c.children?.length ?? 0) > KM_RING) {
    for (let i = 0; ; i++) {
      k = Math.round((2.5 - 0.05 * i) * 100) / 100;
      lay = kmLayout(c, k, H);
      const b = lay.box;
      if (k <= 0.9 || ((b.x1 - b.x0) * k <= W && (b.y1 - b.y0) * k <= H)) break;
    }
  } else {
    const fit = b => Math.min(2.5, Math.max(0.7, Math.min(W / (b.x1 - b.x0), H / (b.y1 - b.y0))));
    for (let i = 0; i < 3; i++) k = fit(kmLayout(c, k, H).box);
    lay = kmLayout(c, k, H);
  }
  const b = lay.box, ms = animate ? 400 : 0;
  kmCols = lay.cols;
  kmLines = lay.nodes.slice(1); // the centre's lines to them, drawn in kmInit
  kmap.graphData({ nodes: lay.nodes, links: [] });
  kmap.centerAt((b.x1 - b.x0) * k > W ? b.x0 + W / (2 * k) : (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, ms);
  kmap.zoom(k, ms);
}

// The breadcrumb (each level above the centre goes back to it) and the legend for what's showing.
function kmChrome() {
  const path = kmPath(kmCentre), c = path.at(-1);
  $('#km-crumbs').innerHTML = path.map((t, i) => i < path.length - 1
    ? `<button data-id="${esc(t.id)}" title="${esc(kmTip(t))}">${esc(t.name)}</button><span class="sep">›</span>`
    : `<span class="here" title="${esc(kmTip(t))}">${esc(t.name)}</span>`).join('');
  $('#km-legend').innerHTML = legendHtml(Object.values(c.kind === 'root' || c.kind === 'cat' ? PMAP_STATE : KM_GROUPS));
}
$('#km-crumbs').onclick = e => { const id = e.target.closest('button[data-id]')?.dataset.id; if (id) kmGo(id); };
function kmGo(id) {
  if (!kmNodes.has(id)) return;
  kmCentre = id;
  kmChrome(); kmShow();
}
// A click makes a node the centre; a project or a document also opens its tile (clicking the centre opens it again).
function kmClick(t) {
  if (kmEmpty(t)) return;
  if (t.id !== kmCentre) kmGo(t.id);
  if (t.kind === 'proj') projectTile(kmProject(t));
  if (t.kind === 'item') {
    const g = kmParent(t.id), p = g && kmParent(g.id);
    const el = tile(`file:${t.file}`, t.name, `${p?.name ?? ''} · ${g?.name ?? ''}`, '<p class="placeholder">loading…</p>');
    showFile(el, t.file);
  }
}

async function kmLoad(refresh) {
  const d = await api(`/api/knowledge${refresh ? '?refresh=1' : ''}`);
  if (!d?.tree) return; // server unreachable (stopping or restarting): keep what's shown
  kmData = d;
  $('#km-count').textContent = `${d.tree.count} project${d.tree.count === 1 ? '' : 's'} in ${d.root}`;
  if (!kmap) kmInit();
  const shape = JSON.stringify(d.tree);
  if (shape !== kmShape) {
    kmShape = shape;
    const was = kmNodes;
    kmNodes = kmIndex(d.tree);
    // A rescan can drop the centre (a file renamed, a folder emptied): go to the nearest level above that's still there.
    let id = kmCentre;
    while (id && !kmNodes.has(id)) id = was.get(id)?.parent;
    kmCentre = id ?? 'root';
    kmChrome(); kmShow();
  }
  renderPmapRecent();
}
const kmTick = single(kmLoad);
$('#km-refresh').onclick = () => kmLoad(true);
setInterval(() => { if (isOpen('knowledge')) kmTick(); }, 60000);

// A label on the far side of its node from the centre, so labels fan outward instead of colliding.
function radialLabel(ctx, n, gap, text) {
  const a = Math.atan2(n.y, n.x), c = Math.cos(a), s = Math.sin(a);
  ctx.textAlign = c > 0.35 ? 'left' : c < -0.35 ? 'right' : 'center';
  ctx.textBaseline = s > 0.35 ? 'top' : s < -0.35 ? 'bottom' : 'middle';
  ctx.fillText(text, n.x + c * gap, n.y + s * gap);
}

const kmRadius = n => (n.centre ? 1.5 : 1) * { root: 12, cat: 7, proj: 5, group: 7, item: 4 }[n.t.kind];
// Where a node takes clicks at zoom `scale`, or null (empty groups take none): a circle round its dot or, in a column of
// names, one rectangle from the dot's left edge to the label's end, at least as tall as the dot (the label is what you
// aim at). One shape per node: a circle and a rectangle overlapping would leave a 1-px seam on force-graph's hit canvas,
// a colour that maps to no node.
function kmHitShape(n, scale) {
  if (kmEmpty(n.t)) return null;
  const r = kmRadius(n) + 3;
  if (!kmCols || n.centre) return { r };
  const w = 12 + 6.2 * kmLabel(n.t).length / Math.sqrt(scale), h = Math.min(KM_ROW - 2, Math.max(2 * r, 14 / Math.sqrt(scale)));
  return { x: n.x - r, y: n.y - h / 2, w: r + w, h };
}
// The node a click lands on, from the nodes as they're drawn now. force-graph's own answer comes from its hit canvas,
// which it repaints at most every 800 ms, and a re-centre hands the new nodes the old ones' colours: for up to a second
// after one, a click named whichever new node had the colour under the pointer (a double-click on a category opened
// one of its projects) or none. The second half of a double-click isn't another click.
let kmLastClick = null;
function kmClickAt(ev) {
  const again = kmLastClick && ev.timeStamp - kmLastClick.at < 500 && Math.hypot(ev.clientX - kmLastClick.x, ev.clientY - kmLastClick.y) < 6;
  kmLastClick = { at: ev.timeStamp, x: ev.clientX, y: ev.clientY };
  if (again) return;
  const box = $('#kmap').getBoundingClientRect(), k = kmap.zoom(), p = kmap.screen2GraphCoords(ev.clientX - box.left, ev.clientY - box.top);
  const n = kmap.graphData().nodes.findLast(n => {
    const s = kmHitShape(n, k);
    return s && (s.r ? Math.hypot(p.x - n.x, p.y - n.y) <= s.r : p.x >= s.x && p.x <= s.x + s.w && Math.abs(p.y - n.y) <= s.h / 2);
  });
  if (n) kmClick(n.t);
}
function kmInit() {
  const el = $('#kmap');
  let hovered = null;
  kmap = new ForceGraph(el)
    .width(el.clientWidth).height(el.clientHeight)
    .backgroundColor('rgba(0,0,0,0)')
    .enableNodeDrag(false).autoPauseRedraw(false).cooldownTicks(0)
    .onNodeHover(n => { hovered = n; el.style.cursor = n && !kmEmpty(n.t) ? 'pointer' : ''; })
    .nodeCanvasObject((n, ctx, scale) => drawNode(n, ctx, scale))
    // Hover (cursor, tooltip) goes by force-graph's hit canvas; clicks go by kmClickAt.
    .nodePointerAreaPaint((n, color, ctx, scale) => {
      const s = kmHitShape(n, scale);
      if (!s) return;
      ctx.fillStyle = color;
      if (s.r) { ctx.beginPath(); ctx.arc(n.x, n.y, s.r, 0, 2 * Math.PI); ctx.fill(); } else ctx.fillRect(s.x, s.y, s.w, s.h);
    })
    .nodeLabel(n => esc(kmTip(n.t)))
    // The lines from the centre (always at 0,0) to its children are drawn here, under the nodes, rather than given to
    // force-graph as links: it hit-tests links on its shadow canvas whatever their pointer area, and one running
    // through a dot's middle took that dot's clicks. 0.8 px wide at any zoom, as force-graph draws a link.
    .onRenderFramePre((ctx, scale) => {
      ctx.save();
      ctx.strokeStyle = kmCols ? 'rgba(62,240,255,0.1)' : 'rgba(62,240,255,0.3)'; ctx.lineWidth = 0.8 / scale;
      ctx.beginPath();
      for (const n of kmLines) { ctx.moveTo(0, 0); ctx.lineTo(n.x, n.y); }
      ctx.stroke(); ctx.restore();
    })
    .onNodeClick((n, ev) => kmClickAt(ev)).onBackgroundClick(kmClickAt);
  new ResizeObserver(() => { kmap.width(el.clientWidth).height(el.clientHeight); kmShow(false); }).observe(el);

  function drawNode(n, ctx, scale) {
    const t = n.t, s = Math.sqrt(scale), r = kmRadius(n), hot = n === hovered;
    ctx.globalAlpha = kmEmpty(t) ? 0.3 : 1;
    if (t.kind === 'root') {
      ctx.shadowColor = '#3ef0ff'; ctx.shadowBlur = 18; ctx.fillStyle = '#3ef0ff';
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#04060c'; ctx.font = `600 ${Math.max(7, 9 / s)}px Orbitron, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t.name, n.x, n.y);
      ctx.globalAlpha = 1;
      return;
    }
    const st = t.kind === 'proj' ? pmapState(kmProject(t)) : null;
    const c = t.kind === 'cat' ? '#3ef0ff' : st ? PMAP_STATE[st][0] : KM_GROUPS[n.g]?.[0] ?? '#3ef0ff';
    if (st === 'dirty') { // breathing amber halo: work in progress
      const k = (Math.sin(performance.now() / 1000 * 2.4) + 1) / 2, a = ctx.globalAlpha;
      ctx.globalAlpha = a * (0.25 + 0.35 * k); ctx.strokeStyle = c; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 2 + 4 * k, 0, 2 * Math.PI); ctx.stroke(); ctx.globalAlpha = a;
    }
    ctx.shadowColor = c; ctx.shadowBlur = hot ? 16 : 7;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    if (t.kind === 'cat' || t.kind === 'group') { ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.stroke(); } // rings: something to open
    else { ctx.fillStyle = c; ctx.fill(); }
    ctx.shadowBlur = 0;
    ctx.fillStyle = hot ? '#ffffff' : '#cfe7ff';
    ctx.font = `${t.kind === 'cat' || n.centre ? '600 ' : ''}${(t.kind === 'cat' ? 11 : 10) / s}px JetBrains Mono, monospace`;
    const label = kmLabel(t);
    if (n.centre && kmCols) { ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(label, n.x - r - 6, n.y); }
    else if (n.centre) { ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(label, n.x, n.y + r + 10); } // below a dirty project's halo
    else if (kmCols) { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, n.x + r + 4, n.y); } // one row per label
    else radialLabel(ctx, n, r + 4, label);
    ctx.globalAlpha = 1;
  }
}

// A project's tile: what it is, its git state, and buttons that open it in herdr, Git Bash or VS Code.
function projectTile(p) {
  const st = pmapState(p);
  const el = tile(`pmap:${p.path}`, p.name, p.category, `
    <p class="pmap-desc">${p.description ? esc(p.description) : '<span class="placeholder">No description (no README, CLAUDE.md or package.json description, or the folder is excluded).</span>'}</p>
    <div class="pmap-open">
      <button data-app="herdr" title="Focus the herdr pane in this folder, or open its own herdr session here in a Git Bash window">▸ herdr</button>
      <button data-app="bash" title="Open Git Bash in this folder, running Claude Code">▸ bash</button>
      <button data-app="vscode" title="Open this folder in VS Code">▸ VS Code</button>
    </div>
    ${dl({ path: esc(p.path), state: `<span style="color:${PMAP_STATE[st][0]}">${PMAP_STATE[st][1]}${p.dirty ? ` (${p.dirty} files)` : ''}</span>`,
      branch: esc(p.branch ?? '—'), 'last commit': p.repo ? `${esc(p.lastSubject ?? '—')} (${ago(p.lastCommitAt)})` : '—' })}`);
  el.querySelectorAll('[data-app]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const r = await fetch('/api/project/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p.path, app: b.dataset.app }) })
      .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
    b.disabled = false;
    if (r.ok) pmapOpened(p, b.dataset.app);
    const app = PMAP_APPS[b.dataset.app];
    const behind = r.raised ? '' : ' — check the taskbar';
    toast(!r.ok ? `Couldn't open ${p.name} in ${app}: ${r.reason}`
      : b.dataset.app === 'herdr' ? (r.created ? `Started herdr session ${r.session} in a Git Bash window${r.claude ? ', with Claude' : ''}${behind}`
        : r.attached ? `Attached herdr session ${r.session} in a Git Bash window${behind}`
        : `Focused ${p.name}'s pane in herdr (${r.session})${r.raised ? ` — raised ${r.raised}` : ' — switch to its window'}`)
      : b.dataset.app === 'vscode' ? `Opened ${p.name} in VS Code${behind}`
      : `Opened Git Bash with Claude in ${p.name}${behind}`, !r.ok);
  });
}
// The projects last opened from the map, newest first, down its right side (kept in this browser only).
// Clicking one goes to it and opens its tile, as clicking its node does.
const PMAP_APPS = { herdr: 'herdr', bash: 'Git Bash', vscode: 'VS Code' }, PMAP_RECENT = 12;
let pmapRecent = (() => { try { const r = JSON.parse(localStorage.getItem('mc.pmapRecent')); return Array.isArray(r) ? r : []; } catch { return []; } })();
function pmapOpened(p, app) {
  pmapRecent = [{ path: p.path, name: p.name, app, at: Date.now() }, ...pmapRecent.filter(r => r.path !== p.path)].slice(0, PMAP_RECENT);
  try { localStorage.setItem('mc.pmapRecent', JSON.stringify(pmapRecent)); } catch { /* not remembered */ }
  renderPmapRecent();
}
function renderPmapRecent() {
  $('#pmap-recent').innerHTML = '<div class="pmap-recent-h">Recently opened</div>' + (pmapRecent.length ? pmapRecent.map((r, i) => {
    const there = kmNodes.has(`p:${r.path}`);
    return `<button data-i="${i}" ${there ? `title="${esc(r.path)}"` : 'disabled title="No longer in the map"'}>
      <b>${esc(r.name)}</b><span>${esc(PMAP_APPS[r.app] ?? r.app)} · ${ago(r.at)}</span></button>`;
  }).join('') : '<div class="placeholder">Projects you open from the map show up here.</div>');
}
$('#pmap-recent').onclick = e => {
  const r = pmapRecent[e.target.closest('button[data-i]')?.dataset.i];
  const t = r && kmNodes.get(`p:${r.path}`)?.node;
  if (t) { kmGo(t.id); projectTile(kmProject(t)); }
};

/* ---------- Board: panels you can drag, resize, remove and add back ---------- */
// One entry per panel; its markup is the <section data-panel="id"> in index.html. A new panel type is
// a new entry plus its section. open/close hooks start and stop whatever work the panel drives.
const PANELS = [
  { id: 'sessions', title: 'Sessions', x: 0, y: 0, w: 3, h: 5 },
  { id: 'herdr', title: 'Herdr', x: 0, y: 5, w: 3, h: 3 },
  { id: 'knowledge', title: 'Knowledge', x: 3, y: 0, w: 6, h: 8,
    open: () => { kmTick(); kmap?.resumeAnimation(); }, close: () => kmap?.pauseAnimation() },
  { id: 'side', get title() { return `Linear · ${scmName()} · Repos`; }, x: 9, y: 0, w: 3, h: 8 },
  { id: 'flows', title: 'Orchestration flows', x: 0, y: 8, w: 12, h: 4, open: () => pollChecks() },
  // Not on the default board: add it from ＋ Panels. Sampling runs only while it's shown.
  { id: 'resources', title: 'Resources', x: 0, y: 12, w: 12, h: 6, hidden: true, open: () => pollResources() },
  { id: 'docker', title: 'Docker', x: 0, y: 18, w: 12, h: 6, hidden: true, open: () => pollDocker() },
  { id: 'process', title: 'Process', x: 0, y: 24, w: 12, h: 7, hidden: true, open: () => pollMetrics() },
  { id: 'usage', title: 'Usage', x: 0, y: 47, w: 12, h: 8, hidden: true, open: () => pollUsage() },
  { id: 'waiting', title: 'Waiting on', x: 0, y: 55, w: 4, h: 6, hidden: true, open: () => pollWaiting() },
  { id: 'inbox', title: 'Inbox', x: 4, y: 55, w: 4, h: 8, hidden: true, open: () => pollInbox() },
  { id: 'groom', title: 'Groom queue', x: 8, y: 55, w: 4, h: 8, hidden: true, open: () => pollGroom() },
  { id: 'exec', title: 'Exec summary', x: 0, y: 63, w: 12, h: 4, hidden: true, open: () => pollExec() },
  { id: 'activity', title: 'Activity', x: 0, y: 39, w: 12, h: 8, hidden: true,
    open: () => { pollActivity(); actStart(); }, close: () => { cancelAnimationFrame(act.raf); act.raf = 0; } },
];
const ROWS = 12; // the default layout fills the viewport in 12 rows
const openPanels = new Set();
const isOpen = id => openPanels.has(id);
let board;
const cellH = () => Math.max(40, Math.floor((innerHeight - 52 - 12) / ROWS));
// Views: three boards, each with its own saved layout. Dev is the board for work under way (PANELS' own
// positions); Groom is for setting work up and the chores around it; Exec is the high-level look. A panel can be
// in several views: only one board shows at a time, so its section moves to whichever view is showing.
const VIEWS = [
  { id: 'dev', title: 'Dev', tip: 'Work under way: sessions, herdr, orchestration' },
  { id: 'groom', title: 'Groom', tip: 'Setting work up: meetings to file, what you are waiting on, Linear and reviews' },
  { id: 'exec', title: 'Exec', tip: 'The high-level look: spend and where the time goes' },
];
const VIEW_DEFAULTS = {
  groom: [{ id: 'groom', x: 0, y: 0, w: 6, h: 12 }, { id: 'waiting', x: 6, y: 0, w: 3, h: 12 }, { id: 'side', x: 9, y: 0, w: 3, h: 12 }],
  exec: [{ id: 'exec', x: 0, y: 0, w: 12, h: 4 }, { id: 'usage', x: 0, y: 4, w: 12, h: 8 }, { id: 'process', x: 0, y: 12, w: 12, h: 8 }],
};
let boardView = (() => { try { const v = localStorage.getItem('mc.view'); return VIEWS.some(x => x.id === v) ? v : 'dev'; } catch { return 'dev'; } })();
let switchingView = false; // while one view's panels leave and the next's arrive, nothing is saved
const layoutKey = v => `mc.layout.${v}`;
// Dev's layout was "mc.layout" before there were views: read there until Dev saves its own.
const readLayout = (v = boardView) => {
  let layout;
  try { layout = JSON.parse(localStorage.getItem(layoutKey(v)) ?? (v === 'dev' ? localStorage.getItem('mc.layout') : null)); } catch { return null; }
  return Array.isArray(layout) ? movedPanels(layout.filter(l => l && typeof l === 'object')) : null;
};
// The Project map became the Knowledge panel: a saved Project map takes the Knowledge panel's place when the layout
// has none, and goes otherwise.
const movedPanels = layout => layout.some(l => l.id === 'knowledge') ? layout.filter(l => l.id !== 'projmap')
  : layout.map(l => l.id === 'projmap' ? { ...l, id: 'knowledge' } : l);
// Each view's tab count. Dev: what's waiting on you; Groom: the Groom queue (until it first loads, Inbox flags plus
// Waiting on items overdue or maybe answered); Exec: none.
function renderViewTabs() {
  const counts = { dev: state.alertCount ?? 0, groom: state.groom ? state.groom.items.length
    : (state.inbox?.flags.length ?? 0) + (state.waiting?.items.filter(i => i.overdue || i.maybe).length ?? 0) };
  $('#board-views').innerHTML = VIEWS.map(v => `<button data-view="${v.id}" class="${v.id === boardView ? 'on' : ''}" title="${esc(v.tip)}">${esc(v.title)}${counts[v.id] ? ` <span class="count">${counts[v.id]}</span>` : ''}</button>`).join('');
  $('#board-views').querySelectorAll('button').forEach(b => b.onclick = () => setBoardView(b.dataset.view));
}
function setBoardView(v) {
  if (v === boardView || !VIEWS.some(x => x.id === v)) return;
  boardView = v;
  try { localStorage.setItem('mc.view', v); } catch { /* not remembered */ }
  $('#panels-list').hidden = true;
  layoutPanels(readLayout(v));
  renderViewTabs();
}

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
  if (switchingView || board.getColumn() !== 12) return; // the one-column phone layout must not overwrite the wide one
  const layout = board.save(false).map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
  try { localStorage.setItem(layoutKey(boardView), JSON.stringify(layout)); } catch { /* not remembered */ }
}
// `layout`: saved positions, or null for the current view's defaults.
function layoutPanels(layout) {
  const defaults = boardView === 'dev' ? PANELS.filter(p => !p.hidden) : VIEW_DEFAULTS[boardView];
  switchingView = true;
  try {
    board.batchUpdate();
    for (const id of [...openPanels]) unmountPanel(id);
    for (const p of PANELS) {
      const pos = (layout ?? defaults).find(l => l.id === p.id);
      if (pos) mountPanel(p, { x: pos.x, y: pos.y, w: pos.w, h: pos.h });
    }
    board.batchUpdate(false);
  } finally { switchingView = false; }
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
  renderViewTabs();
  board.on('change', saveLayout);
  addEventListener('resize', () => board.cellHeight(cellH()));

  const list = $('#panels-list');
  const renderList = () => {
    const here = VIEWS.find(v => v.id === boardView).title;
    list.innerHTML = `<div class="menu-label">Panels in ${esc(here)}</div>`
      + PANELS.map(p => `<button data-id="${p.id}" class="${isOpen(p.id) ? 'on' : ''}">${esc(p.title)}</button>`).join('')
      + `<hr><button class="reset" title="Back to ${esc(here)}'s default panels; the other views keep theirs">Reset ${esc(here)} layout</button>`
      + `<hr><div class="menu-label">Info tiles open as</div>${[['popup', 'Pop-ups (stack)'], ['drawer', 'Side drawer (one at a time)']]
        .map(([m, label]) => `<button data-mode="${m}" class="mode ${tileMode === m ? 'on' : ''}">${label}</button>`).join('')}`
      + `<hr><div class="menu-label">When something needs you</div><button class="notify ${notifyOn ? 'on' : ''}">Desktop notifications</button>`
      + `<hr><div class="menu-label">This screen</div><button class="wake ${wakeOn ? 'on' : ''}" ${'wakeLock' in navigator ? '' : 'disabled'}
        title="${'wakeLock' in navigator ? 'Stops Windows sleeping or dimming the screen while the Cleon window is visible (not minimized)' : 'This browser has no screen wake lock'}">Keep screen awake</button>`
      + `<hr><div class="menu-label">Server</div><button class="restart" title="Picks up code and .env changes; the page reloads when it's back">Restart server</button>`
      + `<button class="stop" title="Stops the server and closes its window and this one; the desktop icon starts it again">Stop server</button>`;
    list.querySelector('.notify').onclick = async () => { await setNotify(!notifyOn); renderList(); };
    list.querySelector('.restart').onclick = e => restartServer(e.currentTarget);
    list.querySelector('.stop').onclick = e => stopServer(e.currentTarget);
    list.querySelector('.wake').onclick = async () => { await setWake(!wakeOn); renderList(); };
    list.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { setTileMode(b.dataset.mode); renderList(); });
    list.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
      const p = PANELS.find(p => p.id === b.dataset.id);
      if (isOpen(p.id)) unmountPanel(p.id); else mountPanel(p, { w: p.w, h: p.h, autoPosition: true });
      saveLayout(); renderList();
    });
    list.querySelector('.reset').onclick = () => {
      try { localStorage.removeItem(layoutKey(boardView)); if (boardView === 'dev') localStorage.removeItem('mc.layout'); } catch { /* nothing stored */ }
      layoutPanels(null); renderList();
    };
  };
  $('#panels-btn').onclick = e => { e.stopPropagation(); renderList(); list.hidden = !list.hidden; };
  // composedPath, not contains(): a menu click re-renders the list, detaching the clicked button.
  addEventListener('click', e => { if (!e.composedPath().includes(list)) list.hidden = true; });
}

// Restart the server (scripts/launch.sh starts it again), then reload once a new process answers. The
// boot id tells new from old: on Windows a connection to a closed local port retries for a second or
// two instead of failing, so "seen it go down" can be missed entirely.
async function restartServer(btn) {
  btn.disabled = true;
  btn.textContent = 'Restarting…';
  const r = await fetch('/api/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(r => r.json(), () => null);
  if (!r?.ok) { btn.textContent = r?.reason ?? "Couldn't reach the server"; return; }
  standDown = true;
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    await new Promise(ok => setTimeout(ok, 250));
    const now = await fetch('/api/boot', { cache: 'no-store' }).then(r => r.json(), () => null);
    if (now?.boot && now.boot !== r.boot) return location.reload();
  }
  btn.textContent = 'Not back after 20 s: check its window';
}
// Stop the server (its launcher window closes with it), then this window. Two clicks: the first arms it.
// A window the launcher opened can close itself; a browser that won't gets a "stopped" cover instead.
async function stopServer(btn) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Click again to stop Cleon';
    setTimeout(() => { if (!btn.disabled) { btn.classList.remove('armed'); btn.textContent = 'Stop server'; } }, 4000);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Stopping…';
  const r = await fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(r => r.json(), () => null);
  if (!r?.ok) { btn.textContent = "Couldn't reach the server"; return; }
  standDown = true;
  window.close();
  document.body.insertAdjacentHTML('beforeend', '<div class="stopped-cover"><div>Cleon is stopped.<br>Close this window; the desktop icon starts it again.</div></div>');
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
// A sample's tiles (`h`, its history, adds sparklines) and its process table, for this machine and each peer.
function resTiles(r, h) {
  const g = r.gpu, memPct = 100 * r.mem.used / r.mem.total, vramPct = g ? 100 * g.memUsed / g.memTotal : null;
  return [
    statTile('CPU', pctTxt(r.cpu.pct), `${r.cpu.cores} threads`, r.cpu.pct, h, 'cpu', pctTxt),
    statTile('RAM', gb(r.mem.used), `of ${gb(r.mem.total)} · ${Math.round(memPct)}%`, memPct, h, 'mem', pctTxt),
    g ? statTile('GPU', pctTxt(g.util), esc(g.name.replace(/^NVIDIA (GeForce )?/, '')), g.util, h, 'gpu', pctTxt) : '',
    g ? statTile('VRAM', gb(g.memUsed), `of ${gb(g.memTotal)} · ${Math.round(vramPct)}%`, vramPct, h, 'vram', pctTxt) : '',
    g ? statTile('GPU temp · power', `${g.temp}°C`, `${Math.round(g.power)} W`, null, h, 'temp', v => `${v}°C`) : '',
    ...r.disks.map(d => statTile(`Disk ${d.drive}`, `${gb(d.free)} free`, `of ${gb(d.total)}`, 100 * (1 - d.free / d.total), null)),
  ].join('');
}
function ollamaLine(r) {
  const unload = m => { const ms = Date.parse(m.until) - Date.now(); return ms > 0 ? ` · unloads in ${mins(ms)}` : ''; };
  return r.ollama == null ? '<span class="res-dim">Ollama: not running</span>'
    : !r.ollama.length ? '<span class="res-dim">Ollama: no models loaded</span>'
    : 'Ollama: ' + r.ollama.map(m => `<b>${esc(m.name)}</b> · ${gb(m.vram)} VRAM${m.vram < m.size ? ` + ${gb(m.size - m.vram)} RAM` : ''}${unload(m)}`).join(' · ');
}
function procTable(r, limit) {
  // Process table, grouped by app; labelled processes (Claude sessions) keep their own rows.
  const group = $('#res-group').checked, rows = new Map();
  for (const p of r.procs) {
    const key = p.label ?? (group ? p.name : `${p.name}#${p.pid}`);
    const row = rows.get(key) ?? rows.set(key, { name: p.label ?? p.name, pid: p.pid, n: 0, ram: 0, vram: null, cpu: null, gpu: null }).get(key);
    row.n++; row.ram += p.ram ?? 0;
    for (const k of ['vram', 'cpu', 'gpu']) if (p[k] != null) row[k] = (row[k] ?? 0) + p[k];
  }
  const list = [...rows.values()].sort((a, b) => (b[resSort] ?? -1) - (a[resSort] ?? -1)).slice(0, limit);
  const top = Math.max(...list.map(x => x[resSort] ?? 0), 1e-9);
  const cell = (row, k, fmt) => `<td class="${k === resSort ? 'sorted' : ''}">${fmt(row[k])}${k === resSort && row[k] ? `<i class="res-bar" style="width:${100 * row[k] / top}%"></i>` : ''}</td>`;
  const attributed = r.procs.reduce((a, p) => a + (p.cpu ?? 0), 0);
  const hidden = r.cpu.pct != null && r.sources.cpu ? Math.max(0, r.cpu.pct - attributed) : null;
  return `<table><thead><tr><th>Process</th><th>CPU</th><th>RAM</th><th>VRAM</th><th>GPU</th></tr></thead><tbody>${list.map(x => `<tr>
    <td class="pname" title="${esc(x.name)}${x.n > 1 ? ` · ${x.n} processes` : ` · pid ${x.pid}`}">${esc(x.name)}${x.n > 1 ? ` <span class="res-dim">×${x.n}</span>` : ''}</td>
    ${cell(x, 'cpu', pctTxt)}${cell(x, 'ram', gb)}${cell(x, 'vram', gb)}${cell(x, 'gpu', pctTxt)}</tr>`).join('')}</tbody></table>`
    // CPU Windows won't attribute (protected processes like the WSL VM) is shown, not hidden.
    + (hidden >= 1 ? `<div class="res-note">${pctTxt(hidden)} CPU is in protected processes Windows won't attribute (WSL/Docker VM, Defender, system services).</div>` : '')
    + (!r.sources.cpu ? '<div class="res-note">Per-process CPU appears from the second sample on.</div>' : '');
}
// Each machine's process table folds away under its heading; which ones are folded is kept in this browser.
let resFolded = (() => { try { return new Set(JSON.parse(localStorage.getItem('mc.resFolded')) ?? []); } catch { return new Set(); } })();
const procBox = (key, r, limit, label) => `<details class="res-fold" data-fold="${esc(key)}"${resFolded.has(key) ? '' : ' open'}>
  <summary>${label} <span class="res-dim">· top ${Math.min(limit, r.procs.length)} of ${r.procs.length}</span></summary>${procTable(r, limit)}</details>`;
function renderResources() {
  const r = state.res;
  if (!r) return;
  $('#res-at').textContent = `sampled ${ago(r.at)}`;
  $('#res-tiles').innerHTML = resTiles(r, state.resHist);
  $('#res-ollama').innerHTML = ollamaLine(r);
  $('#res-procs').innerHTML = procBox('', r, 15, 'Processes');
  // Each peer (MC_PEERS) in a section of its own, its numbers never mixed into this machine's.
  $('#res-peers').innerHTML = (r.peers ?? []).map(({ machine, sample: s, reason }) => !s
    ? `<section class="res-peer off"><h3>${machineChip(machine)}</h3><div class="res-dim">${esc(reason)}</div></section>`
    : `<section class="res-peer"><h3>${machineChip(machine)} <span class="res-dim">sampled ${ago(s.at)}</span></h3>
      <div class="res-tiles">${resTiles(s, null)}</div>${s.ollama?.length ? `<div class="res-ollama">${ollamaLine(s)}</div>` : ''}
      <div class="res-procs">${procBox(machine, s, 10, `Processes on ${esc(machine)}`)}</div></section>`).join('');
  // 'toggle' doesn't bubble, and every render replaces the boxes: bind each one again.
  document.querySelectorAll('#res-procs details.res-fold, #res-peers details.res-fold').forEach(d => d.ontoggle = () => {
    if (d.open) resFolded.delete(d.dataset.fold); else resFolded.add(d.dataset.fold);
    try { localStorage.setItem('mc.resFolded', JSON.stringify([...resFolded])); } catch { /* not remembered */ }
  });
  document.querySelectorAll('#res-sort button').forEach(b => b.classList.toggle('on', b.dataset.k === resSort));
}
async function pollResources() {
  if (!isOpen('resources')) return;
  const r = await api('/api/resources');
  if (!r) return;
  if (r.at !== state.res?.at)
    state.resHist = [...(state.resHist ?? []), { at: r.at, cpu: r.cpu.pct, mem: 100 * r.mem.used / r.mem.total,
      gpu: r.gpu?.util ?? null, vram: r.gpu ? 100 * r.gpu.memUsed / r.gpu.memTotal : null, temp: r.gpu?.temp ?? null }].slice(-RES_HISTORY);
  // Always the latest answer: a peer's sample (`peers`) can be newer even when this machine's is the same one.
  state.res = r;
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
    ${bar}<div class="res-note">Last used = the last container start Cleon saw (it watches while running; Docker doesn't keep this), or a container that still exists.</div>`;
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

/* ---------- Activity: what Cleon is checking, drawn live ---------- */
// Cleon sits in the middle and each thing it checks is a node around it: Claude sessions, herdr
// sessions, web services and local tools, with this page on its own at the left. Every check is a dot
// that goes out to its node on one lane, waits there as long as the check really took, and comes back
// on the other: green answered, amber answered no (a non-zero exit, an HTTP 4xx), red failed or
// stopped, grey nothing new (an unchanged transcript). The page's requests come in from the left.
// Events replay ACT_LAG behind real time, so a check that started and finished between two polls still
// makes its whole trip. Drawing runs only while the panel is shown and the window is visible.
const ACT_LAG = 1500, ACT_TRIP = 520, ACT_MAX_DOTS = 900, ACT_KEEP = 60_000;
const ACT_GROUPS = ['claude', 'herdr', 'web', 'local'];
const ACT_GROUP_LABEL = { claude: 'Claude sessions', herdr: 'herdr', web: 'web services', local: 'local tools' };
const ACT_NAMES = { git: 'git · repos', github: 'GitHub', bitbucket: 'Bitbucket', linear: 'Linear', ollama: 'Ollama', docker: 'Docker',
  windows: 'Windows', vscode: 'VS Code', terminal: 'Git Bash', page: 'this page', herdr: 'herdr', 'claude:ended': 'ended sessions' };
const ACT_COLOR = { out: '#3ef0ff', page: '#cfe7ff', ok: '#4dff9a', no: '#ffb547', fail: '#ff5a6e', cached: '#6c84a3' };
const ACT_WORD = { ok: 'answered', no: 'answered no', fail: 'failed', cached: 'nothing new' };
const actReduced = matchMedia('(prefers-reduced-motion: reduce)');
const act = { pid: null, rev: 0, at: 0, offset: 0, from: 0, events: new Map(), queue: [], nodes: {}, merged: {}, samples: [], io: [],
  dots: [], pos: new Map(), heat: new Map(), alarm: new Map(), pings: [], lastPing: 0, lastFrame: 0, focus: null, hover: null,
  paused: false, pausedAt: 0, raf: 0, busy: false, dropped: 0,
  // Drawing: the still layer and whether it needs redrawing, the layout, and who is waiting on an answer.
  layer: null, dirty: true, drawn: false, L: null, waiting: new Map(), turning: new Set(), waitSig: '' };

const actGroup = id => id.startsWith('claude:') ? 'claude' : id.startsWith('herdr') ? 'herdr'
  : ['linear', 'bitbucket', 'github', 'ollama'].includes(id) || id.startsWith('web:') ? 'web' : id === 'page' ? 'page' : 'local';
function actName(id) {
  if (ACT_NAMES[id]) return ACT_NAMES[id];
  if (id.startsWith('claude:')) return state.sessions.find(s => s.id === id.slice(7))?.name || `session ${id.slice(7, 15)}`;
  if (id.startsWith('herdr:')) return `herdr · ${id.slice(6)}`;
  return id.startsWith('web:') ? id.slice(4) : id;
}
// Claude sessions that have ended share one node, so the ring holds only the live ones. Until the
// session list has arrived (a busy server can take a while), none is taken for ended.
const actNode = id => id.startsWith('claude:') && id !== 'claude:ended' && state.sessions.length
  && !state.sessions.some(s => s.alive && s.id === id.slice(7)) ? 'claude:ended' : id;
const actNow = () => act.paused ? act.pausedAt : Date.now() + act.offset - ACT_LAG;
const actResult = e => e.cached ? 'cached' : e.result ?? 'ok';
const actMs = ms => ms == null ? '…' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const actWindowMin = () => Math.min(5, Math.max(0.5, (Date.now() + act.offset - act.from) / 60_000));

// Per-node totals from the server, with ended Claude sessions folded into one.
function actMerge(nodes) {
  const out = {};
  for (const [id, n] of Object.entries(nodes)) {
    const k = actNode(id), m = out[k] ??= { calls: 0, running: 0, ok: 0, no: 0, fail: 0, cached: 0, sumMs: 0, done: 0, maxMs: 0, routes: {} };
    for (const f of ['calls', 'running', 'ok', 'no', 'fail', 'cached']) m[f] += n[f] ?? 0;
    const done = (n.ok ?? 0) + (n.no ?? 0) + (n.fail ?? 0);
    m.sumMs += (n.avgMs ?? 0) * done; m.done += done; m.maxMs = Math.max(m.maxMs, n.maxMs ?? 0);
    for (const [r, c] of Object.entries(n.routes ?? {})) m.routes[r] = (m.routes[r] ?? 0) + c;
  }
  for (const m of Object.values(out)) m.avgMs = m.done ? m.sumMs / m.done : null;
  return out;
}

async function pollActivity() {
  if (!isOpen('activity') || document.hidden || act.busy) return;
  act.busy = true;
  try {
    const r = await api(`/api/activity?rev=${act.rev}&at=${act.at}`);
    if (!r) return;
    if (act.pid && r.pid !== act.pid) { // a restarted server starts its log over
      Object.assign(act, { pid: r.pid, rev: 0, at: 0, events: new Map(), queue: [], samples: [], dots: [] });
      return;
    }
    act.pid = r.pid;
    act.offset = r.now - Date.now();
    const vnow = actNow();
    for (const e of r.events) {
      const have = act.events.get(e.id);
      if (have) { Object.assign(have, e); continue; }
      act.events.set(e.id, e);
      if (e.at >= vnow - 300) act.queue.push(e); // older ones are history: listed, not animated
    }
    act.queue.sort((a, b) => a.at - b.at);
    for (const [id, e] of act.events) if (e.ms != null && e.at + e.ms < vnow - ACT_KEEP) act.events.delete(id);
    Object.assign(act, { rev: r.rev, nodes: r.nodes, merged: actMerge(r.nodes), from: r.from, io: r.io });
    act.samples = [...act.samples, ...r.samples].slice(-150);
    act.at = act.samples.at(-1)?.at ?? act.at;
    renderActivity();
  } finally {
    act.busy = false;
  }
}

function actSpark(values, fmt) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '<svg class="res-spark"></svg>';
  const W = 120, H = 26, top = Math.max(...pts.map(([, v]) => v), 1e-9), x = i => (i / (values.length - 1)) * W, y = v => H - 2 - (v / top) * (H - 4);
  const [li, lv] = pts.at(-1);
  return `<svg class="res-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')}"/>`
    + `<circle cx="${x(li)}" cy="${y(lv)}" r="2.2"><title>${esc(fmt(lv))}</title></circle></svg>`;
}
const actTile = (label, value, sub, values, fmt) => `<div class="res-tile"><div class="res-label">${esc(label)}</div>
  <div class="res-value">${value}</div><div class="res-sub">${sub}</div>${values ? actSpark(values, fmt) : ''}</div>`;

function renderActivity() {
  const s = act.samples, last = s.at(-1), minute = s.slice(-30);
  const perMin = k => Math.round(minute.reduce((a, x) => a + (x[k] ?? 0), 0) * 30 / Math.max(1, minute.length));
  const cores = navigator.hardwareConcurrency || 1;
  const [ia, ib] = act.io.slice(-2), ioMin = ia && ib && ib.at > ia.at ? k => (ib[k] - ia[k]) * 60_000 / (ib.at - ia.at) : null;
  const calls = Object.values(act.merged).reduce((a, n) => a + n.calls, 0);
  $('#act-at').textContent = calls ? `${calls.toLocaleString()} checks in ${Math.round(actWindowMin() * 10) / 10} min` : '';
  $('#act-tiles').innerHTML = !last ? '<div class="placeholder">Listening… (the first sample takes 2 s)</div>' : [
    actTile('Cleon CPU', pctTxt(last.cpu), `of one core · ${pctTxt(last.cpu / cores)} of all ${cores}`, s.map(x => x.cpu), pctTxt),
    actTile('Memory', gb(last.rss), `JS heap ${gb(last.heap)}`, s.map(x => x.rss), gb),
    actTile('Held up', actMs(last.lag), 'longest wait before Cleon could answer (last 2 s)', s.map(x => x.lag), actMs),
    actTile('Programs started', `${perMin('program')}/min`, 'git, herdr, gh, docker, Windows tools', s.map(x => x.program), v => `${v} in 2 s`),
    actTile('Web requests', `${perMin('web')}/min`, 'Linear, Bitbucket, GitHub, Ollama', s.map(x => x.web), v => `${v} in 2 s`),
    actTile('Session checks', `${perMin('session')}/min`, 'session files, pid checks, transcripts', s.map(x => x.session), v => `${v} in 2 s`),
    actTile('I/O', ioMin ? `${gb(ioMin('read'))}/min` : '—', ioMin ? `read · ${gb(ioMin('write'))}/min written (files and pipes)` : 'files and pipes; needs two readings 10 s apart', null),
  ].join('');
  const vnow = actNow();
  const rows = [...act.events.values()].filter(e => e.at <= vnow && (!act.focus || actNode(e.node) === act.focus))
    .sort((a, b) => b.at - a.at).slice(0, 80);
  $('#act-feed').innerHTML = (act.focus ? `<div class="act-focus">Only <b>${esc(actName(act.focus))}</b> · <button id="act-unfocus">show all</button></div>` : '')
    + (rows.length ? rows.map(e => {
      const res = e.ms == null ? 'run' : actResult(e);
      return `<div class="act-row r-${res}" title="${esc(`${e.what}${e.why ? ` · ${e.why}` : ''} · asked by ${e.route ?? 'background work'}`)}">
        <span class="act-t">${new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
        <span class="act-w"><b>${esc(actName(actNode(e.node)))}</b> ${esc(e.what)}${e.why ? ` <em>${esc(e.why)}</em>` : ''}</span>
        <span class="act-ms">${actMs(e.ms)}</span></div>`;
    }).join('') : '<div class="placeholder">Nothing yet.</div>');
  $('#act-unfocus')?.addEventListener('click', () => { act.focus = null; renderActivity(); });
  act.dirty = true; // node labels carry the new totals
}

// Where each node sits: an ellipse around the hub, starting at the upper left and running clockwise
// through the groups in order, with a gap between groups; the page alone at the left.
function actPlace(W, H) {
  const ids = new Set(Object.keys(act.merged));
  for (const s of state.sessions) if (s.alive) ids.add(`claude:${s.id}`);
  ids.delete('page');
  const order = [...ids].sort((a, b) => ACT_GROUPS.indexOf(actGroup(a)) - ACT_GROUPS.indexOf(actGroup(b)) || actName(a).localeCompare(actName(b)));
  const cx = W / 2, cy = H / 2, rx = Math.max(60, W / 2 - 80), ry = Math.max(40, H / 2 - 48); // room for two label lines
  const slots = [];
  order.forEach((id, i) => { if (i && actGroup(id) !== actGroup(order[i - 1])) slots.push(null); slots.push(id); });
  const gap = 0.42, span = 2 * Math.PI - 2 * gap, step = slots.length > 1 ? span / (slots.length - 1) : 0;
  const target = new Map([['page', { x: cx - rx, y: cy, a: Math.PI }]]);
  slots.forEach((id, i) => { if (id) { const a = Math.PI + gap + i * step; target.set(id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), a }); } });
  let moving = false; // nodes still gliding to new places
  for (const [id, t] of target) {
    const p = act.pos.get(id);
    if (!p) { act.pos.set(id, { ...t }); continue; }
    const dx = t.x - p.x, dy = t.y - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.3) { p.x += dx * 0.12; p.y += dy * 0.12; moving = true; } else { p.x = t.x; p.y = t.y; }
    p.a = t.a;
  }
  for (const id of act.pos.keys()) if (!target.has(id)) act.pos.delete(id);
  return { cx, cy, rx, ry, moving };
}
const actRadius = id => { const n = act.merged[id]; return 5 + Math.min(9, 2 * Math.log2(1 + (n ? n.calls / actWindowMin() : 0))); };

// A point along a slightly bowed lane from a to b; side +1 for out, -1 for back, so they don't overlap.
function actLane(a, b, k, side) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, bow = Math.min(16, len * 0.07) * side;
  const c = { x: (a.x + b.x) / 2 - (dy / len) * bow, y: (a.y + b.y) / 2 + (dx / len) * bow };
  const u = 1 - k;
  return { x: u * u * a.x + 2 * u * k * c.x + k * k * b.x, y: u * u * a.y + 2 * u * k * c.y + k * k * b.y };
}
const actEase = k => { k = Math.min(1, Math.max(0, k)); return k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; };
const actDot = (ctx, p, color, alpha) => {
  ctx.globalAlpha = alpha * 0.25; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill();
  ctx.globalAlpha = alpha; ctx.beginPath(); ctx.arc(p.x, p.y, 2.4, 0, 7); ctx.fill();
};

// Each frame moves the dots on; the still parts (ring, labels, hub) are drawn into a layer only when
// they change (a poll, a hover, a resize), and nothing is drawn at all while nothing moves. 30 frames
// a second at most: smooth enough for a half-second trip, half the cost of 60.
function actFrame(ts) {
  act.raf = 0;
  if (!isOpen('activity') || document.hidden) return;
  if (ts - (act.lastFrame || 0) < 30) { act.raf = requestAnimationFrame(actFrame); return; }
  const stage = $('#act-stage'), cv = $('#act-canvas'), W = stage.clientWidth, H = stage.clientHeight, dpr = devicePixelRatio || 1;
  const dt = Math.min(100, ts - (act.lastFrame || ts)); act.lastFrame = ts;
  if (W && H) {
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); act.dirty = true; }
    if (act.dirty || act.L?.moving || !act.L) { act.L = actPlace(W, H); act.dirty = true; }
    const busy = actStep(dt);
    if (act.dirty) { actLayer(W, H, dpr); act.dirty = false; act.drawn = false; }
    if (busy || !act.drawn) { actDraw(cv.getContext('2d'), dpr); act.drawn = !busy; }
  }
  act.raf = requestAnimationFrame(actFrame);
}
function actStart() { if (!act.raf && isOpen('activity') && !document.hidden) act.raf = requestAnimationFrame(actFrame); }

// Moves every dot through its trip (out, waiting at the node, back) and says whether anything moves.
function actStep(dt) {
  const vnow = actNow();
  const decay = (m, ms) => { for (const [k, v] of m) { const n = v * Math.exp(-dt / ms); if (n < 0.02) m.delete(k); else m.set(k, n); } };
  decay(act.heat, 450); decay(act.alarm, 2500);
  // Launch what's due. With reduced motion, nodes still light up but no dots travel.
  while (!act.paused && act.queue.length && act.queue[0].at <= vnow) {
    const e = act.queue.shift(), node = actNode(e.node);
    act.heat.set(node, 1);
    if (actReduced.matches) continue;
    if (act.dots.length >= ACT_MAX_DOTS) { act.dropped++; continue; }
    act.dots.push({ e, node, phase: 'out', t0: e.at });
    if (vnow - act.lastPing > 140) { act.pings.push({ t0: vnow }); act.lastPing = vnow; }
  }
  const waiting = new Map(), turning = new Set();
  let moving = false;
  for (const d of act.dots) {
    if (!act.pos.has(d.node)) { d.done = true; continue; }
    if (d.phase === 'out' && vnow - d.t0 >= ACT_TRIP) { d.phase = 'wait'; d.t0 += ACT_TRIP; }
    if (d.phase === 'wait') {
      const end = d.e.ms != null ? d.e.at + d.e.ms : null;
      if (end == null || vnow < end) {
        waiting.set(d.node, (waiting.get(d.node) ?? 0) + 1);
        if (vnow - d.e.at <= 10_000) { turning.add(d.node); moving = true; } // a long one (a watcher) sits still
        continue;
      }
      d.phase = 'back'; d.t0 = Math.max(end, d.t0);
    }
    if (vnow - d.t0 >= ACT_TRIP) { d.done = true; if (actResult(d.e) === 'fail') act.alarm.set(d.node, 1); continue; }
    moving = true;
  }
  act.dots = act.dots.filter(d => !d.done);
  act.pings = act.pings.filter(pg => vnow - pg.t0 < 900);
  const sig = [...waiting].join(';');
  if (sig !== act.waitSig) { act.waitSig = sig; act.dirty = true; } // the "open" counts in the labels
  act.waiting = waiting; act.turning = turning;
  return !act.paused && (moving || act.pings.length > 0 || act.heat.size > 0 || act.alarm.size > 0);
}

// The still layer: group names, edges, node rings and labels, the hub.
function actLayer(W, H, dpr) {
  const c = act.layer ??= document.createElement('canvas');
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d'), { cx, cy, rx, ry } = act.L, faded = id => act.focus && id !== act.focus, win = actWindowMin();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '500 9px Orbitron, sans-serif';
  for (const g of ACT_GROUPS) {
    const as = [...act.pos].filter(([id]) => actGroup(id) === g).map(([, p]) => p.a);
    if (!as.length) continue;
    const a = as.reduce((x, y) => x + y, 0) / as.length;
    ctx.globalAlpha = 0.55; ctx.fillStyle = ACT_COLOR.cached;
    ctx.fillText(ACT_GROUP_LABEL[g].toUpperCase(), cx + rx * 0.62 * Math.cos(a), cy + ry * 0.62 * Math.sin(a));
  }
  ctx.strokeStyle = ACT_COLOR.out; ctx.lineWidth = 1;
  for (const [id, p] of act.pos) {
    ctx.globalAlpha = faded(id) ? 0.04 : 0.08;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke();
  }
  ctx.font = '600 10px "JetBrains Mono", monospace';
  for (const [id, p] of act.pos) {
    const n = act.merged[id], r = actRadius(id), per = n ? n.calls / win : 0, w = act.waiting?.get(id), alpha = faded(id) ? 0.3 : 1;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(8,14,26,.95)'; ctx.strokeStyle = id === 'page' ? ACT_COLOR.page : ACT_COLOR.out;
    ctx.lineWidth = id === act.focus || id === act.hover ? 2.5 : 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
    const below = p.y >= cy || Math.abs(p.x - cx) > rx * 0.6, ty = below ? p.y + r + 10 : p.y - r - 18;
    const name = actName(id), label = name.length > 18 ? `${name.slice(0, 17)}…` : name;
    ctx.fillStyle = ACT_COLOR.page;
    ctx.fillText(label, p.x, ty);
    ctx.globalAlpha = alpha * 0.8; ctx.fillStyle = ACT_COLOR.cached;
    ctx.fillText(n ? `${per < 10 ? per.toFixed(1) : Math.round(per)}/min${n.avgMs != null ? ` · ${actMs(n.avgMs)}` : ''}${w ? ` · ${w} open` : ''}` : 'quiet', p.x, ty + 11);
  }
  const last = act.samples.at(-1);
  ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(8,14,26,.95)'; ctx.strokeStyle = ACT_COLOR.out; ctx.lineWidth = 2;
  ctx.shadowColor = ACT_COLOR.out; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(cx, cy, 24, 0, 7); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = ACT_COLOR.out; ctx.font = '700 9px Orbitron, sans-serif'; ctx.fillText('CLEON', cx, cy);
  ctx.font = '10px "JetBrains Mono", monospace';
  if (last) { ctx.fillStyle = ACT_COLOR.cached; ctx.fillText(`${pctTxt(last.cpu)} cpu · ${gb(last.rss)}`, cx, cy + 36); }
  if (act.paused) { ctx.fillStyle = ACT_COLOR.no; ctx.fillText('paused (still recording)', cx, cy - 36); }
  if (act.dropped) { ctx.globalAlpha = 0.8; ctx.fillStyle = ACT_COLOR.cached; ctx.textAlign = 'right'; ctx.fillText(`${act.dropped} checks not drawn (too many at once)`, W - 6, H - 8); }
  ctx.globalAlpha = 1;
}

// One frame: the still layer, then what moves on top (lit edges, dots, hub pings, node glows).
function actDraw(ctx, dpr) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(act.layer, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vnow = actNow(), { cx, cy } = act.L, faded = id => act.focus && id !== act.focus;
  ctx.strokeStyle = ACT_COLOR.out; ctx.lineWidth = 1;
  for (const [id, h] of act.heat) {
    const p = act.pos.get(id);
    if (!p) continue;
    ctx.globalAlpha = 0.3 * h * (faded(id) ? 0.15 : 1);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke();
  }
  // Dots run from the hub's rim to the node's, so they never cover the hub or a node.
  for (const d of act.dots) {
    const p = act.pos.get(d.node);
    if (!p) continue;
    const len = Math.hypot(p.x - cx, p.y - cy) || 1, ux = (p.x - cx) / len, uy = (p.y - cy) / len, r = actRadius(d.node) + 2;
    const rim = { x: cx + ux * 26, y: cy + uy * 26 }, edge = { x: p.x - ux * r, y: p.y - uy * r };
    const page = d.e.kind === 'page', [a, b] = page ? [edge, rim] : [rim, edge], alpha = faded(d.node) ? 0.2 : 1;
    if (d.phase === 'out') actDot(ctx, actLane(a, b, actEase((vnow - d.t0) / ACT_TRIP), 1), page ? ACT_COLOR.page : ACT_COLOR.out, alpha);
    else if (d.phase === 'back') actDot(ctx, actLane(b, a, actEase((vnow - d.t0) / ACT_TRIP), 1), ACT_COLOR[actResult(d.e)], alpha);
    else if (vnow - d.e.at > 10_000) { // a long one (a watcher, a slow call): a dashed line while it's open
      ctx.globalAlpha = 0.35 * alpha; ctx.strokeStyle = ACT_COLOR.out; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  for (const pg of act.pings) {
    const k = (vnow - pg.t0) / 900;
    ctx.globalAlpha = 0.5 * (1 - k); ctx.strokeStyle = ACT_COLOR.out; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 24 + 40 * k, 0, 7); ctx.stroke();
  }
  for (const [id, p] of act.pos) {
    const heat = act.heat.get(id) ?? 0, alarm = act.alarm.get(id) ?? 0, w = act.waiting?.get(id);
    if (heat < 0.02 && alarm < 0.05 && !w) continue;
    const r = actRadius(id), alpha = faded(id) ? 0.3 : 1, color = id === 'page' ? ACT_COLOR.page : ACT_COLOR.out;
    if (heat >= 0.02) { ctx.globalAlpha = alpha * heat * 0.6; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, r - 2, 0, 7); ctx.fill(); }
    if (alarm >= 0.05) { ctx.globalAlpha = alpha * alarm; ctx.strokeStyle = ACT_COLOR.fail; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke(); }
    if (w) { // still waiting on an answer: an arc, turning while the wait is short
      const s0 = act.turning.has(id) ? vnow / 300 : -Math.PI / 2;
      ctx.globalAlpha = alpha; ctx.strokeStyle = ACT_COLOR.no; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, s0, s0 + 1.6); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

// Hover a node for its totals; click one to show only its checks in the feed (click it again, the hub
// or the background to show everything).
function actHit(ev) {
  const r = $('#act-canvas').getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  let best = null, bd = 18;
  for (const [id, p] of act.pos) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = id; } }
  return { id: best, x, y };
}
$('#act-canvas').addEventListener('mousemove', ev => {
  const { id, x, y } = actHit(ev), tip = $('#act-tip');
  if (act.hover !== id) { act.hover = id; act.dirty = true; }
  $('#act-canvas').style.cursor = id ? 'pointer' : 'default';
  if (!id) { tip.hidden = true; return; }
  const n = act.merged[id], win = actWindowMin();
  const routes = n ? Object.entries(n.routes).sort((a, b) => b[1] - a[1]).slice(0, 4) : [];
  tip.innerHTML = `<b>${esc(actName(id))}</b>${n ? `<div>${n.calls.toLocaleString()} checks in ${Math.round(win * 10) / 10} min · ${(n.calls / win).toFixed(1)}/min</div>
    <div>average ${actMs(n.avgMs)} · longest ${actMs(n.maxMs)}${n.running ? ` · ${n.running} open now` : ''}</div>
    <div>${['ok', 'no', 'fail', 'cached'].filter(k => n[k]).map(k => `<span class="r-${k}">${n[k]} ${ACT_WORD[k]}</span>`).join(' · ')}</div>
    <div class="act-tip-h">asked by</div>${routes.map(([rt, c]) => `<div>${esc(rt === 'background' ? 'background work (no page request)' : rt)} ×${c}</div>`).join('')}`
    : '<div>no checks in the last 5 min</div>'}`;
  tip.hidden = false;
  const st = $('#act-stage');
  tip.style.left = `${Math.min(x + 14, st.clientWidth - tip.offsetWidth - 4)}px`;
  tip.style.top = `${Math.min(y + 14, st.clientHeight - tip.offsetHeight - 4)}px`;
});
$('#act-canvas').addEventListener('mouseleave', () => { act.hover = null; act.dirty = true; $('#act-tip').hidden = true; });
$('#act-canvas').addEventListener('click', ev => { const { id } = actHit(ev); act.focus = id && id !== act.focus ? id : null; renderActivity(); });
$('#act-pause').addEventListener('click', e => {
  act.paused = !act.paused;
  if (act.paused) act.pausedAt = Date.now() + act.offset - ACT_LAG;
  else { const now = actNow(); act.queue = act.queue.filter(x => x.at >= now - 300); } // skip what happened while paused
  e.currentTarget.textContent = act.paused ? 'resume' : 'pause';
  e.currentTarget.classList.toggle('on', act.paused);
  act.dirty = true;
});
$('#act-legend').innerHTML = [['out', 'checking'], ['ok', 'answered'], ['no', 'answered no'], ['fail', 'failed'], ['cached', 'nothing new']]
  .map(([k, t]) => `<span><i style="background:${ACT_COLOR[k]}"></i>${t}</span>`).join('');
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollActivity(); actStart(); } });
setInterval(pollActivity, 1000);

/* ---------- Polling ---------- */
async function poll() {
  const [sessions, runs, herdr, orch, workers, attention, sessionAct, peers] = await Promise.all([api('/api/sessions'), api('/api/runs'),
    isOpen('herdr') || isOpen('flows') ? api('/api/herdr') : state.herdr,
    isOpen('flows') ? api('/api/orchestrators') : state.orch,
    isOpen('flows') ? api('/api/workers') : state.workers, api('/api/attention'),
    isOpen('sessions') ? api('/api/session-activity') : state.sessionAct, api('/api/peers')]);
  Object.assign(state, { sessions: sessions ?? [], runs, herdr, orch: orch ?? state.orch, workers: workers ?? state.workers,
    attention: attention ?? state.attention, sessionAct: sessionAct ?? state.sessionAct, peers: peers ?? state.peers });
  renderSessions(); renderHerdr(); renderFlows(); renderOrch(); renderWorkers(); renderStats(); refreshTiles();
  pollTaskTiles();
}
async function pollSlow() {
  const [projects, linear, github] = await Promise.all([api('/api/projects'), api('/api/linear'), api('/api/github')]);
  Object.assign(state, { projects: projects ?? [], linear, github });
  renderProjects(); renderLinear(); renderGithub(); renderFlows(); renderStats();
}

async function pollChecks() {
  if (!isOpen('flows') && !isOpen('side') && !isOpen('sessions')) return;
  const [checks, sessionPrs] = await Promise.all([api('/api/checks'), api('/api/session-prs')]);
  state.checks = checks ?? state.checks;
  state.sessionPrs = sessionPrs ?? state.sessionPrs;
  renderFlows(); renderSessions(); refreshTiles();
}

initBoard();
const tick = { poll: single(poll), slow: single(pollSlow), checks: single(pollChecks), metrics: single(pollMetrics),
  resources: single(pollResources), docker: single(pollDocker) };
tick.poll(); tick.slow(); tick.checks();
/* ---------- Process: where each merged ticket's time went, agent vs. you ---------- */
// Cyan = agent working, magenta = waiting on you (plan gate, then review→merge, which includes CI),
// grey = waiting while you were away (no prompt or answer from you for 3 h or more: nights, mostly).
// Stage times come from run-file mtimes, so they're approximate; "≈" marks a ticket with a missing or
// rewritten file.
const hrs = ms => ms == null ? '—' : ms < 3600e3 ? `${Math.round(ms / 60e3)}m` : `${(ms / 3600e3).toFixed(1)}h`;
const SEGS = [['planning', 'planning', 'agent'], ['gate', 'plan gate', 'you'], ['gateAway', 'plan gate while you were away', 'away'],
  ['implementing', 'implementing', 'agent'], ['selfReview', 'self-review', 'agent'], ['mergeWait', 'review → merge (you + CI)', 'you'],
  ['mergeAway', 'review → merge while you were away', 'away']];
const stoppedAtGate = t => (t.seg.gate ?? 0) + (t.seg.gateAway ?? 0) > 0;
function pmBar(parts, total) {
  return `<div class="pm-bar">${parts.filter(([, ms]) => ms > 0).map(([label, ms, who]) =>
    `<i class="pm-${who}" style="flex-grow:${ms / total}" title="${esc(`${label}: ${hrs(ms)}`)}"></i>`).join('')}</div>`;
}
const day = ms => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
let pmView = (() => { try { return localStorage.getItem('mc.pmView') || 'pipeline'; } catch { return 'pipeline'; } })();
let pmWeek = 'latest'; // 'latest', 'all', or a week's start (ms) as a string
const medianOf = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
// The lifecycle as you'd describe it: who holds the ticket at each stage, and what happens there.
const STAGES = [
  { k: 'planning', label: 'Planning', who: 'agent', says: ['agent reads the ticket', 'and drafts a plan'] },
  { k: 'gate', label: 'Plan gate', who: 'you', away: 'gateAway', says: ['you approve or', 'redirect the plan'] },
  { k: 'implementing', label: 'Implementing', who: 'agent', says: ['agent builds, tests', 'and opens the PR'] },
  { k: 'selfReview', label: 'Self-review', who: 'agent', says: ['a fresh agent checks', 'the PR and fixes it'] },
  { k: 'mergeWait', label: 'Review · merge', who: 'you', away: 'mergeAway', says: ['you review, CI runs,', 'then you merge'] },
];
// Plain-language readings of the selected tickets, most useful first.
function pmInsights(ts, stats, prevTs) {
  const out = [];
  const youTotal = stats.gate.total + stats.mergeWait.total;
  const all = STAGES.reduce((a, s) => a + stats[s.k].total, 0);
  if (youTotal) {
    const big = stats.mergeWait.total >= stats.gate.total ? 'mergeWait' : 'gate';
    const st = stats[big], n = ts.filter(t => (t.seg[big] ?? 0) > 0).length || 1;
    out.push(`Your biggest wait is <b>${big === 'gate' ? 'the plan gate' : 'review → merge'}</b>: ${Math.round(100 * st.total / youTotal)}% of the time tickets wait on you (${hrs(st.total)}).${st.median != null && st.median * n < st.total / 3 ? ` The median ticket waits only ${hrs(st.median)}, so a few long waits drive it.` : ''}`);
  }
  // A plan gate left open while you're away stalls a ticket before any work starts; a PR left to merge
  // overnight is already done. Only the first costs anything.
  const parked = ts.filter(t => (t.seg.gateAway ?? 0) > 0);
  if (parked.length) out.push(`${parked.length} of ${ts.length} tickets sat at a plan gate while you were away: <b>${hrs(parked.reduce((a, t) => a + t.seg.gateAway, 0))}</b> the agents could have spent implementing.${stats.planning.median != null ? ` Plans come back a median ${hrs(stats.planning.median)} after kickoff, so clearing the gates before you leave lets the night go to implementing.` : ''}`);
  const away = stats.gate.away + stats.mergeWait.away;
  if (away) out.push(`Tickets also waited ${hrs(away)} while you were away${stats.mergeWait.away ? `, ${hrs(stats.mergeWait.away)} of it for a merge (that costs nothing: the work was done)` : ''}. None of it counts as waiting on you.`);
  const gated = ts.filter(stoppedAtGate);
  if (gated.length) out.push(`Plan gates wait on you a median ${hrs(medianOf(gated.map(t => t.seg.gate)))} while you're around. ${gated.length} of ${ts.length} tickets stopped at one.`);
  const agentStages = STAGES.filter(s => s.who === 'agent').sort((a, b) => stats[b.k].total - stats[a.k].total);
  if (all) out.push(`Agents spend most of their time <b>${agentStages[0].label.toLowerCase()}</b> (${Math.round(100 * stats[agentStages[0].k].total / all)}% of all ticket time).`);
  const longest = [...ts].sort((a, b) => (b.seg.mergeWait ?? 0) - (a.seg.mergeWait ?? 0))[0];
  if (longest?.seg.mergeWait > 4 * 3600e3) out.push(`Longest wait for a merge while you were around: <b>${esc(longest.ticket)}</b>, ${hrs(longest.seg.mergeWait)} (that includes CI).`);
  const reworked = ts.filter(t => t.rework > 0);
  if (ts.length) {
    const most = [...ts].sort((a, b) => b.rework - a.rework)[0];
    out.push(`${reworked.length} of ${ts.length} PRs needed commits after opening${most.rework >= 4 ? `; <b>${esc(most.ticket)}</b> needed ${most.rework} (${most.size} lines changed — big PRs draw rework)` : ''}.`);
  }
  if (prevTs?.length) {
    const share = xs => { const y = xs.reduce((a, t) => a + t.seg.you, 0), g = xs.reduce((a, t) => a + t.seg.agent, 0); return y + g ? y / (y + g) : 0; };
    const [now, then] = [share(ts), share(prevTs)];
    out.push(`Your share of ticket time went from ${Math.round(100 * then)}% the prior week to ${Math.round(100 * now)}% — ${now < then ? 'less of the pipeline is waiting on you' : 'more of the pipeline is waiting on you'}.`);
  }
  return out;
}
function renderPipeline(m) {
  const weeks = m.weeks.map(w => w.week);
  const sel = pmWeek === 'all' ? null : pmWeek === 'latest' ? weeks[0] : Number(pmWeek);
  const ts = sel == null ? m.tickets : m.tickets.filter(t => weekStart(t.mergedAt) === sel);
  const prevWeek = sel != null ? weeks[weeks.indexOf(sel) + 1] : null;
  const prevTs = prevWeek != null ? m.tickets.filter(t => weekStart(t.mergedAt) === prevWeek) : null;
  const stats = Object.fromEntries(STAGES.map(s => {
    const vals = ts.filter(t => s.k !== 'gate' || stoppedAtGate(t)).map(t => t.seg[s.k]).filter(v => v != null);
    const away = s.away ? ts.reduce((a, t) => a + (t.seg[s.away] ?? 0), 0) : 0;
    return [s.k, { median: medianOf(vals), total: vals.reduce((a, v) => a + v, 0), away }];
  }));
  const all = STAGES.reduce((a, s) => a + stats[s.k].total, 0) || 1;
  const maxTotal = Math.max(...STAGES.map(s => stats[s.k].total)) || 1;
  // Node size = the stage's share of all ticket time (area-true: radius grows with the square root).
  const X = i => 80 + i * 168, Y = 74;
  const r = s => 10 + 26 * Math.sqrt(stats[s.k].total / maxTotal);
  const parts = [];
  STAGES.forEach((s, i) => parts.push(`<line class="pm-edge" x1="${X(i)}" y1="${Y}" x2="${X(i + 1)}" y2="${Y}"/>`));
  STAGES.forEach((s, i) => {
    const R = r(s), st = stats[s.k];
    const shape = s.who === 'you'
      ? `<polygon class="shape" points="${X(i)},${Y - R * 1.25} ${X(i) + R * 1.25},${Y} ${X(i)},${Y + R * 1.25} ${X(i) - R * 1.25},${Y}"/>`
      : `<circle class="shape" cx="${X(i)}" cy="${Y}" r="${R}"/>`;
    parts.push(`<g class="pm-node pm-${s.who}-node"><title>${esc(`${s.label} (${s.who === 'you' ? 'waiting on you' : 'agent'}): median ${hrs(st.median)} per ticket, ${hrs(st.total)} in total, ${Math.round(100 * st.total / all)}% of all ticket time${st.away ? `; another ${hrs(st.away)} while you were away, not counted` : ''}`)}</title>
      ${shape}
      <text class="pm-label" x="${X(i)}" y="18">${esc(s.label)}</text>
      <text class="pm-dur" x="${X(i)}" y="134">${Math.round(100 * st.total / all)}%</text>
      <text class="pm-share" x="${X(i)}" y="150">${hrs(st.total)} · median ${hrs(st.median)}</text>
      <text class="pm-says" x="${X(i)}" y="168">${esc(s.says[0])}</text>
      <text class="pm-says" x="${X(i)}" y="181">${esc(s.says[1])}</text>
      ${st.away ? `<text class="pm-away-note" x="${X(i)}" y="198">+${hrs(st.away)} while you were away</text>` : ''}</g>`);
  });
  const done = STAGES.length;
  parts.push(`<g class="pm-node pm-done-node"><circle class="shape" cx="${X(done)}" cy="${Y}" r="14"/><text class="pm-glyph" x="${X(done)}" y="${Y}">✓</text>
    <text class="pm-label" x="${X(done)}" y="18">Merged</text><text class="pm-dur" x="${X(done)}" y="134">${ts.length}</text>
    <text class="pm-share" x="${X(done)}" y="150">tickets</text><text class="pm-says" x="${X(done)}" y="168">lead time median</text>
    <text class="pm-says" x="${X(done)}" y="181">${hrs(medianOf(ts.map(t => t.seg.lead)))} kickoff → merge</text></g>`);
  const opts = [['latest', `Latest week (${day(weeks[0])})`], ...weeks.slice(1).map(w => [String(w), `Week of ${day(w)}`]), ['all', 'All weeks']];
  // The picker is fixed markup; its options are rebuilt only when the weeks change, so it never
  // closes or shifts under the cursor on a refresh.
  const key = opts.map(o => o.join('=')).join('|');
  if ($('#pm-week').dataset.key !== key) {
    $('#pm-week').innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    $('#pm-week').dataset.key = key;
  }
  $('#pm-week').value = pmWeek;
  $('#pm-pipeline').innerHTML = `<div class="pm-explain">Each shape is a stage every ticket passes through, sized by its share of all ticket time. Below it: that share, the total hours, and the median per ticket. When the median is much smaller than the total suggests, a few long waits are driving it. Circles are agent work; diamonds are where tickets wait on you. Time a ticket waited while you were away (nights, mostly) is left out, and shown in grey under the diamond.</div>
    <svg class="pm-flow" viewBox="0 0 1000 206" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>
    <div class="pm-insights">${pmInsights(ts, stats, prevTs).map(s => `<div>▸ ${s}</div>`).join('')}</div>
    <div class="res-note">Stage times come from when each run file was last written, plan-gate waits from worker transcripts, merges from ${esc(scmName())}. Approximate: a re-dispatched ticket's rewritten files drop out of the stage they cover. You're away during any gap of 3 h or more between your prompts or dialog answers in any Claude session.</div>`;
}
$('#pm-week').onchange = e => { pmWeek = e.target.value; renderMetrics(); };
// Monday 00:00 local, matching the server's weekOf.
const weekStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
document.querySelectorAll('#pm-view button').forEach(b => b.onclick = () => {
  pmView = b.dataset.v;
  try { localStorage.setItem('mc.pmView', pmView); } catch { /* not remembered */ }
  renderMetrics();
});
function renderMetrics() {
  const m = state.metrics;
  document.querySelectorAll('#pm-view button').forEach(b => b.classList.toggle('on', b.dataset.v === pmView));
  for (const [id, v] of [['#pm-pipeline', 'pipeline'], ['#pm-pipe-head', 'pipeline'], ['#pm-tiles', 'table'], ['#pm-weeks', 'table'], ['#pm-tickets', 'table']])
    $(id).style.display = pmView === v ? '' : 'none';
  if (!m) { if (pmView === 'pipeline') $('#pm-pipeline').innerHTML = '<div class="placeholder">Reading runs, transcripts and GitHub… (the first read takes about 10 s)</div>'; return; }
  $('#pm-at').textContent = `${m.tickets.length} merged tickets · built ${ago(m.at)}`;
  if (!m.tickets.length) { $('#pm-tiles').innerHTML = $('#pm-pipeline').innerHTML = '<div class="placeholder">No merged orchestrated tickets yet.</div>'; return; }
  if (pmView === 'pipeline') return renderPipeline(m);
  const [cur, prev] = m.weeks;
  const share = w => (w.agent + w.you ? w.you / (w.agent + w.you) : 0);
  const pct = x => `${Math.round(100 * x)}%`;
  $('#pm-tiles').innerHTML = [
    ['Merged · latest week', String(cur.merged), `week of ${day(cur.week)}${prev ? ` · prior week ${prev.merged}` : ''}`],
    ['Median lead time', hrs(cur.medianLead), `kickoff → merged${prev ? ` · prior week ${hrs(prev.medianLead)}` : ''}`],
    ['Waiting on you', pct(share(cur)), `of ticket time, while you were around${prev ? ` · prior week ${pct(share(prev))}` : ''}`, share(cur)],
    ['Rework', (cur.rework / cur.merged).toFixed(1), `commits after PR opened, per PR · ${cur.reworked} of ${cur.merged} PRs`],
  ].map(([label, value, sub, meter]) => `<div class="res-tile ${meter != null ? 'pm-you-tile' : ''}"><div class="res-label">${esc(label)}</div>
    <div class="res-value">${esc(value)}</div><div class="res-sub" title="${esc(sub)}">${esc(sub)}</div>
    ${meter != null ? `<div class="res-meter"><i style="width:${100 * meter}%"></i></div>` : ''}</div>`).join('');
  const weekTotal = w => w.agent + w.you + (w.away ?? 0);
  const maxWeek = Math.max(...m.weeks.map(weekTotal)) || 1;
  $('#pm-weeks').innerHTML = `<div class="pm-explain">Each bar is one week's merged tickets: cyan is time agents spent working, magenta is time tickets sat waiting on you (plan gates, then review → merge), grey is time they waited while you were away. Longer bars mean more ticket-hours, not more effort from you.</div>
    <div class="pm-head">By week <span class="pm-legend"><i class="pm-agent"></i>agent <i class="pm-you"></i>waiting on you <i class="pm-away"></i>you away</span></div>
    ${m.weeks.map(w => `<div class="pm-week" title="${esc(`${w.merged} merged · agent ${hrs(w.agent)} · you ${hrs(w.you)} (plan gates ${hrs(w.gate)}) · while you were away ${hrs(w.away ?? 0)} · median lead ${hrs(w.medianLead)} · ${w.rework} rework commits`)}">
      <span class="pm-wk">${esc(day(w.week))}</span>
      <div class="pm-track"><div style="width:${100 * weekTotal(w) / maxWeek}%">${pmBar([['agent', w.agent, 'agent'], ['waiting on you', w.you, 'you'], ['while you were away', w.away ?? 0, 'away']], weekTotal(w))}</div></div>
      <span class="pm-num">${w.merged} merged · agent ${hrs(w.agent)} · you ${hrs(w.you)}${w.away ? ` · away ${hrs(w.away)}` : ''}</span></div>`).join('')}`;
  $('#pm-tickets').innerHTML = `<table><thead><tr><th>Ticket</th><th>Merged</th><th class="pm-tl" title="The ticket's stages in order, each as wide as its share of the ticket's time: planning, plan gate, implementing, self-review, review → merge, with waits while you were away in grey. Hover a segment for its time.">Where the time went</th><th title="Kickoff to merge, wall-clock">Lead</th><th title="Time agents spent planning, implementing and self-reviewing">Agent</th><th title="Time the ticket waited on you while you were around: plan gate plus review → merge (which includes CI)">You</th><th title="Time the ticket waited while you were away (no prompt or answer from you for 3 h or more). Not counted in You.">Away</th><th title="Commits pushed after the PR opened: review and CI fixes">Rework</th><th title="Lines added + deleted">Size</th></tr></thead><tbody>${
    m.tickets.map(t => `<tr><td class="pname" title="${esc(t.title)}">${t.seg.approx ? '<span class="res-dim" title="A stage file is missing or was rewritten; those stages are left out">≈ </span>' : ''}<a href="${esc(t.pr)}" target="_blank" rel="noopener">${esc(t.ticket)}</a> <span class="res-dim">${t.prCount > 1 ? `${t.prCount} PRs · ` : ''}${esc(t.title)}</span></td>
      <td>${esc(when(t.mergedAt))}</td>
      <td class="pm-tl">${pmBar(SEGS.map(([k, label, who]) => [label, t.seg[k], who]), SEGS.reduce((a, [k]) => a + (t.seg[k] ?? 0), 0) || 1)}</td>
      <td>${hrs(t.seg.lead)}</td><td>${hrs(t.seg.agent)}</td><td>${hrs(t.seg.you)}</td><td class="res-dim">${t.seg.away ? hrs(t.seg.away) : ''}</td>
      <td title="Commits pushed after the PR opened (review and CI fixes; a rebase over-counts)">${t.rework}</td><td title="Lines added + deleted">${t.size}</td></tr>`).join('')}</tbody></table>
    <div class="res-note">Stage times come from when each run file was last written, plan-gate waits from worker transcripts, merges from ${esc(scmName())}. "Review → merge" includes CI. Grey is time a ticket waited while you were away: a gap of 3 h or more with no prompt or answer from you in any Claude session. It isn't counted as waiting on you.</div>`;
}
async function pollMetrics() {
  if (!isOpen('process')) return;
  state.metrics = await api('/api/metrics') ?? state.metrics;
  renderMetrics();
}

/* ---------- Usage: what Claude cost, at list API prices, by ticket, project, model and session ---------- */
// Roles and projects are told apart by color: a fixed categorical order, validated (colorblind separation and
// contrast) against the panel's dark surface. "Other" is neutral grey.
const US_ROLES = [['implementer', 'implementer'], ['reviewer', 'reviewer'], ['orchestrator', 'orchestrator'], ['you', 'your own sessions']];
const US_HUES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'], US_OTHER = '#6c84a3';
const roleHue = r => US_HUES[US_ROLES.findIndex(([k]) => k === r)] ?? US_OTHER;
const money = x => x == null ? '—' : x < 10 ? `$${x.toFixed(2)}` : `$${Math.round(x).toLocaleString()}`;
const cents = x => x == null ? '—' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}¢`;
const share = x => x == null ? '—' : `${Math.round(100 * x)}%`;
const MODEL_NAMES = [[/opus/, 'Opus'], [/sonnet/, 'Sonnet'], [/fable/, 'Fable'], [/haiku/, 'Haiku']];
// "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5", "… (fast)" → "… fast".
const modelName = m => {
  const base = String(m).replace(' (fast)', '').replace(/-\d{8}$/, ''), fam = MODEL_NAMES.find(([re]) => re.test(base))?.[1];
  const ver = base.match(/-(\d+)(?:-(\d+))?$/)?.slice(1).filter(Boolean).join('.');
  return fam ? `${fam}${ver ? ` ${ver}` : ''}${String(m).endsWith('(fast)') ? ' fast' : ''}` : String(m);
};
// A bar of colored parts, as wide as its total against `max`; each part names itself on hover.
const usBar = (parts, max) => {
  const total = parts.reduce((a, [, v]) => a + v, 0);
  return `<div class="us-track"><div class="pm-bar" style="width:${max ? Math.max(1, 100 * total / max) : 0}%">${parts.filter(([, v]) => v > 0).map(([label, v, hue]) =>
    `<i style="flex-grow:${v / total};background:${hue}" title="${esc(`${label}: ${money(v)}`)}"></i>`).join('')}</div></div>`;
};
const usLegend = items => `<span class="pm-legend">${items.map(([label, hue]) => `<i style="background:${hue}"></i>${esc(label)}`).join(' ')}</span>`;
let usView = (() => { try { return localStorage.getItem('mc.usView') || 'tickets'; } catch { return 'tickets'; } })();
document.querySelectorAll('#us-view button').forEach(b => b.onclick = () => {
  usView = b.dataset.v;
  try { localStorage.setItem('mc.usView', usView); } catch { /* not remembered */ }
  renderUsage();
});
function usTickets(u) {
  const shown = u.epics.filter(e => e.epic).slice(0, 12), loose = u.epics.find(e => !e.epic);
  const max = Math.max(...shown.flatMap(e => e.tickets.map(k => k.total)), ...(loose?.tickets.slice(0, 10).map(k => k.total) ?? []), 0);
  const row = k => `<tr><td class="pname">${esc(k.ticket)} ${k.step ? `<span class="chip c-${esc(k.step)}">${esc(k.step)}</span>` : ''}</td>
    <td class="us-barcell">${usBar([['implementing', k.implement, roleHue('implementer')], ['reviewing', k.review, roleHue('reviewer')], ['orchestrator, shared', k.orchestrator, roleHue('orchestrator')]], max)}</td>
    <td>${money(k.implement)}</td><td>${money(k.review)}</td><td>${money(k.orchestrator)}</td><td><b>${money(k.total)}</b></td></tr>`;
  const head = '<tr><th>Ticket</th><th class="us-barcell"></th><th>Implementing</th><th>Reviewing</th><th title="The epic orchestrator’s cost, shared evenly among its tickets">Orchestrator</th><th>Total</th></tr>';
  const epic = e => `<tr class="us-epic"><td class="pname" colspan="2">${esc(e.epic)} <span class="res-dim">· ${e.tickets.length ? plural(e.tickets.length, 'ticket') : 'no ticket work yet'} · ${ago(e.last)}</span></td>
    <td colspan="2"></td><td>${money(e.orchestrator)}</td><td><b>${money(e.total)}</b></td></tr>${e.tickets.map(row).join('')}`;
  return `<div class="pm-head">Cost per ticket, by epic (latest first) ${usLegend([['implementing', roleHue('implementer')], ['reviewing', roleHue('reviewer')], ['orchestrator, shared among the epic’s tickets', roleHue('orchestrator')]])}</div>
    <div class="res-procs"><table><thead>${head}</thead><tbody>${shown.map(epic).join('')}
    ${loose ? `<tr class="us-epic"><td class="pname" colspan="2">No epic recorded <span class="res-dim">· ${plural(loose.tickets.length, 'ticket')}, the 10 costliest shown (worked outside an orchestration, or its run folder is gone)</span></td><td colspan="3"></td><td><b>${money(loose.total)}</b></td></tr>${loose.tickets.slice(0, 10).map(row).join('')}` : ''}
    </tbody></table></div>`;
}
function usProjects(u) {
  // A project is per machine: a peer's goes by `<machine>|<project>`.
  const recent = new Map(), named = k => { const [m, p] = unref(k); return m ? `${p} · ${m}` : p; };
  for (const w of u.weeks) for (const [p, v] of Object.entries(w.byProject)) recent.set(p, (recent.get(p) ?? 0) + v);
  const top = [...recent].sort((a, b) => b[1] - a[1]).slice(0, US_HUES.length).map(([p]) => p);
  const hue = p => US_HUES[top.indexOf(p)] ?? US_OTHER;
  const weeks = [...u.weeks].reverse(), totalOf = w => Object.values(w.byProject).reduce((a, v) => a + v, 0);
  const max = Math.max(...weeks.map(totalOf), 0);
  const bars = weeks.map(w => {
    const parts = top.map(p => [p, w.byProject[p] ?? 0, hue(p)]);
    const other = totalOf(w) - parts.reduce((a, [, v]) => a + v, 0);
    return `<div class="pm-week"><span class="pm-wk">${esc(day(w.week))}</span>${usBar([...parts, ['other projects', other, US_OTHER]], max)}
      <span class="pm-num">${money(totalOf(w))}${Object.entries(w.byProject).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([p, v]) => ` · ${esc(named(p))} ${money(v)}`).join('')}</span></div>`;
  }).join('');
  const all = u.projects.reduce((a, p) => a + p.all, 0) || 1;
  return `<div class="pm-head">By week ${usLegend([...top.map(p => [named(p), hue(p)]), ['other', US_OTHER]])}</div>${bars || '<div class="placeholder">No usage in the last 12 weeks.</div>'}
    <div class="res-procs"><table><thead><tr><th>Project</th><th>Last 7 days</th><th>Last 30 days</th><th title="Everything Cleon has counted, including transcripts Claude Code has since deleted">All counted</th><th>Share</th></tr></thead><tbody>
    ${u.projects.slice(0, 25).map(p => `<tr><td class="pname"><i class="us-dot" style="background:${hue(p.machine ? `${p.machine}|${p.project}` : p.project)}"></i>${esc(p.project)}${machineChip(p.machine)}</td>
      <td>${money(p.week)}</td><td>${money(p.month)}</td><td>${money(p.all)}</td><td>${share(p.all / all)}</td></tr>`).join('')}</tbody></table></div>`;
}
function usModels(u) {
  const byName = {};
  for (const r of u.models) for (const [m, v] of Object.entries(r.byModel)) byName[modelName(m)] = (byName[modelName(m)] ?? 0) + v;
  const cols = Object.entries(byName).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const names = Object.keys(byName).length > cols.length ? [...cols, 'Other'] : cols;
  const inCol = (m, n) => n === 'Other' ? !cols.includes(modelName(m)) : modelName(m) === n;
  const cell = (r, n) => money(Object.entries(r.byModel).filter(([m]) => inCol(m, n)).reduce((a, [, v]) => a + v, 0) || null);
  const total = u.models.reduce((a, r) => a + r.usd, 0), saves = u.models.reduce((a, r) => a + r.usd - r.ifSonnet, 0);
  return `<div class="pm-head">Last 30 days, by role and model</div>
    <div class="res-procs"><table><thead><tr><th>Role</th>${names.map(n => `<th>${esc(n)}</th>`).join('')}<th>Total</th>
      <th title="The same tokens at Sonnet 5.5 list prices, for whatever ran on a pricier model">On Sonnet 5.5</th><th>Would save</th></tr></thead><tbody>
    ${u.models.map(r => `<tr><td class="pname"><i class="us-dot" style="background:${roleHue(r.role)}"></i>${esc(US_ROLES.find(([k]) => k === r.role)?.[1] ?? r.role)}</td>
      ${names.map(n => `<td>${cell(r, n)}</td>`).join('')}<td><b>${money(r.usd)}</b></td><td>${money(r.ifSonnet)}</td><td>${money(r.usd - r.ifSonnet)} <span class="res-dim">${share(r.usd ? (r.usd - r.ifSonnet) / r.usd : null)}</span></td></tr>`).join('')}
    <tr class="us-epic"><td class="pname">All</td>${names.map(() => '<td></td>').join('')}<td><b>${money(total)}</b></td><td>${money(total - saves)}</td><td>${money(saves)}</td></tr>
    </tbody></table></div>
    <div class="pm-explain">“On Sonnet 5.5” reprices the same tokens; it doesn't know whether Sonnet would need more turns, or do the job as well. Opus 5.5 and Sonnet 5.5 both read the cache at $0.20 per million tokens, so a switch saves on output and cache writes only. Each role's model is set per role in the workflow config.</div>`;
}
function usSessions(u) {
  const label = s => `<i class="us-dot" style="background:${roleHue(s.role)}"></i>${esc(US_ROLES.find(([k]) => k === s.role)?.[1] ?? s.role)} · ${esc(s.project)}${s.epic || s.ticket ? ` · ${esc(s.epic ?? s.ticket)}` : ''}${machineChip(s.machine)}`;
  return `<div class="pm-head">Costliest sessions active in the last 7 days</div>
    <div class="res-procs"><table><thead><tr><th>Session</th><th>Model</th><th title="Over its whole life, subagents included">Cost</th><th>Last 7 days</th><th>Replies</th>
      <th title="Average cost of a reply: its first ten, then its latest ten. It grows as the session's context grows, since every reply re-reads it.">Per reply, first → latest</th><th>Last active</th><th></th></tr></thead><tbody>
    ${u.sessions.map(s => `<tr><td class="pname" title="${esc(s.id)}">${label(s)}</td><td>${esc(s.model ? modelName(s.model) : '—')}</td><td><b>${money(s.usd)}</b></td><td>${money(s.week)}</td>
      <td>${s.requests.toLocaleString()}</td><td>${cents(s.firstPer)} → <span class="${s.latestPer > 2 * s.firstPer ? 'us-grew' : ''}">${cents(s.latestPer)}</span></td><td>${ago(s.last)}</td>
      <td>${s.alive ? `<button class="jump-btn" data-session="${esc(s.id)}"${s.machine ? ` data-machine="${esc(s.machine)}"` : ''} data-what="${esc(s.project)}" title="Focus this session">⏵</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="placeholder">No sessions this week.</td></tr>'}
    </tbody></table></div>
    <div class="pm-explain">Every reply re-reads the whole conversation from the cache, so a long session's replies cost more as it grows: amber marks one whose latest replies cost more than twice its first. Starting fresh, or letting it compact, brings that down.</div>`;
}
function renderUsage() {
  const u = state.usage;
  document.querySelectorAll('#us-view button').forEach(b => b.classList.toggle('on', b.dataset.v === usView));
  if (!u) return;
  const t = u.tiles;
  $('#us-at').textContent = `built ${ago(u.at)}`;
  $('#us-tiles').innerHTML = [
    ['Last 7 days', money(t.week), `prior 7 days ${money(t.prior)}`],
    ['Last 30 days', money(t.month), `${share(t.opusShare)} on Opus · ${share(t.cacheShare)} reading and writing the cache`],
    ['Per merged ticket', t.perTicket ? money(t.perTicket.median) : '—', t.perTicket ? `median of ${t.perTicket.n} · 90% under ${money(t.perTicket.p90)} · with its orchestrator share` : 'no merged tickets counted yet'],
    ['All counted', money(t.all), u.since ? `since ${day(u.since)} · kept after Claude Code deletes transcripts` : ''],
  ].map(([label, value, sub]) => `<div class="res-tile"><div class="res-label">${esc(label)}</div><div class="res-value">${esc(value)}</div><div class="res-sub" title="${esc(sub)}">${esc(sub)}</div></div>`).join('');
  // Which machines these numbers cover (MC_PEERS), and any peer left out.
  const counted = (u.peers ?? []).filter(p => p.counted).map(p => p.machine);
  $('#us-peers').innerHTML = !u.peers?.length ? '' : (counted.length ? `Counts this machine and ${esc(counted.join(', '))}.` : 'Counts this machine only.')
    + u.peers.filter(p => !p.counted).map(p => ` <span class="us-missing">Not counted: ${esc(p.machine)}, ${esc(p.reason)}.</span>`).join('');
  $('#us-main').innerHTML = { tickets: usTickets, projects: usProjects, models: usModels, sessions: usSessions }[usView](u);
  bindJumps($('#us-main'));
  $('#us-codex').innerHTML = `<b>Codex</b> · ${u.codex.found ? `${plural(u.codex.sessions, 'session log')} found in ~/.codex/sessions; reading them isn't built yet.`
    : 'not used here yet (no session logs in ~/.codex/sessions). Once Codex reviews start, their cost shows here beside Claude’s, per ticket.'}`;
  $('#us-note').textContent = `Dollars are Anthropic's list API prices applied to the tokens Claude Code records for every reply. What you actually pay depends on your plan, so this is an estimate, not a bill.${u.unpriced.length ? ` Not priced: ${u.unpriced.map(x => `${x.model} (${x.tokens.toLocaleString()} tokens)`).join(', ')}.` : ''}`;
}
async function pollUsage() {
  if (!isOpen('usage')) return;
  state.usage = await api('/api/usage') ?? state.usage;
  renderUsage();
}

setInterval(tick.checks, 30000);
setInterval(tick.metrics, 60000);
setInterval(tick.resources, 10000);
setInterval(tick.docker, 10000);
setInterval(tick.poll, 5000);
setInterval(tick.slow, 60000);
const execTick = single(pollExec);
setInterval(execTick, 60000);
const usageTick = single(pollUsage);
setInterval(usageTick, 60000);
const herdrVerTick = single(pollHerdrVersion);
herdrVerTick();
setInterval(herdrVerTick, 10000);
pollInbox(); // then every 30 s, or 5 s while a scan runs
const groomTick = single(pollGroom);
groomTick();
setInterval(groomTick, 30000); // even with the panel closed: Groom's tab count is the queue
const waitingTick = single(pollWaiting);
waitingTick();
setInterval(waitingTick, 60000); // even with the panel closed, so an overdue item still notifies
