# Cleon

(Named for Cleon: the Warriors' leader in *The Warriors*, and the Galactic Emperor in *Foundation*.)

A local-only dashboard for everything running on this machine: Claude Code sessions, Herdr workspaces,
orchestration flows, project repos and the knowledge base. It runs on `127.0.0.1` and makes no cloud calls
apart from the Linear and GitHub APIs (or your Bitbucket Server, with `MC_SCM=bitbucket`).

> **Never expose it to a network.** Cleon has no login. Besides reading your notes and Claude transcripts, it
> can type answers into agents' plan-gate dialogs and send merge approvals to orchestrators. Anyone who can
> reach the port can do the same. Keep it on loopback.

## Requirements

- **Windows** with Git Bash. Window raising, per-process stats and the launcher use Win32 calls
  (`docs/PORTING.md` lists every Windows-only piece).
- **Node 24+** and **Python 3**.
- **Claude Code**: the Sessions panel and the "waiting on you" alerts read its local session and transcript files.
- **Optional:** [`gh`](https://cli.github.com/) (GitHub panel) or a Bitbucket Server token, a Linear API key, herdr
  (workspaces, jumping to panes, answering gates), Docker, Ollama, an Obsidian vault. Each panel shows as
  offline or empty when its source is missing.
- **Orchestration panels** (Flows, Process) read run folders written by an orchestration tool. The default
  adapter matches the author's own Claude Code orchestration plugin, which isn't public. To feed these panels from
  your own tool, write the layout in `docs/RUN-FORMAT.md` or swap in your own adapter.

```bash
cp .env.example .env   # then fill in: paths, privacy exclusions, Linear key
npm install
npm start          # http://127.0.0.1:4317  (MC_HOST / MC_PORT to override)
npm test
```

Machine-specific settings (repo root and categories, runs and plans folders, the Obsidian vault, privacy
exclusions, the Docker disk path) live in `.env`. `.env.example` documents each one, and `lib/config.mjs`
reads them. To stand up a copy elsewhere, see `docs/PORTING.md`. The orchestration panels read run files
through one adapter; to drive them from another tool, see `docs/RUN-FORMAT.md`.

**Desktop launcher:** `scripts/launch.sh` starts the server unless it's already running, then opens the
dashboard in its own Chrome app window. The "Cleon" desktop shortcut runs it in a minimized
Git Bash window. That window is the server, so closing it stops the dashboard. **＋ Panels → Restart server**
restarts it in that same window (to pick up code or `.env` changes) and reloads the page. It works only when the
launcher started the server; otherwise it says so and leaves the server running. **Stop server** (two clicks)
stops the server, which closes the launcher's window, and closes the Cleon window too.

**Icon:** an all-seeing eye. `python -I scripts/make-icon.py` regenerates the shortcut icon
(`assets/mission-control-radar.ico`) and the page icon (`public/icon-192.png`). The window icon is redrawn
live. Normally the eye is cyan; when something is waiting on you, it turns magenta and pings.

## Panels and data sources

**Views.** The header has three tabs, each its own board with its own saved layout: **Dev** for work under
way (the panels below, as they were), **Groom** for setting work up and the chores around it (the Groom queue, Waiting on,
and the Linear / pull request / repo panel), and **Exec** for the high-level look (the Exec summary, Usage and Process). A panel can
be in several views. ＋ Panels adds to and removes from the view showing, and Reset resets only that view. Dev's tab
counts what's waiting on you; Groom's counts the Groom queue. Notices
fire whatever view is showing. The layouts and the last view are kept in the browser (`mc.layout.<view>`, `mc.view`);
a board saved before views became Dev's.

| Panel | Source | Refresh |
|---|---|---|
| Sessions | `~/.claude/sessions/*.json`, with the pid checked so dead sessions are shown dimmed | 5 s |
| Herdr | `herdr api snapshot`; shows "offline" when the herdr server isn't running. A badge in its header shows when herdr's own update check found a newer version (Cleon reads what herdr saved in `release-notes.json`; it doesn't check itself), or when running servers are still on an older version than the one installed. Its tile shows what's new and an update button that works only at a pause: no herdr agent working or waiting on a question, and no live orchestrator with tickets not yet merged (an idle one may be waiting on a merge watcher). Two clicks run `herdr update` (herdr downloads it, not Cleon), then restart each running server; herdr restores the workspaces and resumes the Claude panes. Windows Cleon opened on those sessions are closed and reopened where they were; other windows showing herdr drop to their shell. Nothing is restarted if the update doesn't install, and the pause is checked again before the restarts | 5 s; versions 60 s |
| Orchestration flows | Each runs root the plugin config names (plus `MC_RUNS_DIR`): `<root>/<EPIC>/` (`fleet.tsv`, `STAGE`, `REVIEW_STAGE`, `.watch-state/*.pr`), and the plans folder | 5 s |
| Projects | Every repo under `<MC_ROOT>/<category>/`, categories from `MC_CATEGORIES`, read through `git` | 60 s |
| Linear | GraphQL API, issues assigned to you that aren't completed or canceled. Needs `LINEAR_API_KEY` in `.env`. | 60 s, cached server-side |
| GitHub | `gh search` for your open PRs, PRs waiting on your review and assigned issues, plus `gh pr view` for CI and review state | 60 s, cached server-side |
| Bitbucket (instead of GitHub) | With `MC_SCM=bitbucket`: the REST API's PR dashboard for your open PRs and PRs you haven't reviewed, plus build statuses for CI. Needs `BITBUCKET_URL` and `BITBUCKET_TOKEN` in `.env`. | 60 s, cached server-side |
| Knowledge | Each project under `MC_ROOT`, and in it four groups: **Docs & decisions** (its own `CLAUDE.md`, `README.md`, `CHANGELOG.md` and `LEARNINGS.md`, and `docs/`, `adrs/` and `decisions/` folders), **Comms & meetings** (`communications/`, `meetings/`, `transcripts/`), **Outputs** (`output/`, `outputs/`, `reports/`) and **Claude memory** (the project's store in `~/.claude/projects`, found by Claude Code's folder name for its path; a nested repo's store counts toward its project while that folder is there). Folders count at any depth and in any case; `MC_KNOWLEDGE_FOLDERS` changes the lists. Documents only (Markdown, text, HTML, PDF, VTT, mail, Office files, CSV) and PNG, JPEG, GIF and WebP images (not SVG, which can carry script), the newest 400 items per group; hidden, dependency and build folders are skipped, and nothing matching `MC_EXCLUDE` is read. Dated versions of one document in one folder (`reply-2026-08-11.md`, `reply-2026-08-11b.md`, `reply-2026-09-08.html`, a `-draft`) are one item, newest first, and an ADR shows its status. The map shows one level at a time: the centre and its children, in a ring, or in columns when there are more than 14 (pan for the rest). Click a node to make it the centre; the breadcrumb above the map goes back up. Projects are coloured by git state, and clicking one also opens its tile: its description (first paragraph of its README, else CLAUDE.md, else `package.json`; never read for `MC_EXCLUDE` folders) and buttons that open it in herdr (focuses the pane already in its folder, or starts the project's own session with Claude Code in its folder, in a standalone Git Bash window (a bash prompt when herdr exits); a closed window leaves the session running, and the next click reattaches, starting Claude Code in a new session), Git Bash (running Claude Code) or VS Code, and bring the window forward. Clicking a document opens its newest version in a tile, shown by its type: Markdown rendered; HTML in a sandboxed frame, where its scripts run but can't act as Cleon; PDF in the browser's own viewer; a VTT transcript as speaker turns with their times; images as themselves; text, CSV and mail as plain text; and for an Office file, its name, size and date with **Open in default app** (this machine's Word, Excel or PowerPoint; refused when `MC_HEADLESS=1`). A document with several versions has a picker, newest first. ⧉ opens the document in a window of its own (`/view?id=…`); ⧉ again for the same file brings that window forward rather than opening another. Down its right side, the last 12 projects opened from the map, newest first, with where they were opened and when (kept in this browser); click one to go to it and open its tile. The Obsidian vault isn't shown for now | on load and on ⟳; git state 60 s |
| Inbox (Groom) | Off unless `MC_SCAN=1`. A scheduled, read-only `claude -p` run over your Microsoft 365 calendar through the claude.ai Microsoft 365 connector (`lib/scan.mjs`). It lists Teams meetings that have ended and matches each to a project; Cleon then checks the project folder for a transcript named for that day. Meetings without one are flagged by project, with where the transcript goes; unmatched ones are listed apart. Dismiss hides one for good. While Teams blocks reading transcripts through Graph, flags say to download the VTT; once it allows it, Ingest opens a Claude session in the project (in herdr) that fetches and saves it. A scan's cost counts in Usage. See `docs/PORTING.md`, "The Inbox scan" | scans at `MC_SCAN_HOURS` and on Scan now; the tab polls every 30 s |
| Process (＋ Panels) | Merged orchestrated tickets: stage times from when the run files were last written, plan-gate waits from worker transcripts, PRs from GitHub or Bitbucket. A ticket with no PR file gets the PRs you wrote whose branch names it, and several PRs make one row; with no run folder, only a self-review folder, its missing stages are left out and it's marked ≈. Shows where each ticket's time went: agent work, or waiting on you. A wait while you were away (any gap of 3 h or more between your prompts or dialog answers in any Claude session; prompts in workers' sessions don't count, since herdr types the orchestrator's prompts there) is shown in grey and isn't counted as waiting on you. Lead time stays wall-clock. Insights call out plan gates left open while you were away: those stall a ticket before any work starts, while a PR left to merge overnight is already done | 60 s while shown |
| Exec summary (Exec) | Five cards, one per decision (`lib/exec.mjs`), each with its number, last week's, the change (green when it moved the good way), one line on what to do about it, and its source: **Spend vs output** (Claude spend over 7 days against the 7 before, merged tickets in the same windows, cost per merged ticket, the top-spending project), **Where cycle time goes** (time merged tickets waited on you against agent time, median lead time, the longest plan-gate wait), **Stalled work** (orchestrated tickets with no step change in 5+ days, your Linear In Progress untouched 7+ days), **Portfolio activity** (repos with a commit in 7 and 30 days, those quiet 30+, the ones that went quiet this month) and **Grooming backlog** (the Groom queue's size and oldest item). Usage and Process include peers, as their panels do. Last week's numbers that today's data can't rebuild come from a line a week in `data/exec-<port>.jsonl`. No card ranks people; `MC_EXCLUDE` projects are never named | 60 s while on the board |
| Groom queue (Groom) | One list of everything waiting to be set up (`lib/groom.mjs`): Waiting on items overdue or maybe answered, pull requests waiting on your review, meetings whose transcript isn't filed, and Linear issues assigned to you that are in Triage or have (nearly) no description. Grouped in that order, oldest first. Each item offers what applies of the same actions: **Do it** (open the message, PR, meeting or issue; Ingest a transcript once Teams allows it), **Make a ticket** (a Claude session in the item's project, in herdr, running `/new-task`; the command holds only the item's kind and date, and you say what the ticket is for), **Wait on it** (moves it to Waiting on, from its sender or organizer), **Snooze** until 8:00 tomorrow or next Monday, and **Dismiss** (or Close, for a Waiting on item). The page sends only the item's key and the action; the server looks the item up again. Snoozes and hides are kept in `data/groom-<port>.json`. A source that couldn't be read is named at the top | every 30 s, and after each action |
| Waiting on (Groom) | What you're waiting for from someone: what, from whom, a project and a due date, typed into the panel and kept in `data/waiting-<port>.json` (`lib/waiting.mjs`). With the Inbox scan on, each scan also searches mail and Teams chats from that person since the item was added (or since its last check) for a message that answers it. A likely answer shows as "maybe answered" with a link to the message; Close when you have it, or Not yet to keep waiting (that message isn't offered again). Overdue items come first and notify once a day | every 60 s; answers at each Inbox scan |
| Usage (＋ Panels) | What Claude cost, at Anthropic's list API prices, from the token counts Claude Code records for every reply in its transcripts (`~/.claude/projects`, subagents included). Tiles: last 7 and 30 days, the median merged ticket, everything counted. **Tickets:** each ticket's implementer, reviewer and its share of the epic orchestrator's cost (an orchestrator's replies go to the epic it was running at the time), by epic. **Projects:** spend by week and by project (worktrees count toward their repo). **Models:** each role's last 30 days by model, and what the same tokens would cost on Sonnet 5.5. **Sessions:** this week's costliest sessions and how their cost per reply grew with their context. A session's role comes from its folder (a ticket's worktree), its opening prompt (the worker or reviewer prompt) or the epic command and watcher it ran; anything else is yours. Only token counts, folders, the ticket id in a worker's opening prompt and an orchestrator's epic are read; no text is kept. Claude Code deletes transcripts after 30 days, so totals are kept in `data/usage-ledger.json` (gitignored) and outlive them. A Codex placeholder says whether Codex has left session logs in `~/.codex/sessions`; reading them comes once there are some | 60 s while shown; the first read takes about 15 s |
| Activity (＋ Panels) | What Cleon itself is doing, live. Cleon sits in the middle with everything it checks around it (each Claude session, each herdr session, Linear, Bitbucket/GitHub, git, Docker, Windows tools, and this page); every check is a dot that goes out, waits as long as the check really took, and comes back green (answered), amber (answered no), red (failed) or grey (nothing new). Hover a node for its totals and which endpoints asked for it; click one to show only its checks in the feed. Tiles show the server's CPU, memory, longest event-loop wait, programs started, web requests, session checks and I/O. Recorded from Node's diagnostics channels (programs, web requests, page requests) plus the session-file and transcript reads; the last 5 minutes are kept in memory. Request headers are never read, and `MC_EXCLUDE` folders aren't named | 1 s while shown |

**Another machine (`MC_PEERS`).** Another machine's Cleon, reached through an SSH forward (which Cleon can run and
keep up itself: `name=ssh://<host>`), can show its sessions,
epics, orchestrators, attention, herdr workspaces and session activity here, each row with a chip naming the
machine. Its plan gates, merges, jumps and orchestrator restarts are handed to its Cleon, which acts on its own
machine; a jump also raises your herdr window here that's switched to that machine. Its PRs and CI are looked
up here, the Process panel counts away time across both machines, the Usage panel counts its Claude spend with
this machine's (a ticket worked on both is one row), and the Resources panel shows its CPU, memory and top
processes in a section of its own. The
header shows each peer as up or offline. A peer on an older Cleon stays up, and its tooltip names what it
doesn't serve yet. Setup: `docs/PORTING.md`, "A second machine".

