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
function tile(key, title, sub, html) {
  if (openTiles.has(key)) { const t = openTiles.get(key); t.style.zIndex = ++tileZ; t.animate([{ filter: 'brightness(2)' }, {}], 300); return t; }
  const el = document.createElement('div');
  el.className = 'tile';
  const off = (tileN++ % 6) * 28;
  el.style.left = `${Math.max(16, innerWidth / 2 - 280 + off)}px`;
  el.style.top = `${80 + off}px`;
  el.style.zIndex = ++tileZ;
  el.innerHTML = `<div class="tile-bar"><span class="title">${esc(title)}</span><span class="sub">${esc(sub)}</span><button title="Close">✕</button></div><div class="tile-body">${html}</div>`;
  el.querySelector('button').onclick = () => { el.remove(); openTiles.delete(key); };
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
  const fm = text?.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  t.querySelector('.tile-body').innerHTML = text == null ? '<p class="placeholder">Not readable.</p>'
    : (fm ? `<pre class="fm">${esc(fm[1])}</pre>` : '') + marked.parse(fm ? text.slice(fm[0].length) : text);
}
const dl = obj => `<dl>${Object.entries(obj).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

/* ---------- Sessions + Herdr ---------- */
let state = { sessions: [], runs: null, herdr: null, projects: [] };

function renderSessions() {
  const live = state.sessions.filter(s => s.alive);
  $('#sessions-count').textContent = `${live.length} live`;
  $('#sessions').innerHTML = state.sessions.map((s, i) => `
    <div class="card ${esc(s.status)} ${s.alive ? '' : 'dead'}" data-i="${i}">
      <div class="t"><span>${esc(s.name)}</span><span class="chip c-${esc(s.status)}">${esc(s.alive ? s.status : 'gone')}</span></div>
      <div class="s">${esc(s.cwd)}</div>
      <div class="s">${s.ticket ? `ticket ${esc(s.ticket)} · ` : ''}updated ${ago(s.updatedAt)}</div>
    </div>`).join('') || '<div class="placeholder">No sessions.</div>';
  $('#sessions').querySelectorAll('.card').forEach(c => c.onclick = () => {
    const s = state.sessions[c.dataset.i];
    const t = s.ticket && findTicket(s.ticket);
    tile(`session:${s.id}`, s.name, 'claude session', dl({
      status: esc(s.status), alive: s.alive ? 'yes' : 'no (stale session file)', cwd: esc(s.cwd), pid: esc(s.pid),
      kind: esc(s.kind), started: esc(new Date(s.startedAt).toLocaleString()), updated: ago(s.updatedAt), 'session id': esc(s.id),
      ...(t ? { 'flow step': `<span class="chip c-${esc(t.step)}">${esc(t.step)}</span> in ${esc(t.epic)}` } : {}),
    }));
  });
}

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
      ${agents.map(a => `<div class="s jump" data-pane="${esc(a.pane_id)}" title="focus in herdr">▸ ${esc(a.agent || a.pane_id)} <span class="chip c-${esc(a.agent_status)}">${esc(a.agent_status)}</span></div>`).join('')}
    </div>`;
  }).join('') || '<div class="placeholder">No workspaces.</div>';
  $('#herdr').querySelectorAll('.jump').forEach(j => j.onclick = () => focusPane(j.dataset.pane, j));
}

