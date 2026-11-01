import { marked } from '/vendor/marked.esm.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = ms => {
  if (!ms) return '—';
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;
};
const api = p => fetch(p).then(r => r.ok ? (r.headers.get('content-type')?.includes('json') ? r.json() : r.text()) : null);

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
    const agents = h.agents.filter(a => a.workspace_id === w.workspace_id);
    return `<div class="card ${esc(w.agent_status)}">
      <div class="t"><span>${esc(w.label || w.workspace_id)}</span><span class="chip c-${esc(w.agent_status)}">${esc(w.agent_status)}</span></div>
      <div class="s">${w.tab_count} tabs · ${w.pane_count} panes${w.worktree ? ' · worktree' : ''}</div>
      ${agents.map(a => `<div class="s">▸ ${esc(a.name || a.display_agent || a.pane_id)} <span class="chip c-${esc(a.agent_status)}">${esc(a.agent_status)}</span></div>`).join('')}
    </div>`;
  }).join('') || '<div class="placeholder">No workspaces.</div>';
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

function flowSvg(flow, t) {
  const idx = flow.findIndex(f => f.id === t.step);
  const W = 100 / flow.length;
  const nodes = flow.map((f, i) => {
    const cls = ['node', i < idx || t.step === 'done' ? 'past' : '', i === idx && t.step !== 'done' ? 'current' : '',
      f.you ? 'you' : '', i === idx && t.failed ? 'failed' : ''].join(' ');
    const label = i === idx && t.fixRound ? 'Fix round' : f.label;
    return `<g class="${cls}" data-step="${f.id}">
      <rect x="${i * W + 0.6}%" y="6" width="${W - 1.2}%" height="28" rx="3"></rect>
      <text x="${i * W + W / 2}%" y="20">${esc(label)}${f.you ? ' ◆' : ''}</text></g>`;
  }).join('');
  return `<svg class="flow">${nodes}</svg>`;
}

function renderFlows() {
  if (!state.runs) return;
  const { flow, runs } = state.runs;
  const showStale = $('#show-stale').checked;
  const visible = runs.filter(r => showStale || r.active);
  $('#flows').innerHTML = visible.map(r => {
    const tickets = r.tickets.filter(t => showStale || !t.stale || t.step === 'done');
    return `<div class="epic">
      <div class="epic-head">${esc(r.epic)}<small>${esc(r.label ?? '')}${r.workspace ? ` · herdr ${esc(r.workspace)}` : ''}</small><small>${ago(r.updatedAt)}</small></div>
      <div>${tickets.map(t => `<div class="ticket-row ${t.stale ? 'stale' : ''}" data-epic="${esc(r.epic)}" data-ticket="${esc(t.ticket)}">
        <span class="id">${esc(t.ticket)}</span>${flowSvg(flow, t)}</div>`).join('')}</div>
    </div>`;
  }).join('') || '<div class="placeholder">No active orchestration runs. Tick “show inactive” for history.</div>';

  $('#flows').querySelectorAll('.ticket-row').forEach(row => {
    const open = step => ticketTile(row.dataset.epic, row.dataset.ticket, step);
    row.querySelector('.id').onclick = () => open(null);
    row.querySelectorAll('.node').forEach(n => n.onclick = () => open(n.dataset.step));
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
    panes: esc(t.panes.map(p => `${p.role} ${p.pane} (${p.lane})`).join(', ') || '—'),
  }) + `<div class="artifacts">${avail.map(n => `<button data-n="${esc(n)}">${n === 'plan' ? 'PLANS/' + esc(id) + '-plan.md' : esc(n)}</button>`).join('') || '<span class="placeholder">No artifacts for this step yet.</span>'}</div>`);
  el.querySelectorAll('.artifacts button').forEach(b => b.onclick = () =>
    fileTile(`rf:${epic}:${id}:${b.dataset.n}`, `${id} · ${b.textContent}`, epic,
      `/api/run-file?epic=${encodeURIComponent(epic)}&ticket=${encodeURIComponent(id)}&name=${encodeURIComponent(b.dataset.n)}`));
}
$('#show-stale').onchange = renderFlows;

/* ---------- Header stats ---------- */
function renderStats() {
  const live = state.sessions.filter(s => s.alive);
  const gates = (state.runs?.runs ?? []).flatMap(r => r.tickets).filter(t => !t.stale && ['plan-gate', 'human-review'].includes(t.step));
  const stats = [
    [live.filter(s => s.status === 'busy').length, 'working', false],
    [live.length, 'sessions', false],
    [gates.length, 'waiting on you', gates.length > 0],
    [(state.runs?.runs ?? []).filter(r => r.active).length, 'active epics', false],
    [state.projects.filter(p => p.dirty).length, 'dirty repos', false],
  ];
  $('#stats').innerHTML = stats.map(([n, l, hot]) => `<span class="stat ${hot ? 'hot' : ''}"><b>${n}</b>${l}</span>`).join('');
}
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 1000);

/* ---------- Knowledge graph ---------- */
const GROUP_COLORS = { vault: '#3ef0ff', memory: '#ff4fd8', 'claude-md': '#ffb547' };
const GROUP_NAMES = { vault: 'Obsidian vault', memory: 'Claude memory', 'claude-md': 'CLAUDE.md' };
$('#legend').innerHTML = Object.entries(GROUP_COLORS).map(([g, c]) => `<span><i style="background:${c};box-shadow:0 0 6px ${c}"></i>${GROUP_NAMES[g]}</span>`).join('');

let graph, graphData, highlight = new Set();
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
        if (n.kind === 'file') fileTile(`file:${n.id}`, n.name, GROUP_NAMES[n.group], `/api/file?id=${encodeURIComponent(n.id)}`);
    }
    graph.focusNode = focusNode;
    new ResizeObserver(() => graph.width(el.clientWidth).height(el.clientHeight)).observe(el);
    // Slow idle orbit until the user grabs the camera.
    let angle = 0, orbiting = true, dist = null;
    el.addEventListener('pointerdown', () => { orbiting = false; });
    setInterval(() => {
      if (!orbiting) return;
      const c = graph.cameraPosition();
      dist ??= Math.hypot(c.x, c.z) || 300;
      angle += 0.0025;
      graph.cameraPosition({ x: dist * Math.sin(angle), y: c.y, z: dist * Math.cos(angle) });
    }, 30);
  }
  graph.graphData(graphData);
}
$('#refresh-graph').onclick = () => loadGraph(true);
$('#search').oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  highlight = new Set(q ? graphData.nodes.filter(n => n.name.toLowerCase().includes(q)).map(n => n.id) : []);
  graph.nodeColor(graph.nodeColor());
};
// Enter opens the first matching file.
$('#search').onkeydown = e => {
  if (e.key !== 'Enter') return;
  const n = graphData.nodes.find(n => n.kind === 'file' && highlight.has(n.id));
  if (n) graph.focusNode(n);
};

/* ---------- Polling ---------- */
async function poll() {
  const [sessions, runs, herdr] = await Promise.all([api('/api/sessions'), api('/api/runs'), api('/api/herdr')]);
  Object.assign(state, { sessions: sessions ?? [], runs, herdr });
  renderSessions(); renderHerdr(); renderFlows(); renderStats();
}
async function pollProjects() { state.projects = (await api('/api/projects')) ?? []; renderProjects(); renderStats(); }

poll(); pollProjects(); loadGraph();
setInterval(poll, 5000);
setInterval(pollProjects, 60000);