**Jumps (⏵).** A jump focuses the session's herdr pane and raises the window showing that herdr session. herdr
sessions keep running after their windows close (a crash, a closed window), so when no window shows the
session, the jump attaches a Git Bash window to it, in the pane's folder.

Flow steps are the orchestrate-work lifecycle collapsed to the steps the files can show:
queued → planning → plan gate ◆ → implementing → self-review → review·merge ◆ → done.
A ◆ marks a step that waits on you. An implementer working again after review shows as **Fix round**.
A ticket with no live pane that hasn't merged is marked inactive; tick "show inactive" to see those.
A ticket that merged in any run counts as done in every run, so a stale copy left at an earlier step
in an old run doesn't show up as waiting on you.

The current step pulses (expanding rings and a breathing glow), and a particle travels along the edge
leading into it. Gates that wait on you are diamonds and pulse magenta. The two feedback loops are
drawn as arcs: "redirect" from the plan gate back to planning, and "changes requested" from review back
to implementing. That second arc animates when the implementer is on a fix round.

Clicking a flow step opens that step's artifacts (plan, kickoff, report, review). Clicking a document on the
knowledge map opens it as a draggable tile.

**Restarting a dead orchestrator.** When an epic's orchestrator session is gone (a reboot, a closed window)
and tickets are still open, its card says "no live orchestrator session" with a **▸ restart in herdr** button.
It finds the epic's repo (the repo with an orchestration config whose `git worktree list` has a worktree
named for the epic or one of its tickets) and starts that repo's own herdr session headless if needed (herdr
then restores the session's earlier workspaces and resumes their Claude panes, the epic's workers included).
It runs `claude --permission-mode <mode> "/orchestration:orchestrate-work <EPIC>"` in a new tab named
`orchestrator` in the epic's own workspace, beside its workers, when that workspace is live (the id and label
the run recorded in `herdr-workspace` both match); otherwise in a new workspace labelled `<EPIC> orchestrator`.
Then it raises the session's window (or attaches one). Since the orchestrator shares the epic's workspace,
the plugin's `close-epic` closes the orchestrator's own pane along with it. `<mode>` is the permission mode the last orchestrator ran in, as the plugin
recorded it in the ticket folders (`ORCHESTRATOR_PERMISSION_MODE`), whatever it was; with none recorded the
flag is left off. orchestrate-work then enters reconstruction mode: it rebuilds the epic from Linear, the PRs
and the worktrees, re-arms its watcher and re-dispatches dead workers. The button is refused when an
orchestrator for the epic is already live, and for three minutes after a restart while the new one comes up.

