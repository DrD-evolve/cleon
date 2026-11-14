// Cleon — local-only dashboard server. Binds to 127.0.0.1; no auth, no cloud calls.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions } from './lib/sessions.mjs';
import { hostname, tmpdir, homedir } from 'node:os';
import { herdrSnapshot, herdrFocus, paneForPid, agentForSession, panePids, herdr, herdrMachines } from './lib/herdr.mjs';
import { raiseHerdrWindow, raiseCwdWindow, raiseFolderWindow, raiseClassWindow, raiseHerdrClient, raisePidWindow, raiseHerdrAnywhere,
  closeClassWindows, placeClassWindow, raisePeerHerdr } from './lib/vscode.mjs';
import { herdrVersions, herdrExec, pauseState, restartServer, bringUpToDate } from './lib/herdr-update.mjs';
import { focusSession } from './lib/focus.mjs';
import { listOrchestrators, listWorkers, listSessionActivity } from './lib/orchestrators.mjs';
import { sampleResources } from './lib/resources.mjs';
import { EXCLUDE_SRC } from './lib/config.mjs';
import { sampleDocker, pruneDocker, removeImage, watchDockerEvents } from './lib/docker.mjs';
import { listAttention } from './lib/attention.mjs';
import { answerGate } from './lib/gate.mjs';
import { EXCLUDE, GIT_DIR, ROOT, excludesFolder } from './lib/config.mjs';
import { execFile } from './lib/bin.mjs'; // not node's: see lib/bin.mjs
import { taskOutput } from './lib/tasks.mjs';
import { listSessionPrs } from './lib/sessionprs.mjs';
import { cached } from './lib/shared.mjs';
import { listRuns, readRunFile, runLocations, settleRuns, roleConfigFor, verifyCommandFor, ticketLaunches, FLOW } from './lib/runs.mjs';
import { spansByTicket, ticketModels } from './lib/stepmodel.mjs';
import adapter from './lib/adapters/index.mjs';
import { PEERS_SRC, HEADLESS, PROJECT_LIST } from './lib/config.mjs';
import { parsePeers, peerSource, ref, mergeList, mergeOrchestrators, mergeActivity, mergeWorkers, mergeStepModels, mergeHerdr, peerRuns, peerReviewOnly, peerSamples, peerCounts } from './lib/peers.mjs';
import { buildIndex, stillIndexed, redactor, fileId } from './lib/knowledge.mjs';
import { buildText, search } from './lib/search.mjs';
import { matcher, MAX_FAILS } from './lib/belt-match.mjs';
import { listProjects, findProject } from './lib/projects.mjs';
import { resolveIn, listFolder, collapsedDir, previewClass, readPreview, readRaw, runsCode, openProjectFile, gitMarks, gitBranch, hasGit, markOf } from './lib/project-tree.mjs';
import { walkCached, memoryFolder, mcpReader, mcpMatches, readMentionTexts, mentionFlags, gitExtra, matchLinear, matchPrs } from './lib/project-readiness.mjs';
import { buildCandidates } from './lib/today.mjs';
import { readFacts } from './lib/today-read.mjs';
import { openInHerdr, openInBash, openInVscode, startInHerdr, attachHerdrWindow, serveHeadless, cleanEnv, openFile, hasDefaultApp } from './lib/open.mjs';
import { supervise, freePort, portFree, readTunnels, writeTunnels, killOrphans } from './lib/tunnel.mjs';
import { restartOrchestrator } from './lib/resume.mjs';
import { linearIssues } from './lib/linear.mjs';
import { refreshed } from './lib/refresh.mjs';
import { scmSummary, scmName, prChecks, prNumber } from './lib/scm.mjs';
import { processMetrics, processInputs } from './lib/metrics.mjs';
import { scanUsage, usageInput, usageReport, codexStatus } from './lib/usage.mjs';
import { runScan, runClaude, stopScans, readState, writeState, filingsIn, inboxView, ingestCommand, projectId, parseHours, slotOf, nextScan,
  scanUsageFiles, usd as scanUsd, localDate } from './lib/scan.mjs';
import { SCAN_ON, SCAN_HOURS_SRC, SCAN_MODEL, SCAN_BUDGET, MATCH_ON } from './lib/config.mjs';
import { TODAY_ON, TODAY_HOUR_SRC, TODAY_DAY_SRC, TODAY_READ_SRC, TODAY_MODEL, TODAY_BUDGET_SRC } from './lib/config.mjs';
import { runPlanner, readToday, writeToday, autoRunDue, withAttempt, nextAuto, singleRun, parseBudget, parseHour, parseDay } from './lib/today-plan.mjs';
import { collectExcerpts, parseRead } from './lib/today-excerpts.mjs';
import { putItem, clearBox } from './lib/today-edit.mjs';
import { readWaiting, writeWaiting, cleanItem, saveItem, closeItem, notYet, toCheck, applyAnswers, waitingView, prune } from './lib/waiting.mjs';
import { readGroom, writeGroom, groomQueue, snoozeUntil, pruneGroom, ticketCommand } from './lib/groom.mjs';
import { BITBUCKET_URL } from './lib/config.mjs';
import { execCards, readSnapshots, snapshotIfDue } from './lib/exec.mjs';
import { activity, asking } from './lib/activity.mjs';
import { SUPPORTED as CLOSE_SUPPORTED, closable, closer, notRunning, readReopen, writeReopen } from './lib/close.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// .env is loaded by lib/config.mjs, imported (through the lib modules) before this line runs.