const livePane = pane => state.herdr?.online && state.herdr.agents.some(a => a.pane_id === pane);
async function focusPane(pane, el) {
  const r = await fetch('/api/herdr/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pane }) })
    .then(r => r.json()).catch(() => ({ ok: false, reason: 'no response' }));
  el.classList.toggle('jump-fail', !r.ok);
  el.classList.add('jump-flash');
  setTimeout(() => el.classList.remove('jump-flash'), 900);
  if (!r.ok) el.title = r.reason;
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
function findTicket(id) {
  for (const r of state.runs?.runs ?? []) { const t = r.tickets.find(t => t.ticket === id); if (t) return { ...t, epic: r.epic }; }
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
    const live = i + 1 === idx && !done && !t.fixRound;
    parts.push(`<path class="fc-edge ${i + 1 <= idx ? (live ? 'live' : 'past') : ''}" d="${d}"/>`);
    if (live && !t.stale) parts.push(particle(d));
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
    const past = i < idx || done, current = i === idx && !done;
    const glyph = current ? (t.failed ? '✕' : f.you ? '!' : i + 1) : past ? '✓' : i + 1;
    const label = current && t.fixRound ? 'Fix round' : f.label;
    const rings = current && !t.stale ? ['r1', 'r2', 'r3'].map(r => shape(f, x, `ring ${r}`)).join('') : '';
    parts.push(`<g class="fc-node ${past ? 'past' : ''} ${current ? 'current' : ''}" data-step="${f.id}">
      ${rings}${shape(f, x, 'shape')}
      <text class="glyph" x="${x}" y="${FC.y}">${glyph}</text>
      <text class="label" x="${x}" y="${FC.y + 36}">${esc(label)}${f.you ? ' ◆' : ''}</text></g>`);
  });
  return `<svg class="flowchart" viewBox="0 0 1000 130" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

let flowsKey = '';
function renderFlows() {
  if (!state.runs) return;
  const { flow, runs } = state.runs;
  const showStale = $('#show-stale').checked;
  // Re-rendering restarts the CSS animations, so only redraw when something visible changed.
  const key = JSON.stringify([runs, showStale, state.linear?.issues?.length, state.github?.myPrs, Math.floor(Date.now() / 60000)]);
  if (key === flowsKey) return;
  flowsKey = key;
  const issue = id => state.linear?.issues?.find(i => i.identifier === id);
  const pr = url => state.github?.myPrs?.find(p => p.url === url);
  const visible = runs.filter(r => showStale || r.active);
  $('#flows').innerHTML = visible.map(r => {
    const merged = r.tickets.filter(t => t.step === 'done');
    const open = r.tickets.filter(t => t.step !== 'done' && (showStale || !t.stale));
    return `<div class="epic" data-epic="${esc(r.epic)}">
      <div class="epic-head">${esc(r.epic)}<small>${esc(r.label ?? '')}${r.workspace ? ` · herdr ${esc(r.workspace)}` : ''} · ${ago(r.updatedAt)}</small>
        ${merged.length ? `<span class="merged">merged ${merged.map(t => `<span class="chip" data-ticket="${esc(t.ticket)}">✓ ${esc(t.ticket)}</span>`).join('')}</span>` : ''}</div>
      ${open.map(t => {
        const f = flow.find(f => f.id === t.step);
        const p = t.pr && pr(t.pr);
        const stepText = `${t.fixRound ? 'fix round' : f?.label ?? t.step}${t.since ? ` · ${ago(t.since).replace(' ago', '')}` : ''}`;
        return `<div class="tk ${f?.you ? 'you' : ''} ${t.failed ? 'failed' : ''} ${t.stale ? 'stale' : ''}" data-ticket="${esc(t.ticket)}">
          <div class="tk-info">
            <div class="id">${esc(t.ticket)}</div>
            <div class="title">${esc(issue(t.ticket)?.title ?? '')}</div>
            <div class="step">${f?.you && !t.stale ? '<span class="await">◆ awaiting you</span> · ' : ''}${esc(stepText)}${t.stale ? ' · inactive' : ''}</div>
            ${t.pr ? `<div class="pr"><a href="${esc(t.pr)}" target="_blank" rel="noopener">PR #${esc(t.pr.split('/').pop())}</a>${p ? ` <span class="chip c-${p.checks}">CI ${p.checks}</span>` : ''}</div>` : ''}
          </div>${flowSvg(flow, t)}</div>`;
      }).join('')}
    </div>`;
  }).join('') || '<div class="placeholder">No active orchestration runs. Tick “show inactive” for history.</div>';

  $('#flows').querySelectorAll('.epic').forEach(ep => {
    const epic = ep.dataset.epic;
    ep.querySelectorAll('.merged .chip').forEach(c => c.onclick = () => ticketTile(epic, c.dataset.ticket, null));
    ep.querySelectorAll('.tk').forEach(row => {
      row.querySelector('.id').onclick = () => ticketTile(epic, row.dataset.ticket, null);
      row.querySelectorAll('.fc-node').forEach(n => n.onclick = () => ticketTile(epic, row.dataset.ticket, n.dataset.step));
    });
  });
}

const STEP_FILES = {
  planning: ['plan', 'PLAN.md'], 'plan-gate': ['plan', 'PLAN.md'], implementing: ['KICKOFF.md', 'REDIRECT.md', 'REPORT.md'],
  'self-review': ['REVIEW_KICKOFF.md', 'REVIEW_REPORT.md'], 'human-review': ['REVIEW_REPORT.md'], done: ['REPORT.md'],
};
function ticketTile(epic, id, step) {
  const t = findTicket(id);
  if (!t) return;
  const names = step ? STEP_FILES[step] ?? [] : ['plan', ...t.files];
  const avail = names.filter(n => n === 'plan' || t.files.includes(n));
  const prLink = t.pr ? `<a href="${esc(t.pr)}" target="_blank" rel="noopener">${esc(t.pr)}</a>` : '—';
  const el = tile(`ticket:${id}:${step}`, `${id}${step ? ` · ${step}` : ''}`, epic, dl({
    'current step': `<span class="chip c-${esc(t.step)}">${esc(t.fixRound ? 'implementing (fix round)' : t.step)}</span>${t.failed ? ' <span class="chip" style="color:var(--red)">failed</span>' : ''}${t.stale ? ' (inactive)' : ''}`,
    'STAGE file': esc(t.stage ?? '—'), 'REVIEW_STAGE': esc(t.reviewStage ?? '—'), PR: `${prLink} ${esc(t.prState ?? '')}`,
    panes: t.panes.map(p => livePane(p.pane)
      ? `<button class="jump-btn" data-pane="${esc(p.pane)}">⏵ ${esc(p.role)} ${esc(p.pane)}</button>`
      : `<span class="pane-gone">${esc(p.role)} ${esc(p.pane)} (gone)</span>`).join(' ') || '—',
  }) + `<div class="artifacts">${avail.map(n => `<button data-n="${esc(n)}">${n === 'plan' ? 'PLANS/' + esc(id) + '-plan.md' : esc(n)}</button>`).join('') || '<span class="placeholder">No artifacts for this step yet.</span>'}</div>`);
  el.querySelectorAll('.jump-btn').forEach(b => b.onclick = () => focusPane(b.dataset.pane, b));
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
      <div class="t"><span><span class="pri" title="${esc(i.priorityLabel)}">${PRI[i.priority] ?? '·'}</span>${esc(i.identifier)}</span>${run && run.step !== 'done' ? `<span class="chip c-${esc(run.step)}">${esc(run.step)}</span>` : ''}</div>
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

/* ---------- Header stats ---------- */
function renderStats() {
  const live = state.sessions.filter(s => s.alive);
  const gates = (state.runs?.runs ?? []).flatMap(r => r.tickets).filter(t => !t.stale && ['plan-gate', 'human-review'].includes(t.step));
  const reviews = state.github?.reviewRequests?.length ?? 0;
  const failing = (state.github?.myPrs ?? []).filter(p => p.checks === 'failing').length;
  const stats = [
    [live.filter(s => s.status === 'busy').length, 'working', false],
    [live.length, 'sessions', false],
    [gates.length + reviews, 'waiting on you', gates.length + reviews > 0],
    [(state.runs?.runs ?? []).filter(r => r.active).length, 'active epics', false],
    [(state.linear?.issues ?? []).filter(i => i.state.type === 'started').length, 'in progress', false],
    [state.github?.myPrs?.length ?? 0, 'open PRs', false],
    ...(failing ? [[failing, 'CI failing', true]] : []),
  ];
  $('#stats').innerHTML = stats.map(([n, l, hot]) => `<span class="stat ${hot ? 'hot' : ''}"><b>${n}</b>${l}</span>`).join('');
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
    let angle = 0, orbiting = true, dist = null;
    el.addEventListener('pointerdown', () => { orbiting = false; });
    setInterval(() => {
      if (!orbiting || view !== 'map') return;
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
  v === 'map' ? graph?.resumeAnimation() : graph?.pauseAnimation();
  if (v === 'outline') renderOutline();
  if (v === 'links') initLinks();
  v === 'links' ? links2d?.resumeAnimation() : links2d?.pauseAnimation();
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

/* ---------- Polling ---------- */
async function poll() {
  const [sessions, runs, herdr] = await Promise.all([api('/api/sessions'), api('/api/runs'), api('/api/herdr')]);
  Object.assign(state, { sessions: sessions ?? [], runs, herdr });
  renderSessions(); renderHerdr(); renderFlows(); renderStats();
}
async function pollSlow() {
  const [projects, linear, github] = await Promise.all([api('/api/projects'), api('/api/linear'), api('/api/github')]);
  Object.assign(state, { projects: projects ?? [], linear, github });
  renderProjects(); renderLinear(); renderGithub(); renderFlows(); renderStats();
}

poll(); pollSlow(); loadGraph();
setInterval(poll, 5000);
setInterval(pollSlow, 60000);