## Privacy

- **Excluded:** any path matching the `MC_EXCLUDE` regex in `.env` never enters the knowledge map, can't be opened
  as a tile, and isn't read for session dialogs. If it's unset, nothing is excluded and the server warns at startup.
- **What can be read:** `/api/file` serves only file ids from the current knowledge index, never a path, each
  with its own type, `nosniff` and no caching. Every file is a sandboxed document with no origin of its own: HTML
  under `Content-Security-Policy: sandbox allow-scripts`, every other type under `sandbox`, and Office files as
  downloads. The viewer also frames HTML with `sandbox="allow-scripts"` (never `allow-same-origin`). Whatever a
  served file runs can't call Cleon's actions: its requests carry `Origin: null`, which every action refuses.
  `/api/file-info` answers for the same ids only. `/api/run-file` serves only the named
  orchestration artifacts. Raw HTML inside notes is shown as text. Rendered Markdown keeps only http, https,
  mailto and relative links, and only http, https and relative images; any other link shows as its text.
- **Open in default app** (`/api/file/open`) takes an id from the knowledge index, never a path, and opens only
  Office files (Word, Excel, PowerPoint), so a served page can't hand anything else to the OS. It's an action like
  the others (POST, Cleon's own page, JSON), acts on this machine only, and is refused when `MC_HEADLESS=1`.
  Nothing `.env` sets reaches the app it opens.
- **Secrets:** the Linear key is read from `.env` (gitignored) and sent only to `api.linear.app`. GitHub goes
  through `gh`'s own stored login, so this app never touches that token. A Bitbucket token is read from `.env` and
  sent only to `BITBUCKET_URL`: PR addresses on any other host are never looked up. Read access is all it needs.
  Nothing `.env` sets reaches the windows or herdr servers the knowledge map's project tiles open, so neither token does either.
- **Network:** the server binds to loopback. Setting `MC_HOST` to anything else (a LAN or Tailscale address)
  would expose your notes and transcripts, plus the gate-answering and merge-approval actions, to that
  network. Nothing here does authentication. To see another machine's Cleon, forward its loopback port over SSH
  and name it in `MC_PEERS` (`docs/PORTING.md`, "A second machine"); its rows then show here beside your own. Never
  forward it to anything but `127.0.0.1` (no `-L 0.0.0.0:`, `-g` or `GatewayPorts`).
- **Inbox scan:** off unless `MC_SCAN=1`. The scan can use only four read-only Microsoft 365 tools (calendar
  search, mail search, Teams chat search, and read), with every built-in tool but ToolSearch switched off and
  `--permission-mode dontAsk`. Cleon keeps pointers only (subject, organizer, times, an Outlook link, the
  project), in `data/inbox-<port>.json`, and the run saves no transcript of its own. For a waiting-on item it
  keeps who answered, when, a link, and the model's own few words, never the message. Projects matching
  `MC_EXCLUDE` are never named to it. Ingest types a fixed command built from the event id, date and folder
  only, never the subject or invite.

## Testing

`node --test` with no extra dependencies:

- Adapters are tested against fixtures in `test/fixtures`. The pure functions are tested directly:
  `deriveStep`, `parseFleet`, the knowledge index (groups, threads, ADR status, memory stores, exclusions) and
  the exclusion pattern.
- Server tests cover the read guards: unknown or excluded file ids and path traversal must return 404.
- The UI is checked by hand in the browser for this POC.

## Roadmap

1. ✅ POC: sessions, herdr, knowledge graph, file tiles
2. ✅ Orchestration flow charts
3. ✅ Linear and GitHub panels
4. 🟡 Inbox: Teams meetings whose transcript isn't filed (done); waiting-on items next, then mail threads
   that need action

## License

MIT. See `LICENSE`.