// Remote APIs are cached so several open tabs don't multiply calls. A call that arrives while the
// value is being fetched waits for that fetch rather than starting another, so the endpoints a page
// poll hits at once share one result.
// Read by several endpoints in every 5 s poll (and by every open window), so read once and shared
// for a moment: the herdr snapshot is a herdr process per session, the session list a file read and
// a pid check per session, the repo scan two git processes per repo. Actions read their own fresh copy.
const herdrShared = cached(() => herdrSnapshot(), 2000);
const sessionsShared = cached(() => listSessions(), 1000);
// The run folders: one poll reads them from several routes. A route that changes a run reads its own fresh copy
// (listRuns()) and calls runsShared.invalidate() after, so the next poll shows the result.
const runsShared = cached(() => listRuns(), 2000);
const projectsShared = cached(() => listProjects(), 30_000);
// Other machines' Cleons (MC_PEERS, lib/peers.mjs). Their rows join the read endpoints below, tagged with the
// machine; actions on those rows are handed to the peer they came from. A refused entry is never contacted.
const { peers: PEER_LIST, refused: PEERS_REFUSED } = parsePeers(PEERS_SRC);
// A peer's own Resources sample: `local=1`, so two Cleons that peer each other never keep each other sampling.
const PEER_RES = '/api/resources?local=1';
const PEER_USAGE = '/api/usage-input';
// A peer's first Resources sample takes a few seconds, its first usage read a full transcript scan; a timeout
// would count against the whole peer.
// A peer given as ssh://<host> is read through a tunnel this Cleon runs (startTunnels), so it has no URL until then.
const PEERS = PEER_LIST.map(p => peerSource({ name: p.name, url: p.url ?? null }, { slowPaths: { '/api/process-input': 30_000, [PEER_RES]: 20_000, [PEER_USAGE]: 60_000, '/api/step-models': 60_000 } }));
const TUNNELS = new Map(); // peer name → its tunnel (lib/tunnel.mjs supervise)
// Each peer's last answer for `path`, for the ones that have one (never waits on the network).
const fromPeers = path => PEERS.map(p => ({ name: p.name, value: p.get(path) })).filter(x => x.value != null);
// This machine's runs plus the peers', settled together: the peers' PRs are checked here (where the
// source-control token is), and a ticket merged on either machine reads done on both.
async function allRuns() {
  const local = await runsShared();
  const peers = fromPeers('/api/runs');
  const theirs = peerRuns(peers), reviewOnly = peerReviewOnly(peers);
  if (!theirs.length && !reviewOnly.length) return local;
  // settleRuns marks tickets done in place: copies, so the shared local read (runsShared) is never changed.
  const mine = local.runs.map(r => ({ ...r, tickets: r.tickets.map(t => ({ ...t })) }));
  return { ...await settleRuns([...mine, ...theirs]), reviewOnly: [...local.reviewOnly, ...reviewOnly] };
}
const linearCached = cached(() => linearIssues(), 60_000);
// GitHub or Bitbucket (MC_SCM); `scm` names it for the tab label.
const githubCached = cached(async () => ({ scm: scmName, ...await scmSummary() }), 60_000);
// The project page's archive-readiness strip (lib/project-readiness.mjs): this machine's config and home only. The paths come
// from config and home, never from the request; Linear and pull requests are only what those caches already hold (peek), so
// the strip never starts an outside request. A read that fails reads as "no" or "unknown", never as an error message.
const mcpCommands = mcpReader(join(homedir(), '.claude.json'));
const mentionTexts = cached(() => readMentionTexts({ root: ROOT, home: homedir(), projectList: PROJECT_LIST }, undefined, EXCLUDE), 30_000);
async function readiness(key, project) {
  const [walk, repo, memory, cmds, texts] = await Promise.all([walkCached(project.path), hasGit(project.path), memoryFolder(project.path, homedir(), undefined, EXCLUDE),
    mcpCommands(), mentionTexts()]);
  let git = null;
  if (repo) {
    const [marks, branch, extra] = await Promise.all([gitMarks(project.path), gitBranch(project.path), gitExtra(project.path)]);
    git = branch && extra ? { uncommitted: [...marks.values()].filter(m => m !== 'ignored').length, unpushed: extra.unpushed, upstream: branch.upstream, remote: extra.remote } : { unreadable: true };
  }
  return { key, activity: { at: walk.at, partial: walk.partial }, git, env: walk.env, memory,
    mcp: cmds === null ? null : mcpMatches(cmds, project.path),
    mentions: mentionFlags(texts, project, Boolean(PROJECT_LIST)),
    linear: matchLinear(linearCached.peek(), project.name), prs: matchPrs(githubCached.peek(), project.name) };
}
// Today view's candidates (lib/today.mjs): read-only, this machine only. Ahead/behind runs only on repos that already
// have uncommitted changes (lib/today-read.mjs), so a minute's cache keeps even that rare.
const todayCandidates = cached(async () => {
  const [linear, scm, projects, { runs }, { plans }] = await Promise.all([linearCached(), githubCached(), projectsShared(), runsShared(), runLocations()]);
  const facts = await readFacts({ projects, plansDirs: plans, exclude: EXCLUDE });
  return buildCandidates({ linear, scm, facts, runTickets: new Set(runs.flatMap(r => r.tickets.map(t => t.ticket))), exclude: EXCLUDE });
}, 60_000);
// CI checks, per check: in-flight tickets (not done, not stale) keyed by ticket, plus your own open
// PRs whose CI is pending or failing keyed "pr:<url>", so a PR outside any orchestration (a session
// working by hand) shows its jobs and mutation progress too. A peer's tickets are keyed `<machine>|<ticket>`.
const checksCached = cached(async () => {
  const { runs } = await allRuns();
  const live = runs.flatMap(r => r.tickets.map(t => ({ ...t, machine: r.machine }))).filter(t => t.pr && t.step !== 'done' && !t.stale);
  const mine = ((await githubCached())?.myPrs ?? []).filter(p => p.checks === 'pending' || p.checks === 'failing');
  const out = {};
  await Promise.all([
    ...live.map(async t => { const c = await prChecks(t.pr); if (c) out[ref(t.machine, t.ticket)] = c; }),
    ...mine.map(async p => { const c = await prChecks(p.url); if (c) out[`pr:${p.url}`] = c; }),
  ]);
  return out;
}, 30_000);
// System resources: sampled at most every 8s and never twice at once (a sample takes ~3s).
// Only requested while the Resources panel is on the board, so nothing runs when it's closed.
// Each is `refreshed` (lib/refresh.mjs): a failing refresh keeps the last value and is logged once, never unhandled.
const resources = refreshed('Resources', async () => {
  const labels = new Map((await sessionsShared()).filter(s => s.alive).map(s => [s.pid, `Claude · ${s.name}`]));
  labels.set(process.pid, 'Cleon server');
  return sampleResources(labels);
}, { ttl: 8000 });
// Docker: like resources, sampled at most every 8s and only while the Docker panel is on the board.
const docker = refreshed('Docker', () => sampleDocker(), { ttl: 8000 });
// Process metrics: only while the Process panel is on the board. The first build scans transcripts
// and asks GitHub about each merged PR (~10s); later ones reuse both caches. Never two at once.
const metrics = refreshed('Process', async () => {
  const { runs, reviewOnly } = await allRuns();
  const theirs = await peerInputs('/api/process-input');
  return processMetrics(runs, { reviewOnly, peers: theirs.map(p => ({ name: p.name, input: p.value })) });
}, { ttl: 60_000 });
// Each peer's answer for `path`, for a panel built from every machine (Process, Usage). Asked for only while
// that panel is open, so a peer's first answer (a transcript scan there, ~10 s) is waited for, up to 15 s:
// this holds up that panel alone, never the others.
async function peerInputs(path) {
  if (fromPeers(path).length < PEERS.length)
    await Promise.race([Promise.all(PEERS.map(p => p.settle())), new Promise(r => setTimeout(r, 15_000))]);
  return fromPeers(path);
}
// What this machine adds to a peer's Process panel: timestamps only (lib/metrics.mjs processInputs).
const processInputCached = cached(async () => { const { runs, reviewOnly } = await runsShared(); return processInputs(runs, { reviewOnly }); }, 60_000);
// This machine's transcripts, scanned at most once a minute and never twice at once (the ledger is updated in
// place): read by the Usage panel here and by each peer's (/api/usage-input). The first read goes through every
// transcript (~10 s); later ones read only what each has gained, and the ledger keeps totals for transcripts
// Claude Code deletes.
const usageFiles = cached(async () => {
  const { runs } = await runsShared();
  const files = await scanUsage({ ticketEpic: new Map(runs.flatMap(r => r.tickets.map(t => [t.ticket, r.epic]))) });
  // The Inbox scans and knowledge matches keep no transcript of their own: their recorded token counts join in,
  // credited to Cleon.
  return { files: { ...files, ...scanUsageFiles((await inboxState()).runs, HERE), ...scanUsageFiles((await MATCH.state()).runs, HERE, 'cleon-knowledge-match'),
    ...scanUsageFiles((await todayState()).runs, HERE, 'cleon-today') },
    projects: await projectsShared() };
}, 60_000);
// Usage: only while the Usage panel is on the board. Each peer's totals (its usageInput) are counted with this
// machine's, never saved here: each machine's ledger is its own.
const usage = refreshed('Usage', async () => {
  const [{ files, projects }, theirs] = await Promise.all([usageFiles(), peerInputs(PEER_USAGE)]);
  const { runs, reviewOnly } = await allRuns(); // a peer's tickets too: their epics, and which merged
  const tickets = [...runs.flatMap(r => r.tickets.map(t => ({ ticket: t.ticket, epic: r.epic, step: t.step }))),
    ...reviewOnly.map(t => ({ ticket: t.ticket, epic: null, step: t.step }))];
  const alive = new Set(mergeList(await sessionsShared(), fromPeers('/api/sessions')).filter(s => s.alive).map(s => s.id));
  return { ...usageReport(files, { projects, tickets, alive, peers: theirs.map(p => ({ name: p.name, input: p.value })) }),
    peers: peerCounts(PEERS.map(p => p.status()), new Set(theirs.map(p => p.name)), PEER_USAGE), codex: await codexStatus() };
}, { ttl: 60_000 });

// Inbox (lib/scan.mjs): a scheduled, read-only Claude scan of the calendar through the claude.ai Microsoft 365
// connector, flagging Teams meetings whose transcript isn't filed in their project yet. Only with MC_SCAN=1. Its
// state is per Cleon port, so a test Cleon never touches the real one, and it's never served to or merged from peers.
const SCAN_HOURS = parseHours(SCAN_HOURS_SRC);
const inboxFile = () => join(HERE, 'data', `inbox-${PORT}.json`);
let inbox = null, scanning = null;
const inboxState = async () => (inbox ??= await readState(inboxFile()));
const saveInbox = () => writeState(inboxFile(), inbox);
// Excluded projects (MC_EXCLUDE) are never listed (lib/projects.mjs), so never named to the model.
// The panel only needs projects' names and folders, which rarely change: kept 10 minutes, so its poll never waits
// on the repo scan's git calls (~15 s with many repos). A scan reads them fresh.
const inboxProjects = cached(projectsShared, 10 * 60_000);
const filingsCache = new Map();
const filingsCached = async path => {
  const hit = filingsCache.get(path);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const list = await filingsIn(path);
  filingsCache.set(path, { at: Date.now(), list });
  return list;
};
// Waiting on (lib/waiting.mjs): items you add; each scan looks for their answers. Per Cleon port, this machine only.
let waiting = null;
const waitingFile = () => join(HERE, 'data', `waiting-${PORT}.json`);
const waitingState = async () => (waiting ??= await readWaiting(waitingFile()));
const saveWaiting = () => writeWaiting(waitingFile(), (waiting = prune(waiting, Date.now())));
async function waitingPayload() {
  const s = await waitingState(), projects = await inboxProjects();
  return { scanOn: SCAN_ON, lastScan: (await inboxState()).last?.at ?? null, items: waitingView(s, Date.now()),
    projects: projects.map(p => ({ id: projectId(p), name: p.name })).sort((a, b) => a.name.localeCompare(b.name)) };
}
const startDeps = () => ({ snapshot: herdrSnapshot, run: herdr, gitDir: GIT_DIR, raiseClass: raiseClassWindow, headless: HEADLESS });
// Ingest: an interactive Claude session in the meeting's project that fetches and files its transcript, once the
// scan has found transcripts can be read. From the Inbox panel and the Groom queue.
async function ingestMeeting(id) {
  if ((await inboxState()).transcripts !== 'ok') return { ok: false, reason: "transcripts can't be read yet: download the VTT from Teams" };
  const flag = id ? (await inboxPayload()).flags.find(f => f.id === id) : null;
  if (!flag) return { ok: false, status: 404, reason: 'no such flag (filed or dismissed already?)' };
  const project = (await inboxProjects()).find(p => projectId(p) === flag.projectId);
  const command = project && ingestCommand(flag, flag.id, SCAN_MODEL);
  if (!command) return { ok: false, reason: "the folder or event id has characters Cleon won't type into a shell" };
  return startInHerdr(project, { command, label: `transcript ${flag.date}` }, startDeps());
}

// Groom queue (lib/groom.mjs): everything waiting to be set up, from the Inbox, Waiting on, review requests and
// Linear, with snoozes and the queue's own hides in data/groom-<port>.json. This machine only.
let groom = null;
const groomFile = () => join(HERE, 'data', `groom-${PORT}.json`);
const groomState = async () => (groom ??= await readGroom(groomFile()));
const LINK_HOSTS = ['github.com', 'linear.app', ...(() => { try { return BITBUCKET_URL ? [new URL(BITBUCKET_URL).hostname] : []; } catch { return []; } })()];
async function groomItems() {
  const [inbox, w, scm, lin, projects] = await Promise.all([inboxPayload(), waitingState(), githubCached(), linearCached(), inboxProjects()]);
  return { scm, lin, items: groomQueue({ inbox, waiting: waitingView(w, Date.now()), reviews: scm?.online ? scm.reviewRequests : [],
    linear: lin?.online ? lin.issues : [], projects: projects.map(p => ({ id: projectId(p), name: p.name })), state: await groomState(), hosts: LINK_HOSTS }) };
}
async function groomPayload() {
  const { scm, lin, items } = await groomItems();
  // Sources that couldn't be read are named, so an empty queue isn't mistaken for a clear one.
  const missing = [scm?.online ? null : `${scmName} (${scm?.reason ?? 'not read'})`, lin?.online ? null : `Linear (${lin?.reason ?? 'not read'})`].filter(Boolean);
  return { items, missing };
}
async function groomAct(key, action) {
  const item = key ? (await groomItems()).items.find(i => i.key === key) : null;
  if (!item) return { ok: false, status: 404, reason: 'no such item (snoozed, dismissed or done already?)' };
  const [verb, option] = String(action).split('-');
  if (!item.actions.includes(verb)) return { ok: false, reason: `${action} isn't offered for this item` };
  const id = key.slice(key.indexOf(':') + 1);
  const g = await groomState();
  if (verb === 'do') {
    if (item.doLabel !== 'Ingest') return { ok: false, reason: 'open its link instead' };
    return ingestMeeting(id);
  }
  if (verb === 'ticket') {
    const project = (await inboxProjects()).find(p => projectId(p) === item.project);
    const command = project && ticketCommand(item.kind, item.date);
    if (!command) return { ok: false, reason: "Cleon won't type that command into a shell" };
    return startInHerdr(project, { command, label: `ticket ${item.date}` }, startDeps());
  }
  if (verb === 'snooze') {
    const until = snoozeUntil(option);
    if (!until) return { ok: false, reason: 'snooze until tomorrow or monday' };
    g.snoozed[key] = until;
  } else if (verb === 'wait') {
    // Now tracked in Waiting on, so it leaves the queue.
    const c = cleanItem({ what: item.title, who: item.who, project: item.project }, (await inboxProjects()).map(projectId));
    if (!c.ok) return c;
    waiting = saveItem(await waitingState(), null, c.fields).state;
    await saveWaiting();
    g.hidden[key] = Date.now();
  } else if (verb === 'dismiss') {
    if (item.kind === 'transcript') { const m = (await inboxState()).meetings[id]; if (m) { m.dismissed = true; await saveInbox(); } }
    else if (item.kind === 'waiting') { const r = closeItem(await waitingState(), id); if (r.ok) { waiting = r.state; await saveWaiting(); } }
    else g.hidden[key] = Date.now();
  } else return { ok: false, reason: `unknown action ${action}` };
  const live = new Set([...(await groomItems()).items.map(i => i.key), ...Object.keys(g.hidden)]);
  groom = pruneGroom(g, live);
  await writeGroom(groomFile(), groom);
  return { ok: true };
}
// Exec cards (lib/exec.mjs): one per decision, from Usage, Process, the runs, Linear, each repo's last commit and the
// Groom queue. Last week's numbers that can't be rebuilt come from data/exec-<port>.jsonl, a line a week. Excluded
// projects (MC_EXCLUDE) are never named.
let execSnaps = null;
const execSnapFile = () => join(HERE, 'data', `exec-${PORT}.jsonl`);
async function execPayload() {
  const now = Date.now();
  const [u, m, r, lin, projects, g] = await Promise.all([usage(), metrics(), allRuns(), linearCached(), inboxProjects(),
    groomItems().then(x => x.items).catch(() => null)]);
  execSnaps ??= await readSnapshots(execSnapFile());
  const cards = execCards({ usage: u, metrics: m, runs: r.runs, linear: lin?.online ? lin.issues : null, projects, groom: g, snapshots: execSnaps, now });
  execSnaps = await snapshotIfDue(execSnapFile(), execSnaps, cards, now);
  return { at: now, cards };
}
function startScan() {
  if (scanning) return false;
  scanning = (async () => {
    const projects = await projectsShared();
    const filings = Object.fromEntries(await Promise.all(projects.map(async p => [p.path, await filingsCached(p.path)])));
    const asked = toCheck(await waitingState(), Date.now());
    const { state: next, answers } = await runScan({ state: await inboxState(), projects, filings, waiting: asked, model: SCAN_MODEL, budget: SCAN_BUDGET,
      run: (args, input) => runClaude(args, input, { env: cleanEnv(process.env) }) });
    // Dismissed while it ran: kept.
    for (const [id, m] of Object.entries(next.meetings)) if (inbox.meetings[id]?.dismissed) m.dismissed = true;
    inbox = { ...next, lastSlot: inbox.lastSlot };
    await saveInbox();
    // Answers go onto the list as it is now: an item closed or edited while the scan ran keeps that.
    if (answers) { waiting = applyAnswers(waiting, asked.map(a => a.id), answers, Date.now()); await saveWaiting(); }
    usageFiles.reset();
  })().catch(e => { inbox.last = { at: Date.now(), ok: false, reason: e.message }; return saveInbox(); }).finally(() => { scanning = null; });
  return true;
}
async function scheduleTick() {
  const s = await inboxState(), slot = slotOf(Date.now(), SCAN_HOURS);
  if (!slot || s.lastSlot === slot || scanning) return;
  s.lastSlot = slot;
  await saveInbox();
  startScan();
}
async function inboxPayload() {
  const s = await inboxState(), projects = await inboxProjects();
  const paths = new Set(Object.values(s.meetings).filter(m => m.project && !m.dismissed)
    .map(m => projects.find(p => projectId(p) === m.project)?.path).filter(Boolean));
  const filings = Object.fromEntries(await Promise.all([...paths].map(async p => [p, await filingsCached(p)])));
  const month = Date.now() - 30 * 864e5;
  return { on: SCAN_ON, model: SCAN_MODEL, hours: SCAN_HOURS, scanning: Boolean(scanning), next: SCAN_ON ? nextScan(Date.now(), SCAN_HOURS, s.lastSlot) : null,
    last: s.last, lastOk: s.lastOk, transcripts: s.transcripts, transcriptError: s.transcriptError,
    month: { scans: s.runs.filter(r => r.at >= month).length, usd: s.runs.filter(r => r.at >= month).reduce((a, r) => a + scanUsd(r.models), 0) },
    ...inboxView(s, { projects, filings }) };
}
// Today view's planner (lib/today-plan.mjs): a headless, read-only Claude run once a day (from MC_TODAY_HOUR, or as soon
// as Cleon is up after it) and on Replan; only with MC_TODAY=1. The checked plan and each run's token counts are kept
// in data/today-<port>.json: never the prompt or any excerpt text, and nothing of either is logged.
const TODAY_HOUR = parseHour(TODAY_HOUR_SRC), TODAY_HOURS = parseDay(TODAY_DAY_SRC), TODAY_READ = parseRead(TODAY_READ_SRC).read;
const TODAY_BUDGET = parseBudget(TODAY_BUDGET_SRC);
const todayFile = () => join(HERE, 'data', `today-${PORT}.json`);
let today = null;
const todayState = async () => (today ??= await readToday(todayFile()));
const saveToday = () => writeToday(todayFile(), today);
// One planner run at a time, from the schedule or Replan: a second start answers false.
const startPlan = singleRun(async trigger => {
  try {
    todayCandidates.invalidate();
    const [linear, scm, projects, { runs }, { plans }] = await Promise.all([linearCached(), githubCached(), projectsShared(), runsShared(), runLocations()]);
    const now = Date.now(), facts = await readFacts({ projects, plansDirs: plans, exclude: EXCLUDE });
    const candidates = buildCandidates({ linear, scm, facts, runTickets: new Set(runs.flatMap(r => r.tickets.map(t => t.ticket))), now, exclude: EXCLUDE });
    const excerpts = await collectExcerpts({ projects: facts.projects, dirty: facts.dirty, read: TODAY_READ, now, exclude: EXCLUDE });
    const next = await runPlanner({ state: await todayState(), candidates, excerpts, hours: TODAY_HOURS, now, model: TODAY_MODEL, budget: TODAY_BUDGET, trigger,
      run: (args, input) => runClaude(args, input, { env: cleanEnv(process.env), cwd: join(tmpdir(), 'cleon-today') }) });
    today = { ...next, attempts: today.attempts };
    await saveToday();
    usageFiles.reset();
  } catch (e) { today.last = { at: Date.now(), ok: false, reason: String(e.message).slice(0, 160), trigger }; await saveToday().catch(() => {}); }
});
async function todayTick() {
  const s = await todayState(), now = Date.now();
  if (startPlan.running() || !autoRunDue({ now, hour: TODAY_HOUR, hours: TODAY_HOURS, state: s })) return;
  // Counted only when it starts (the job's body runs after this line): a Replan that took the slot spends no try.
  if (!startPlan('auto')) return;
  today = withAttempt(s, now);
  await saveToday();
}
async function todayPayload() {
  if (!TODAY_ON) return { on: false, reason: 'the Today view is off (MC_TODAY=1 in .env turns it on)' };
  const s = await todayState(), now = Date.now();
  return { on: true, running: startPlan.running(), model: TODAY_MODEL, hour: TODAY_HOUR, read: TODAY_READ,
    hours: { start: TODAY_HOURS.start, end: TODAY_HOURS.end }, next: nextAuto({ now, hour: TODAY_HOUR, hours: TODAY_HOURS, state: s }),
    last: s.last, plan: s.plan };
}
// Background tasks' progress: the tail of each listed task's output file, attached in place.
// Agent tasks are left out: a subagent's progress is its own activity feed.
const listedTasks = (orch, workers) => [...orch.flatMap(o => o.tasks),
  ...Object.values(workers).flatMap(w => [...w.tasks, ...w.subagents.flatMap(s => s.tasks)])].filter(k => k.kind !== 'agent');
async function withProgress(orch, workers) {
  await Promise.all(listedTasks(orch, workers).map(async k => { k.out = await taskOutput(k.id); }));
}
async function orchestrators() {
  const o = await listOrchestrators(await sessionsShared(), await herdrShared());
  await withProgress(o, {});
  return o;
}
async function sessionActivity() {
  const a = await listSessionActivity(await sessionsShared());
  await Promise.all(Object.values(a).flatMap(x => x.tasks).map(async k => { k.out = await taskOutput(k.id); }));
  return a;
}
// Model and effort per step for every ticket in this machine's runs (read through the shared run read). Shared
// for a moment, so every open window and each peer's read join one pass over the transcripts.
const stepModels = cached(async () => {
  if (!adapter.roleOfStep) return {}; // an adapter without the step detail: every step shows "—"
  const { runs } = await runsShared(), { files, projects } = await usageFiles(), out = {}, verify = {};
  for (const r of runs) for (const t of r.tickets) verify[t.ticket] ??= await verifyCommandFor(r.root);
  const spans = await spansByTicket(files, projects, undefined, ticket => verify[ticket] ?? null);
  for (const r of runs) {
    const cfg = await roleConfigFor(r.root);
    for (const t of r.tickets) {
      if (out[t.ticket]) continue; // in several runs: the first (active, newest) copy, the one the page shows
      const s = spans.get(t.ticket), launches = await ticketLaunches(r.root, r.epic, t.ticket);
      // A review that sent the ticket back to implementing has run: self-review counts as reached.
      out[t.ticket] = ticketModels({ flow: FLOW.map(f => f.id), current: t.step, furthest: t.fixRound ? 'self-review' : t.step,
        ran: s?.ran ?? [], gates: s?.gates ?? [], events: s?.events ?? [], config: adapter.configured(cfg, launches) });
    }
  }
  return out;
}, 10_000);
async function workers() {
  const w = await listWorkers((await runsShared()).runs, await herdrShared(), await sessionsShared());
  await withProgress([], w);
  return w;
}
// Jumps into herdr open a window on the session when none shows it (see herdrFocus).
const attachHerdr = (session, cwd, id) => attachHerdrWindow(session, cwd, { gitDir: GIT_DIR, raiseClass: raiseClassWindow, ...(id ? { id } : {}) });
// MC_HEADLESS: no one sits at this machine (a worker its owner reaches over RDP or a tunnel), so jumps,
// restarts and herdr updates never raise or attach a window; herdr panes are still focused. Answers say `headless`.
const raiser = HEADLESS ? null : raiseHerdrAnywhere;
const attacher = HEADLESS ? null : attachHerdr;
const noWindow = async () => null;
// herdr updates (Herdr panel). Versions are read at most once a minute (a herdr process per running
// session); whether it's a pause is worked out on every ask, from the shared snapshot and run state.
const herdrVersionsCached = cached(() => herdrVersions(), 60_000);
const herdrPause = async (fresh = false) => {
  const snap = fresh ? await herdrSnapshot() : await herdrShared();
  const sessions = fresh ? await listSessions() : await sessionsShared();
  return pauseState(snap, await listOrchestrators(sessions, snap), (await (fresh ? listRuns() : runsShared())).runs);
};
let herdrUpdating = false;
async function updateHerdr() {
  if (herdrUpdating) return { ok: false, reason: 'an update is already running' };
  herdrUpdating = true;
  try {
    return await bringUpToDate({
      versions: () => herdrVersions(),
      pause: () => herdrPause(true),
      update: () => herdrExec(['update'], 300_000),
      restart: async session => {
        // A pane's folder for the server and the new window to start in (the server only uses it as a default).
        const cwd = (await herdrSnapshot()).panes?.find(p => p.session === session)?.cwd;
        // Headless: no windows to close, so none are reopened.
        return restartServer(session, { cwd, serve: serveHeadless, closeWindows: HEADLESS ? async () => [] : closeClassWindows, attach: attachHerdr, place: placeClassWindow });
      },
    });
  } finally { herdrUpdating = false; }
}
// Plan gate answers. The browser names a ticket and an option; the pane is worked out here, from the
// ticket's worker session, so a request can only ever reach a worker that is at its plan gate.
const herdrCall = args => new Promise(resolve => execFile('herdr', args, { timeout: 8000, windowsHide: true, maxBuffer: 4e6 },
  (err, out, errOut) => resolve({ ok: !err, out, reason: (errOut || err?.message || '').trim().split('\n')[0] })));
let gateBusy = false;
async function answerPlanGate({ ticket, choice, question, options }) {
  const t = (await listRuns()).runs.flatMap(r => r.tickets).find(t => t.ticket === ticket && !t.stale);
  if (!t || t.step !== 'plan-gate' || t.held) return { ok: false, reason: `${ticket} isn't at its plan gate` };
  const [sessions, snap] = [await listSessions(), await herdrSnapshot()];
  const w = (await listWorkers((await listRuns()).runs, snap, sessions))[ticket];
  const s = w && sessions.find(x => x.id === w.sessionId && x.alive);
  if (!s) return { ok: false, reason: "the ticket's worker session isn't running" };
  if (excludesFolder(s.cwd ?? '')) return { ok: false, reason: 'excluded session' };
  const live = sessions.filter(x => x.alive);
  const agent = await agentForSession(s, snap, live, panePids());
  if (!agent) return { ok: false, reason: "the worker isn't in a herdr pane; answer it there" };
  if (gateBusy) return { ok: false, reason: 'another answer is being sent' };
  gateBusy = true;
  try {
    return await answerGate({ question, options }, choice, {
      read: async () => (await herdrCall(['--session', agent.session, 'agent', 'read', agent.pane_id, '--source', 'visible'])).out,
      key: k => herdrCall(['--session', agent.session, 'pane', 'send-keys', agent.pane_id, k]),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
    });
  } finally { gateBusy = false; }
}
// Merge approval: one fixed prompt to the epic's orchestrator, never text from the browser. The
// wording is what mergeApprovals() recognises, so the ticket reads "merge approved" once it's sent.
// CI is mentioned only while it's part of the merge: checks still running or failing, or CI that couldn't
// be read. With no CI, or CI already green, the prompt just says merge.
export const mergePrompt = (pr, ticket, ciGate) => `Merge PR #${pr} for ${ticket}${ciGate ? ' when its CI is green' : ''}.`;
// Pure: does this PR's CI still stand between it and a merge? `checks` is the checks feed entry. No entry
// means CI couldn't be read (no SCM access, or the lookup failed): it may be running or failing, so it counts.
export const ciGates = checks => !checks || Boolean(checks.checks?.some(k => ['pending', 'fail', 'cancel'].includes(k.bucket)));
async function approveMerge({ ticket }) {
  const run = (await listRuns()).runs.find(r => r.tickets.some(t => t.ticket === ticket && !t.stale));
  const t = run?.tickets.find(t => t.ticket === ticket && !t.stale);
  if (!t || t.step !== 'human-review' || t.held) return { ok: false, reason: `${ticket} isn't at review·merge` };
  const pr = prNumber(t.pr);
  if (!pr) return { ok: false, reason: `${ticket} has no PR number` };
  // More than one live session can look like this epic's orchestrator. An approval from any of them
  // counts; the prompt goes only to the one in a herdr pane, and never when that's ambiguous.
  const all = (await listOrchestrators(await listSessions(), await herdrSnapshot())).filter(o => o.epic === run.epic);
  if (!all.length) return { ok: false, reason: `no live orchestrator for ${run.epic}` };
  if (all.some(o => o.approvals.some(a => (a.prs.includes(pr) || a.tickets.includes(ticket)) && (!t.since || a.t >= t.since))))
    return { ok: false, reason: 'already approved; the orchestrator has it' };
  const inHerdr = all.filter(o => o.pane);
  if (!inHerdr.length) return { ok: false, reason: "the orchestrator isn't in a herdr pane; tell it there" };
  if (inHerdr.length > 1) return { ok: false, reason: `${inHerdr.length} orchestrators in herdr panes claim ${run.epic}; tell the right one directly` };
  const o = inHerdr[0];
  if (o.status === 'working') return { ok: false, reason: 'the orchestrator is mid-turn; try again when its turn ends' };
  const checks = (await checksCached())[ticket];
  const text = mergePrompt(pr, ticket, ciGates(checks));
  const r = await herdrCall(['--session', o.pane.herdr, 'agent', 'prompt', o.pane.id, text]);
  if (!r.ok) {
    const code = (() => { try { return JSON.parse(r.out).error?.code; } catch { return null; } })();
    return { ok: false, reason: code === 'agent_blocked' ? 'the orchestrator is waiting on a question; answer that first' : `herdr refused: ${code ?? r.reason}` };
  }
  return { ok: true, sent: text, ...(checks ? {} : { ciUnknown: true }) };
}
const HOST = process.env.MC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MC_PORT ?? 4317);
// Close sessions (lib/close.mjs): this machine only, never in FORWARDED. The reopen list is per Cleon port.
const closedFile = () => join(HERE, 'data', `closed-sessions-${PORT}.json`);
const CLOSER = closer({ list: () => listSessions(), exclude: EXCLUDE, save: rows => writeReopen(closedFile(), rows) });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const VENDOR = {
  '/vendor/gridstack-all.js': 'node_modules/gridstack/dist/gridstack-all.js',
  '/vendor/gridstack.min.css': 'node_modules/gridstack/dist/gridstack.min.css',
  '/vendor/marked.esm.js': 'node_modules/marked/lib/marked.esm.js',
};

// The knowledge index (lib/knowledge.mjs): built on first ask and again on ⟳ (?refresh=1), one build at a time (a
// call during a build waits for it). /api/file reads only the files it lists. Each index carries its own search index
// (lib/search.mjs), read from those files once the tree is ready, so the map isn't kept waiting for it.
let knowledge = null, indexing = null;
const getIndex = (refresh, match = true) => (knowledge && !refresh ? Promise.resolve(knowledge)
  : indexing ??= buildKnowledge(match).then(i => (knowledge = { ...i, text: buildText(i).catch(e => { console.error(`knowledge search index: ${e.message}`); return null; }) }))
    .finally(() => { indexing = null; }));
// The knowledge match (lib/belt-match.mjs), only with MC_KNOWLEDGE_MATCH=1: its cached answers are applied to each build,
// and a build that leaves belt items unmatched and unanswered starts a pass in the background. When the pass is saved,
// the index is built again with its answers, after any build already under way, which read the old ones (that build
// starts no pass of its own, so a pass that fails isn't retried until the next ⟳; why it failed goes to the log, and so
// does how many items are held back after failing too often). Its state is per Cleon port, like the Inbox's.
const MATCH = matcher({ on: MATCH_ON, file: join(HERE, 'data', `knowledge-match-${PORT}.json`),
  run: (args, input) => runClaude(args, input, { env: cleanEnv(process.env), cwd: join(tmpdir(), 'cleon-match') }),
  onDone: async s => {
    if (!s.last?.ok) console.error(`knowledge match: ${s.last?.reason ?? 'failed'} (${s.last?.left ?? 0} items left for the next ⟳)`);
    if (s.last?.held) console.error(`knowledge match: ${s.last.held} items held back after failing ${MAX_FAILS} times (sent again when their text changes)`);
    usageFiles.reset();
    if (!s.last?.sent) return; // no new answers: the index stands
    await indexing?.catch(() => {});
    return getIndex(true, false);
  } });
async function buildKnowledge(match) {
  const index = await buildIndex({ matches: MATCH_ON ? (await MATCH.state()).items : {} });
  if (match) MATCH.start(index.pending, index.projects);
  return index;
}
// A file of the knowledge index, by its id, never by path: something that can't be an id isn't looked up at all. The
// path found is checked again on every ask (stillIndexed: MC_EXCLUDE doesn't match it, and it's still a plain file
// that resolves to where it's written to be under the folder it was read from), since it may have been swapped for a
// link since the index was built. → { path, index }, or null.
async function indexFile(id) {
  if (typeof id !== 'string' || !/^f[0-9a-f]{16}$/.test(id)) return null;
  const index = await getIndex(), path = index.files.get(id);
  return path && await stillIndexed(path, { roots: index.roots, exclude: EXCLUDE }) ? { path, index } : null;
}
// Pure: the item a file id belongs to (as its newest file or one of its versions), with its project's and group's names.
// A belt item is found in the first belt that holds it, or the root's.
function itemOf(tree, id) {
  for (const c of tree.children) for (const p of c.children) for (const g of p.children)
    for (const item of g.children) if (item.file === id || item.versions?.some(v => v.file === id)) return { item, project: p.name, group: g.name };
  for (const c of tree.children) for (const p of c.children) for (const item of p.belt ?? []) if (item.file === id) return { item, project: p.name, group: `belt · ${item.topic}` };
  for (const item of tree.belt ?? []) if (item.file === id) return { item, project: null, group: `belt · ${item.topic}` };
  return null;
}
// What /api/file serves each index type as. The text types (the viewer reads them as text) say they're UTF-8.
const FILE_TYPES = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', vtt: 'text/vtt', eml: 'message/rfc822',
  mht: 'multipart/related', mhtml: 'multipart/related', html: 'text/html', htm: 'text/html',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
};
const TEXT_FILES = new Set(['md', 'markdown', 'txt', 'csv', 'vtt', 'eml', 'mht', 'mhtml', 'html', 'htm']);
const OFFICE = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt']);
// Pure: whether an HTML file names its own encoding (a byte-order mark, or a <meta> charset in its first 1024 bytes, as
// Word and Outlook write). One that does is read in it; a charset sent with it would win over its own and garble it.
const ownCharset = b => (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)
  || /<meta[^>]*\bcharset\s*=/i.test(b.subarray(0, 1024).toString('latin1'));
// The headers a file of the index is served with. Every one is a sandboxed document (an opaque origin), so whatever it
// runs can't act as Cleon's page: its requests carry `Origin: null`, which every action (actionBody) and every API
// read (readAllowed) refuses. HTML may run its scripts there; nothing else may. Office files, and anything unknown, are
// downloads, never rendered. Text is UTF-8, unless it's HTML that says otherwise (ownCharset).
const fileHeaders = (ext, bytes) => {
  const type = FILE_TYPES[ext] ?? 'application/octet-stream', html = ext === 'html' || ext === 'htm';
  return { 'content-type': TEXT_FILES.has(ext) && !(html && ownCharset(bytes)) ? `${type}; charset=utf-8` : type,
    'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    'content-security-policy': html ? 'sandbox allow-scripts' : 'sandbox',
    ...(OFFICE.has(ext) || !FILE_TYPES[ext] ? { 'content-disposition': 'attachment' } : {}) };
};

const PROJECT_PAGE_CSP = "frame-src 'self'";
const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const text = (res, body) => body == null ? json(res, { error: 'not found' }, 404)
  : (res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }), res.end(body));

// Endpoints that act (focus herdr, raise windows) are POST-only and same-origin only, so another page
// in the browser can't drive them (a cross-site form post carries a foreign Origin; a no-cors fetch
// can't send JSON). Host is pinned to loopback so a DNS-rebound domain can't pass as same-origin.
// Returns the parsed JSON body, or null after answering the request itself.
const ownOrigin = req => req.headers.origin === `http://${req.headers.host ?? ''}`;
async function actionBody(req, res, max = 1024) {
  if (req.body) return req.body; // already read and checked (see FORWARDED)
  const host = req.headers.host ?? '';
  if (req.method !== 'POST' || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || !ownOrigin(req)
    || !req.headers['content-type']?.startsWith('application/json')) { json(res, { error: 'forbidden' }, 403); return null; }
  let body = '';
  for await (const c of req) { body += c; if (body.length > max) { json(res, { error: 'too large' }, 413); return null; } }
  let v;
  try { v = JSON.parse(body || '{}'); } catch { json(res, { error: 'bad json' }, 400); return null; }
  // Callers take a falsy answer as "already answered", so a body that isn't an object (null, false, 0, "", or an array)
  // is answered here rather than left hanging.
  if (v === null || typeof v !== 'object' || Array.isArray(v)) { json(res, { error: 'not a JSON object' }, 400); return null; }
  return v;
}

// Nearly every GET under /api/ does work on a cache miss (runs programs, asks GitHub or Linear, writes the Usage ledger;
// ?refresh=1 rebuilds the knowledge index), so another page must not be able to set them off. A sandboxed document
// (fileHeaders) sends `Origin: null` and `Sec-Fetch-Site: cross-site`; a page on another port sends its own Origin or
// `same-site`. Refused: an Origin that isn't Cleon's own, or a Sec-Fetch-Site other than same-origin (the page itself)
// or none (typed or bookmarked). A request with neither header is a peer (lib/peers.mjs), a script or curl, and passes.
const readAllowed = req => (req.headers.origin === undefined || ownOrigin(req))
  && ['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site']);

// The read endpoints marked "+ peers" return this machine's rows and each peer's (lib/peers.mjs), every
// peer row tagged `machine`.
const routes = {
  '/api/sessions': async () => mergeList(await sessionsShared(), fromPeers('/api/sessions')), // + peers
  '/api/session-prs': async () => listSessionPrs(await sessionsShared(), (await githubCached())?.myPrs),
  // + peers; `host`: this machine's name, which herdr starts its window titles with (a peer's window, raised here)
  '/api/herdr': async () => ({ ...mergeHerdr(await herdrShared(), fromPeers('/api/herdr')), host: hostname() }),
  '/api/herdr/version': async () => ({ ...await herdrVersionsCached(), pause: await herdrPause(), updating: herdrUpdating }),
  '/api/runs': allRuns, // + peers
  // + each tunnel this Cleon runs. Local only: ssh's error line names the account and the peer's address.
  '/api/peers': async () => PEERS.map(p => ({ ...p.status(), ...(TUNNELS.has(p.name) ? { tunnel: TUNNELS.get(p.name).status() } : {}) })),
  '/api/process-input': processInputCached, // for a peer's Process panel
  '/api/usage-input': async () => { const { files, projects } = await usageFiles(); return usageInput(files, projects); }, // for a peer's Usage panel
  '/api/projects': async () => projectsShared(),
  '/api/linear': linearCached,
  '/api/today/candidates': todayCandidates, // this machine only
  '/api/github': githubCached,
  '/api/checks': checksCached,
  // + each peer's own sample, under `peers` (asked for only while the Resources panel is open, never waited on).
  '/api/resources': async q => (q.get('local') === '1' ? resources()
    : { ...await resources(), peers: peerSamples(PEERS.map(p => ({ name: p.name, value: p.get(PEER_RES), status: p.status() }))) }),
  '/api/docker': () => docker(),
  '/api/metrics': () => metrics(),
  '/api/usage': () => usage(),
  '/api/today': () => todayPayload(), // this machine only: never forwarded or merged
  '/api/inbox': () => inboxPayload(), // this machine only: never forwarded or merged
  '/api/waiting': () => waitingPayload(), // this machine only, too
  '/api/groom': () => groomPayload(), // and this
  '/api/exec': () => execPayload(), // Usage and Process inside include peers, as their panels do
  '/api/orchestrators': async () => mergeOrchestrators(await orchestrators(), fromPeers('/api/orchestrators')), // + peers
  '/api/attention': async () => mergeList(await listAttention(await sessionsShared(), await herdrShared()), fromPeers('/api/attention')), // + peers
  '/api/workers': async () => mergeWorkers(await workers(), fromPeers('/api/workers')), // + peers
  '/api/session-activity': async () => mergeActivity(await sessionActivity(), fromPeers('/api/session-activity')), // + peers
  '/api/boot': async () => ({ boot: BOOT }),
  // What Close sessions… offers (pids from the session files, never from the page), the close under way and the reopen
  // list. Off Windows, nothing.
  '/api/close-sessions': async () => {
    if (!CLOSE_SUPPORTED) return { supported: false };
    const sessions = closable(await listSessions(), EXCLUDE);
    return { supported: true, sessions, job: CLOSER.state(), reopen: notRunning(await readReopen(closedFile()), sessions) };
  },
  // Which model and effort ran each step, of this machine's tickets and each peer's (lib/stepmodel.mjs), keyed by
  // ticket; a peer's by `<machine>|<ticket>`. `peers`: whether each peer's answer is in it, and why not.
  '/api/step-models': async () => ({ tickets: mergeStepModels(await stepModels(), fromPeers('/api/step-models')),
    peers: peerCounts(PEERS.map(p => p.status()), new Set(fromPeers('/api/step-models').map(p => p.name)), '/api/step-models') }),
  '/api/activity': async q => activity(Number(q.get('rev')) || 0, Number(q.get('at')) || 0),
  '/api/knowledge': async q => ({ root: ROOT, tree: (await getIndex(q.get('refresh') === '1')).tree }),
  // Names and text of the current index (waiting for its text to be read, the first time). Snippets are plain text.
  '/api/knowledge/search': async q => search(await (await getIndex()).text, q.get('q')),
};

// The exit code that asks scripts/launch.sh (which sets MC_SUPERVISED) to start the server again.
export const RESTART_CODE = 75;
// This process's start, so the page can tell the restarted server from the one that's exiting.
const BOOT = Date.now();

// Every request must name a loopback host (or MC_HOST), so a DNS-rebound page can't read the API either.
const hostOk = host => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || host.replace(/:\d+$/, '') === HOST;

// Each request runs with its path in `asking`, so the Activity panel can say which endpoint asked for
// every program and web request made while answering it.
export const server = createServer((req, res) => asking.run({ route: new URL(req.url, 'http://x').pathname }, () => handle(req, res)));

// Actions you can take on a peer's row, with each one's body limit. The body names the row's machine; such an
// action is checked here like any other, then handed to that peer (lib/peers.mjs `post`) without `machine`,
// and the peer acts on its own machine under its own guards. Without `machine` it's this machine's.
const FORWARDED = { '/api/gate/answer': 16_384, '/api/merge/approve': 1024, '/api/herdr/focus': 1024, '/api/session/focus': 1024, '/api/runs/restart': 1024 };
async function forward(res, path, { machine, ...body }) {
  const peer = PEERS.find(p => p.name === machine);
  if (!peer) return json(res, { ok: false, reason: `no peer named ${typeof machine === 'string' ? machine : '(not a name)'}` }, 400);
  const r = await peer.post(path, body);
  const here = !HEADLESS && JUMPS.has(path) && r.body?.ok && typeof r.body.session === 'string' ? { here: await peerWindow(peer, r.body, body.label) } : {};
  return json(res, { ...r.body, machine, ...here }, r.status);
}
// A jump the peer answered by focusing a herdr pane: the herdr window here that's switched to that machine
// (its saved machine, in herdr's sidebar) follows the focus, so it's raised and flashed. Found by its title,
// "<peer's host>: <workspace label>", the label read from the peer's herdr snapshot. With none showing it, the
// answer names the saved machine to switch a window to, or how to save one. A headless machine raises nothing.
const JUMPS = new Set(['/api/herdr/focus', '/api/session/focus']);
async function peerWindow(peer, { session, workspace }, asked) {
  const snap = peer.get('/api/herdr');
  const label = snap?.workspaces?.find(w => w.session === session && w.workspace_id === workspace)?.label ?? (typeof asked === 'string' ? asked : null);
  const raised = label ? await raisePeerHerdr(label, typeof snap?.host === 'string' ? snap.host : null) : null;
  if (raised) return { raised };
  const saved = (await herdrMachines()).find(m => m.enabled !== false && m.session === session && String(m.target).toLowerCase() === peer.name.toLowerCase());
  return saved ? { raised: null, switchTo: saved.label } : { raised: null, setup: `herdr machine add ${peer.name} --remote-session ${session}` };
}
// Reads passed through to a peer for its rows (`?machine=`): a plan or report, a task's output. The peer
// serves only what it would serve its own page.
const FORWARDED_READS = new Set(['/api/run-file', '/api/task-output']);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!hostOk(req.headers.host ?? '')) return json(res, { error: 'forbidden' }, 403);
  // Pages (/, /view, static files) stay open to a link from anywhere; the API answers only Cleon's own page (readAllowed),
  // whatever the method: a read route answers a POST too, and a form can post without asking.
  if (url.pathname.startsWith('/api/') && !readAllowed(req)) return json(res, { error: 'forbidden' }, 403);
  try {
    if (Object.hasOwn(FORWARDED, url.pathname)) {
      const body = await actionBody(req, res, FORWARDED[url.pathname]);
      if (!body) return;
      if (body.machine !== undefined) return forward(res, url.pathname, body);
      req.body = body; // the handler below reads it from here
    }
    if (FORWARDED_READS.has(url.pathname) && url.searchParams.has('machine')) {
      const q = new URLSearchParams(url.searchParams), machine = q.get('machine');
      q.delete('machine');
      const peer = PEERS.find(p => p.name === machine);
      if (!peer) return json(res, { error: `no peer named ${machine}` }, 404);
      const r = await peer.fetchRaw(`${url.pathname}?${q}`);
      res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store' });
      return res.end(r.body);
    }
    if (routes[url.pathname]) return json(res, await routes[url.pathname](url.searchParams));
    // A file of the knowledge index, as its own type (fileHeaders).
    if (url.pathname === '/api/file') {
      const f = await indexFile(url.searchParams.get('id'));
      const body = f && await readFile(f.path).catch(() => null);
      if (!body) return text(res, null);
      res.writeHead(200, fileHeaders(extname(f.path).slice(1).toLowerCase(), body));
      return res.end(body);
    }
    // What the viewer shows about a file of the index: its name, size and time, and the item it belongs to (its id, the
    // same for every version; title, project, group, and the item's versions, newest first, when it has more than one).
    // A belt item also gives the projects it orbits and why (`orbits`; empty when it orbits none). An excluded project's
    // name in the file's name shows as "(excluded)", as in the tree.
    if (url.pathname === '/api/file-info') {
      const id = url.searchParams.get('id'), f = await indexFile(id);
      const st = f && await stat(f.path).catch(() => null);
      if (!st) return json(res, { error: 'not found' }, 404);
      const at = itemOf(f.index.tree, id);
      return json(res, { id, name: redactor(f.index.hidden, f.index.shown)(basename(f.path)), ext: extname(f.path).slice(1).toLowerCase(), size: st.size, mtime: Math.round(st.mtimeMs),
        item: at?.item.id ?? null, title: at?.item.name ?? null, project: at?.project ?? null, group: at?.group ?? null, versions: at?.item.versions ?? null,
        ...(at?.item.orbits ? { orbits: at.item.orbits } : {}) });
    }
    if (url.pathname === '/api/herdr/focus') {
      const body = await actionBody(req, res);
      if (!body) return;
      const { pane, workspace, label } = body;
      const str = v => v === undefined || typeof v === 'string';
      if (!(pane || workspace) || !str(pane) || !str(workspace) || !str(label)) return json(res, { error: 'pane or workspace required' }, 400);
      const r = await herdrFocus({ pane, workspace, label }, undefined, raiser, attacher);
      return json(res, HEADLESS ? { ...r, headless: true } : r, r.ok ? 200 : 409);
    }
    if (url.pathname === '/api/session/focus') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (typeof body.id !== 'string') return json(res, { error: 'id required' }, 400);
      const r = await focusSession(body.id, {
        sessions: listSessions, snapshot: herdrSnapshot, paneForPid: pid => paneForPid(pid),
        raisePid: HEADLESS ? noWindow : pid => raisePidWindow(pid, { gitDir: GIT_DIR }), raiseCwd: HEADLESS ? noWindow : raiseCwdWindow,
        focusPane: t => herdrFocus(t, undefined, raiser, attacher),
      });
      return json(res, HEADLESS ? { ...r, headless: true } : r, r.ok ? 200 : 409);
    }
    if (url.pathname === '/api/docker/prune' || url.pathname === '/api/docker/image-rm') {
      const body = await actionBody(req, res);
      if (!body) return;
      const r = url.pathname.endsWith('prune') ? await pruneDocker(String(body.what))
        : typeof body.id === 'string' && (body.ref === null || typeof body.ref === 'string') ? await removeImage(body.id, body.ref)
        : { ok: false, reason: 'id and ref required' };
      await docker(true);
      return json(res, r, r.ok ? 200 : 409);
    }
    // The last lines of one background task's output, only for a task the dashboard lists now.
    if (url.pathname === '/api/task-output') {
      const id = url.searchParams.get('id');
      const listed = listedTasks(await listOrchestrators(await sessionsShared(), await herdrShared()),
        await listWorkers((await runsShared()).runs, await herdrShared(), await sessionsShared()));
      const ofSessions = Object.values(await listSessionActivity(await sessionsShared())).flatMap(a => a.tasks);
      if (![...listed, ...ofSessions].some(k => k.id === id)) return json(res, { error: 'not a listed task' }, 404);
      return json(res, await taskOutput(id, 60) ?? { size: 0, at: null, lines: [] });
    }
    if (url.pathname === '/api/gate/answer') {
      const body = await actionBody(req, res, 16_384);
      if (!body) return;
      const { ticket, choice, question, options } = body;
      if (typeof ticket !== 'string' || !Number.isInteger(choice) || typeof question !== 'string'
        || !Array.isArray(options) || !options.every(o => typeof o === 'string')) return json(res, { error: 'ticket, choice, question and options required' }, 400);
      const r = await answerPlanGate({ ticket, choice, question, options });
      runsShared.invalidate();
      return json(res, r, r.ok ? 200 : 409);
    }
    if (url.pathname === '/api/merge/approve') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (typeof body.ticket !== 'string') return json(res, { error: 'ticket required' }, 400);
      const r = await approveMerge({ ticket: body.ticket });
      runsShared.invalidate();
      return json(res, r, r.ok ? 200 : 409);
    }
    // The project page's file tree and text preview (lib/project-tree.mjs). This machine only: not in FORWARDED_READS, so a
    // ?machine= is ignored, and under /api/ so readAllowed answers only Cleon's own page. Each ask resolves the key and path
    // again; the tree lists one folder and reads no file, and the preview is plain text in a sandbox whatever the extension.
    if (url.pathname === '/api/project/tree') {
      const key = url.searchParams.get('key'), rel = url.searchParams.get('path') ?? '';
      const at = await resolveIn(key, rel, 'dir');
      if (!at) return json(res, { error: 'not found' }, 404);
      const { entries, more } = await listFolder(at.abs, undefined, { keep: p => !excludesFolder(p) });
      const repo = await hasGit(at.project.path), marks = repo ? await gitMarks(at.project.path) : null;
      const files = (await getIndex().catch(() => null))?.files;
      const out = entries.map(e => {
        const cls = e.type === 'file' ? previewClass(e.name) : { preview: 'none' };
        const id = cls.preview !== 'blocked' && e.type === 'file' ? fileId(join(at.abs, e.name)) : null;
        const indexed = id && files?.has(id);
        return { ...e, git: markOf(marks, [...at.segs, e.name].join('/'), e.type === 'dir'),
          ...(collapsedDir(e.name, e.type) ? { collapsed: true } : {}), ...(indexed ? { id } : {}),
          ...(indexed ? { preview: 'index' } : cls), ...(e.type === 'file' && runsCode(e.name) ? { opens: false } : {}) };
      });
      return json(res, { key, path: at.segs.join('/'), git: repo ? 'repo' : 'none', entries: out, more });
    }
    // The archive-readiness strip: facts about one project from this machine's files and what is already loaded. This machine
    // only (not in FORWARDED or FORWARDED_READS, so ?machine= is ignored). The key is resolved like the tree's, so an excluded,
    // unlisted or linked project is a 404; no path, file text or server setting is in the answer.
    if (url.pathname === '/api/project/readiness') {
      const key = url.searchParams.get('key'), at = await resolveIn(key, '', 'dir');
      return at ? json(res, await readiness(key, at.project)) : json(res, { error: 'not found' }, 404);
    }
    if (url.pathname === '/api/project/file') {
      const at = await resolveIn(url.searchParams.get('key'), url.searchParams.get('path') ?? '', 'file');
      if (!at) return json(res, { error: 'not found' }, 404);
      const r = await readPreview(at.abs, at.segs.at(-1), at.real);
      if (r.status !== 200) return json(res, { error: r.error, ...(r.reason ? { reason: r.reason } : {}) }, r.status);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': 'sandbox' });
      return res.end(r.body);
    }
    // A PDF or image of a project, as its own type (lib/project-tree.mjs readRaw: RAW_EXT only, 20 MB), for the project page's
    // preview. Resolved again on every ask; the headers are fileHeaders', so it's a sandboxed document (CSP sandbox, nosniff).
    // This machine only: not in FORWARDED_READS, and under /api/ so readAllowed answers only Cleon's own page.
    if (url.pathname === '/api/project/raw') {
      const at = await resolveIn(url.searchParams.get('key'), url.searchParams.get('path') ?? '', 'file');
      if (!at) return json(res, { error: 'not found' }, 404);
      const r = await readRaw(at.abs, at.segs.at(-1), at.real);
      if (r.status !== 200) return json(res, { error: r.error, ...(r.reason ? { reason: r.reason } : {}) }, r.status);
      res.writeHead(200, { ...fileHeaders(r.ext, r.body), 'content-length': r.body.length });
      return res.end(r.body);
    }
    // The project page's Open in default app: a file by key and path, never a code type (lib/project-tree.mjs openProjectFile
    // holds the order of the checks). This machine only: not in FORWARDED, so a body naming a machine is never handed on.
    if (url.pathname === '/api/project/open-file') {
      const body = await actionBody(req, res);
      if (!body) return;
      const r = await openProjectFile(body, { headless: HEADLESS, hasApp: hasDefaultApp, open: openFile });
      return json(res, r.body, r.status);
    }
    // The Knowledge panel's project buttons. The path must be a project folder listProjects() would return now (findProject
    // checks without git), so the browser can only ever open a known project folder, and only in one of
    // the three named apps.
    if (url.pathname === '/api/project/open') {
      const body = await actionBody(req, res);
      if (!body) return;
      const { path, app } = body;
      if (typeof path !== 'string' || !['herdr', 'bash', 'vscode'].includes(app)) return json(res, { error: 'path and app (herdr, bash or vscode) required' }, 400);
      const project = await findProject(path);
      if (!project) return json(res, { ok: false, reason: 'not a known project' }, 404);
      const r = app === 'herdr' ? await openInHerdr(project, { snapshot: herdrSnapshot, run: herdr, raise: raiseHerdrWindow, raiseClient: raiseHerdrClient, gitDir: GIT_DIR, raiseClass: raiseClassWindow })
        : app === 'bash' ? await openInBash(project, GIT_DIR, { raiseClass: raiseClassWindow })
        : await openInVscode(project, raiseFolderWindow);
      return json(res, r, r.ok ? 200 : 409);
    }
    // Close sessions: the page sends session ids only; lib/close.mjs looks each one up in the session files. This
    // machine only: not in FORWARDED, so a body naming a machine is never handed on.
    if (url.pathname === '/api/close-sessions/start' || url.pathname === '/api/close-sessions/now') {
      const body = await actionBody(req, res, 16_384);
      if (!body) return;
      if (!CLOSE_SUPPORTED) return json(res, { ok: false, reason: 'closing sessions works on Windows only' }, 409);
      const start = url.pathname.endsWith('start');
      const ids = start ? body.ids : [body.id];
      if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(i => typeof i === 'string' && i.length <= 200)) {
        return json(res, { error: start ? 'ids required' : 'id required' }, 400);
      }
      const r = start ? await CLOSER.start(ids) : CLOSER.now(ids[0]);
      return json(res, r, r.ok ? 200 : 409);
    }
    // The viewer's Open in default app: a file of the knowledge index, by its id, and only an Office file, so a served
    // page can never hand anything else (an .html, say) to the OS. This machine only (not in FORWARDED); refused when
    // headless, since no one is there to see the app open.
    if (url.pathname === '/api/file/open') {
      const body = await actionBody(req, res);
      if (!body) return;
      const f = await indexFile(body.id);
      if (!f) return json(res, { ok: false, reason: 'not a file of the knowledge index' }, 404);
      if (!OFFICE.has(extname(f.path).slice(1).toLowerCase())) return json(res, { ok: false, reason: 'only Office files open in their default app' }, 409);
      if (HEADLESS) return json(res, { ok: false, headless: true, reason: 'headless: no one is at this machine to see it' }, 409);
      const r = await openFile(f.path);
      return json(res, r, r.ok ? 200 : 409);
    }
    // Inbox. The browser names a meeting by its event id; everything else (the project, the folder, the
    // command) is worked out here from the saved scan.
    if (url.pathname === '/api/inbox/scan') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (!SCAN_ON) return json(res, { ok: false, reason: 'the scan is off (MC_SCAN=1 in .env turns it on)' }, 409);
      return startScan() ? json(res, { ok: true }) : json(res, { ok: false, reason: 'a scan is already running' }, 409);
    }
    // Replan: one planner run, refused while one is going.
    if (url.pathname === '/api/today/replan') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (!TODAY_ON) return json(res, { ok: false, reason: 'the Today view is off (MC_TODAY=1 in .env turns it on)' }, 409);
      const s = await todayState();
      // Replan replaces the plan, and with it the owner's swaps and fills: the page asks first and says so (discard).
      if (s.plan?.edited && body.discard !== true) return json(res, { ok: false, needsConfirm: true, reason: 'the plan has your edits; replanning discards them' }, 409);
      return startPlan('replan') ? json(res, { ok: true }) : json(res, { ok: false, reason: 'a planner run is already going' }, 409);
    }
    // Today: put an item in a box, or clear one. The browser names a box and an item by id; the item is looked up again in
    // the saved plan. Refused while a planner run is going: its result replaces the plan and would silently drop the edit.
    // No await between the edit and the save's start, so nothing can interleave.
    if (url.pathname === '/api/today/put' || url.pathname === '/api/today/clear') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (!TODAY_ON) return json(res, { ok: false, reason: 'the Today view is off (MC_TODAY=1 in .env turns it on)' }, 409);
      const st = await todayState();
      if (startPlan.running()) return json(res, { ok: false, reason: 'a planner run is going; its plan will replace this one, so edit after it finishes' }, 409);
      const day = localDate(Date.now()), r = url.pathname === '/api/today/put' ? putItem(st.plan, body.box, body.item, day) : clearBox(st.plan, body.box, day);
      if (!r.ok) return json(res, { ok: false, reason: r.reason }, r.status);
      today = { ...st, plan: r.plan };
      await saveToday();
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/inbox/dismiss') {
      const body = await actionBody(req, res);
      if (!body) return;
      const m = typeof body.id === 'string' ? (await inboxState()).meetings[body.id] : null;
      if (!m) return json(res, { ok: false, reason: 'no such meeting' }, 404);
      m.dismissed = true;
      await saveInbox();
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/inbox/ingest') {
      const body = await actionBody(req, res);
      if (!body) return;
      const r = await ingestMeeting(typeof body.id === 'string' ? body.id : null);
      return json(res, r, r.ok ? 200 : r.status ?? 409);
    }
    // Groom queue: the browser names an item by its key and an action; the item is looked up afresh here, and only
    // an action it offers is taken.
    if (url.pathname === '/api/groom/act') {
      const body = await actionBody(req, res);
      if (!body) return;
      const r = await groomAct(typeof body.key === 'string' ? body.key : null, typeof body.action === 'string' ? body.action : null);
      return json(res, r, r.ok ? 200 : r.status ?? 409);
    }
    // Waiting on: add or edit (an id edits that open item), close, or "not yet" for a maybe-answered item.
    if (url.pathname === '/api/waiting/save' || url.pathname === '/api/waiting/close' || url.pathname === '/api/waiting/not-yet') {
      const body = await actionBody(req, res, 4096);
      if (!body) return;
      const s = await waitingState(), id = typeof body.id === 'string' ? body.id : null;
      let r;
      if (url.pathname === '/api/waiting/save') {
        const c = cleanItem(body, (await inboxProjects()).map(projectId));
        r = c.ok ? saveItem(s, id, c.fields) : c;
      } else r = !id ? { ok: false, reason: 'id required' } : url.pathname === '/api/waiting/close' ? closeItem(s, id) : notYet(s, id);
      if (!r.ok) return json(res, { ok: false, reason: r.reason }, 409);
      waiting = r.state;
      await saveWaiting();
      return json(res, { ok: true, id: r.id ?? id });
    }
    // Orchestration flows → "restart in herdr", for an epic whose orchestrator session died. The browser
    // names only the epic; lib/resume.mjs works out its run, repo, permission mode and command.
    if (url.pathname === '/api/runs/restart') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (typeof body.epic !== 'string') return json(res, { error: 'epic required' }, 400);
      const r = await restartOrchestrator(body.epic, {
        runs: () => listRuns(),
        orchestrators: async () => listOrchestrators(await listSessions(), await herdrSnapshot()),
        repos: async () => (await runLocations()).repos,
        findProject,
        start: (project, how) => startInHerdr(project, how, { snapshot: herdrSnapshot, run: herdr, gitDir: GIT_DIR, raiseClass: raiseClassWindow, headless: HEADLESS }),
      });
      runsShared.invalidate();
      return json(res, r, r.ok ? 200 : 409);
    }
    // Herdr panel → update: installs the version herdr's own check found and restarts its servers, only at a
    // pause (lib/herdr-update.mjs). The browser sends nothing but the request.
    if (url.pathname === '/api/herdr/update') {
      const body = await actionBody(req, res);
      if (!body) return;
      const r = await updateHerdr();
      herdrVersionsCached.reset();
      return json(res, HEADLESS ? { ...r, headless: true } : r, r.ok ? 200 : 409);
    }
    // Restart (＋ Panels → Restart server): exit with RESTART_CODE once the reply is sent, and
    // scripts/launch.sh starts the server again in the same window. Started any other way, nothing
    // would bring it back, so it refuses.
    if (url.pathname === '/api/restart') {
      const body = await actionBody(req, res);
      if (!body) return;
      if (!process.env.MC_SUPERVISED) return json(res, { ok: false, reason: "Not started by the launcher, so nothing would start it again: restart it by hand" }, 409);
      res.on('finish', () => process.exit(RESTART_CODE));
      return json(res, { ok: true, boot: BOOT });
    }
    // Stop (＋ Panels → Stop server): exit once the reply is sent. Under scripts/launch.sh any exit but
    // RESTART_CODE ends the script, so its window closes too.
    if (url.pathname === '/api/stop') {
      const body = await actionBody(req, res);
      if (!body) return;
      res.on('finish', () => process.exit(0));
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/run-file') {
      const q = url.searchParams;
      return text(res, await readRunFile(q.get('epic'), q.get('ticket'), q.get('name')));
    }
    // /view?id=<file id> is one knowledge file in its own window (public/view.html); /project?key=<category>/<name> is one
    // project, full-page (public/project.html).
    const rel = VENDOR[url.pathname] ?? join('public', ({ '/': 'index.html', '/view': 'view.html', '/project': 'project.html' })[url.pathname] ?? url.pathname);
    if (rel.includes('..')) return json(res, { error: 'not found' }, 404);
    const body = await readFile(join(HERE, rel)).catch(() => null);
    if (!body) return json(res, { error: 'not found' }, 404);
    // The project page's frames (a rendered HTML file, a PDF) may show only Cleon's own URLs: a rendered page that navigates
    // itself (a script, a link, a <meta> refresh) to anywhere else is stopped by this, which its own CSP can't do.
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream',
      ...(url.pathname === '/project' ? { 'content-security-policy': PROJECT_PAGE_CSP } : {}) });
    res.end(body);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // A backstop: node ends the process on a rejection nothing handles, and nothing restarts the server but exit code 75.
  // Whatever lands here is a bug (its source should handle its own failure), but a board that stays up shows it.
  process.on('unhandledRejection', e => console.error('BUG: an unhandled rejection (still serving, fix its source):', e?.stack ?? e));
  server.listen(PORT, HOST, () => console.log(`Cleon → http://${HOST}:${PORT}`));
  if (!EXCLUDE_SRC) console.warn('MC_EXCLUDE is not set in .env: nothing is kept out of the knowledge map or file tiles.');
  for (const r of PEERS_REFUSED) console.warn(`MC_PEERS: refused "${r.entry}": ${r.reason}. It is never contacted.`);
  for (const p of PEERS.filter(p => p.url)) {
    console.log(`Peer ${p.name} → ${p.url}`);
    for (const path of ['/api/sessions', '/api/runs', '/api/attention', '/api/herdr']) p.get(path); // first answers arrive before the page's first poll asks
  }
  startTunnels().catch(e => console.warn(`MC_PEERS: couldn't start the SSH tunnels: ${e.message}`));
  watchDockerEvents();
  if (TODAY_ON) {
    console.log(`Today planner: on, from ${TODAY_HOUR}:00 with ${TODAY_MODEL}, up to ${TODAY_BUDGET} dollars a run, reading ${TODAY_READ.length ? TODAY_READ.join(' and ') : 'no project text'}`);
    if (!TODAY_HOURS.valid) console.warn('MC_TODAY_DAY is not HH:MM-HH:MM: using 08:00-17:00.');
    const { unknown } = parseRead(TODAY_READ_SRC);
    if (unknown.length) console.warn(`MC_TODAY_READ: ignoring ${unknown.join(', ')} (known: claude-md, changelog).`);
    process.on('exit', stopScans);
    setInterval(() => todayTick().catch(() => {}), 60_000);
    setTimeout(() => todayTick().catch(() => {}), 5_000);
  }
  if (SCAN_ON) {
    console.log(`Inbox scan: on, at ${SCAN_HOURS.map(h => `${h}:00`).join(', ') || 'no hours (Scan now only)'} with ${SCAN_MODEL}`);
    process.on('exit', stopScans);
    setInterval(() => scheduleTick().catch(() => {}), 60_000);
    setTimeout(() => scheduleTick().catch(() => {}), 5_000);
  }
}

// The tunnels for ssh://<host> peers. Each keeps the local port it had last time (the peer's page keeps its
// address), and any ssh a killed Cleon left behind is ended first. Recorded per Cleon port, so a test Cleon on
// this machine never touches these. They end with this server: on exit (Stop and Restart server), Ctrl+C, or a
// signal; closing Cleon's window takes them down with it.
async function startTunnels() {
  const wanted = PEER_LIST.filter(p => p.ssh);
  if (!wanted.length) return;
  const file = join(HERE, 'data', `peer-tunnels-${PORT}.json`);
  const saved = await readTunnels(file);
  const ended = await killOrphans(saved);
  for (const name of ended) console.log(`Peer ${name}: ended the ssh tunnel a previous Cleon left running`);
  // An ended ssh lets go of its port a moment later: wait briefly, so the peer keeps its address.
  const freeSoon = async port => { for (let i = 0; i < 6; i++) { if (await portFree(port)) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
  const state = {};
  process.on('exit', () => { for (const t of TUNNELS.values()) t.stop(); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1)));
  for (const { name, ssh } of wanted) {
    const peer = PEERS.find(p => p.name === name);
    const last = saved[name]?.port;
    const port = Number.isInteger(last) && await (ended.includes(name) ? freeSoon(last) : portFree(last)) ? last : await freePort();
    const at = p => `http://127.0.0.1:${p}`;
    peer.retarget(at(port));
    const t = supervise({ target: ssh, port }, {
      env: cleanEnv(process.env), newPort: freePort,
      onPid: (pid, p) => { state[name] = { pid, port: p }; writeTunnels(file, state); },
      onPort: p => { peer.retarget(at(p)); console.log(`Peer ${name}: its port was taken; the tunnel moved to ${at(p)}`); },
    });
    TUNNELS.set(name, t);
    t.start();
    console.log(`Peer ${name} → ssh ${ssh}, forwarded to ${at(port)}`);
  }
}
