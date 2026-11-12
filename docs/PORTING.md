# Porting Cleon to another machine

A checklist for standing up a copy of Cleon on a different setup. The example target uses
Bitbucket Server instead of GitHub, has no Ollama, and runs a variant of the orchestration plugin.

> **Keep this current.** Any change that adds a data source, a hardcoded path, a CLI dependency, an
> environment variable or a new assumption about the plugin's run files should update this file in the
> same commit. The project `CLAUDE.md` says the same.

## Before you copy

- `.env` → never copied; start from `.env.example` and set the new machine's own `MC_EXCLUDE`.
- `data/` → gitignored machine state; don't copy it over.

## Phase 1: runs as-is (about an hour)

| Step | Check |
|---|---|
| Install Node 24+, Python 3 and Git Bash. Run `npm install`. | `npm test` passes |
| `cp .env.example .env`; set `LINEAR_API_KEY` (that machine's Linear key), `MC_ROOT`/`MC_CATEGORIES` and `MC_EXCLUDE` | No `MC_EXCLUDE` warning at startup; the Linear tab and Repos list fill in |
| Set `MC_PORT` if 4317 is taken | The page loads on `127.0.0.1` |
| Open the Sessions, Herdr and Resources panels | Each shows live data or a clean "offline" |

These already degrade cleanly and need no code changes:

- **Ollama.** Resources shows "Ollama: not running". To hide the line, drop the `#res-ollama` render in
  `renderResources()` (`public/app.js`).
- **Docker.** The panel is off by default. If Docker is missing, it says "Docker isn't running". The disk-file
  tile assumes Docker Desktop on WSL2 (`%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`).
- **herdr.** Missing herdr shows as offline. A jump to a herdr pane raises the window showing its session; when none does (the session kept running headless after its windows closed), it attaches a Git Bash window to it (`herdr session attach`, as the Knowledge panel's herdr button does). Jumps to sessions outside herdr fall back to raising the session's own terminal window (Git Bash via `ps -W` under `MC_GIT_DIR`, or Windows Terminal), then the VS Code window. The Knowledge panel's
  herdr button focuses a pane already in the project's folder (attaching a window when none shows its
  session), else starts the project's session headless (`herdr --session <project> server`), creates a
  workspace in the folder (`workspace create --cwd --label --focus`, then `pane run <pane> claude`) and
  attaches a Git Bash window to it. The server must start headless: one started by a client inside a
  mintty window with ConPTY loses all its panes when that window closes.
- **GitHub.** Without `gh`, the GitHub tab shows offline. On Bitbucket Server, set `MC_SCM=bitbucket` (Phase 3).

## Phase 2: configuration instead of hardcoded paths (done 2026-11-01)

Every machine-specific value is read from `.env` by `lib/config.mjs`. `.env.example` documents each one.
The code defaults are generic, so a new machine needs only its own `.env`, with no code edits.

| Setting | Default when unset |
|---|---|
| `MC_ROOT`, `MC_CATEGORIES` | `~/dev`; every folder under it is a category |
| `MC_RUNS_DIR`, `MC_PLANS_DIR` | none (the plugin's own config and each repo's `paths.runs_root` are still read) |
| `MC_VAULT` | none: no vault pages on the knowledge map. Set, its Markdown pages (hidden, dependency and build folders skipped, links not followed) are belt items: they orbit the projects they name or that link to them |
| `MC_KNOWLEDGE_MATCH` | off. `1` sends belt items nothing names or links to to Haiku (a headless `claude -p`; see "The knowledge match"). It costs money and sends note text to Anthropic |
| `MC_KNOWLEDGE_FOLDERS` | `docs=docs,adrs,decisions;comms=communications,meetings,transcripts;outputs=output,outputs,reports`: the folders, at any depth and in any case, that put a project's files in each knowledge-map group. A group named in the setting gets exactly its list |
| `MC_EXCLUDE` | **nothing excluded**: the server prints a warning at startup. Set it before opening the knowledge map. |
| `MC_DOCKER_DISK` | Docker Desktop's WSL2 default |
| `MC_HOST`, `MC_PORT` | `127.0.0.1`, `4317` |
| `MC_PEERS` | none: this machine only. `name=http://127.0.0.1:<port>` entries show another machine's Cleon, reached through an SSH forward; a non-loopback URL is refused |
| `MC_HEADLESS` | off. `1` on a machine nobody sits at: jumps, orchestrator restarts and herdr updates focus herdr but never raise or attach a window |
| `MC_SESSIONS_DIR` | `~/.claude/sessions`: Claude Code's session files, read by the Sessions panel and Close sessions…. A test server points it at a folder of stub sessions, so it can never list or close real ones |
| `MC_GIT_DIR` | `C:/Program Files/Git` (the Knowledge panel's bash button runs its `usr/bin/mintty.exe`) |

## Phase 3: Bitbucket Server adapter (done 2026-11-02)

`MC_SCM=bitbucket` swaps `lib/github.mjs` (the `gh` CLI) for `lib/bitbucket.mjs` (Bitbucket Server / Data Center
REST, with `BITBUCKET_URL` and `BITBUCKET_TOKEN` in `.env`). `lib/scm.mjs` picks one. `server.mjs`, `lib/runs.mjs`
and `lib/metrics.mjs` import from it, never from an adapter directly. The token needs only read access to projects
and repositories. It is sent only to `BITBUCKET_URL`: `parsePrUrl` rejects PR addresses on any other host, so a URL
in a run file can't send it anywhere else.

**Contract both adapters meet** (a third host would match these too):

- Summary (`githubSummary` / `bitbucketSummary`) → `{ online, reason?, myPrs[], reviewRequests[], issues[] }`.
  - PRs: `{ repository: { name }, number, title, updatedAt, isDraft, url, body, author, checks, reviewDecision, branch }`.
  - `checks` is one of `passing | failing | pending | none`.
- `prChecks(url)` → `{ url, checks: [{ name, bucket, link, running, startedAt, completedAt, mutation }], mutations, at }`.
  - `bucket` is one of `pass | fail | pending | cancel | skipping`. Both adapters build it with `summarizeChecks()`.
- `prState(url)` → `OPEN | CLOSED | MERGED`, or null when the lookup fails.
- `prDetail(url)` → `{ state, title, createdAt, mergedAt, additions, deletions, commits: [{ committedDate }] }`, or null.
- `repoPrs(remoteUrl)` → recent PRs, `[{ url, state, branch, author }]`, or null when the first request fails or the remote isn't on this host. `state` as in `prState`.
- `me()` → your login on the host (compared with `author`), or null.
- `NAME` → the host's name, shown on the tab, the CI checks header and the Process notes (`/api/github` sends it as `scm`).

**How Bitbucket fills it:**

| Field | From |
|---|---|
| My open PRs | `GET /rest/api/1.0/dashboard/pull-requests?role=AUTHOR&state=OPEN` (the first 10, as on GitHub) |
| Review requests | The same, with `role=REVIEWER&participantStatus=UNAPPROVED` |
| Issues | None: always `[]`. Linear covers them. |
| CI | `GET /rest/build-status/1.0/commits/{latestCommit}`. `SUCCESSFUL→pass`, `FAILED→fail`, `INPROGRESS→pending` (running), `CANCELLED→cancel`, anything else `skipping`. There's no queued state, and each build keeps one timestamp (its latest update), so only running builds show a duration. |
| Review decision | `reviewers[].status`: any `NEEDS_WORK` → changes requested; all `APPROVED` → approved; otherwise review required; no reviewers → none |
| PR state | `state`, with `DECLINED` reported as `CLOSED` |
| Merged at, created at | `closedDate` of a `MERGED` PR, `createdDate` |
| Commits | `.../pull-requests/{id}/commits`, `committerTimestamp` |
| Size | Lines in the `ADDED` and `REMOVED` segments of `.../pull-requests/{id}/diff?contextLines=0` (Bitbucket doesn't count them) |
| Repository name | The target repo's slug: what a clone's git remote ends in, which the session→PR map compares |
| Rate limit | Bitbucket limits requests per user, and a burst gets HTTP 429 with `Retry-After` (5 s on Data Center). `call()` waits as told (plus up to 1 s of spread) and retries, up to 4 attempts. Startup checks the PR of every unfinished run ticket, which can be 100+, so the Flows panel's first answer can take ~30 s on a cold start. |
| PR addresses | `/projects/<P>/repos/<r>/pull-requests/<N>` and personal repos' `/users/<u>/repos/<r>/pull-requests/<N>` (project `~<u>` in the REST API), optionally ending `/overview` |
| A repo's recent PRs | `GET /rest/api/1.0/projects/{P}/repos/{r}/pull-requests?state=ALL&order=NEWEST&limit=100`, up to 3 pages, per repo every 5 minutes. `{P}` and `{r}` come from the clone URL (`parseRemote`), which must be on `BITBUCKET_URL`'s hostname: an SSH host with a different name finds nothing. Addresses are built on `BITBUCKET_URL`. In a busy repo, a ticket older than the newest 300 PRs isn't found and stays as it was |
| Your login | `author.user.slug` of `GET /rest/api/1.0/dashboard/pull-requests?role=AUTHOR&limit=1` (the REST API has no "who am I"). With no PRs of yours, nothing is claimed |

**Host-neutral now:** PR numbers come from `prNumber()` (`lib/scm.mjs`, and its twin in `public/app.js`), which
reads `/pull/N` and `/pull-requests/N`. `prMentions` in `lib/sessionprs.mjs` matches both link forms.

**Still says "GitHub" on Bitbucket:** the Process panel's first loading placeholder, and the tab (and the side
panel's name in ＋ Panels) until the first data load finishes (about 10 s on a cold start).

**Checked against a live Data Center server (2026-11-02):** the dashboard, PR, commits and diff endpoints all answer;
line counts matched `git diff --shortstat` of the merge commits; merged PRs reconcile run tickets to done. The
build-status endpoint answers (the per-repo `.../commits/{sha}/builds` returns 400 without a build key, so it isn't
an alternative). Not yet seen with data: build statuses (none were posted) and the `participantStatus` filter (no
review requests at the time). **Not yet run against a live server:** `repoPrs` and `me`, tested with stubs only.
To check them, open Process and confirm a PR with no `PR` run file appears under its ticket.

## Phase 4: orchestration plugin variant (depends on how it differs)

The flows panel reads the plugin's files; it never calls the plugin. Check the variant against these
assumptions. If it matches, the panel works unchanged. Whatever differs in the run files, config or
transcripts goes in a copy of `lib/adapters/orchestration-plugin.mjs`, selected with `MC_ORCH_ADAPTER` in `.env`; no
other module changes. `docs/RUN-FORMAT.md` describes every adapter field. Rows not marked *adapter* are
herdr or Claude Code behaviour, and stay in the files listed.

| Assumption | Where it's read |
|---|---|
| Run folders at `<runs_root>/<EPIC>/<TICKET>/` with `STAGE`, `REVIEW_STAGE`, `PR`, `BLOCKED` | *adapter* `files`, `deriveStep` |
| Artifacts named `KICKOFF.md`, `PLAN.md`, `REPORT.md`, `REDIRECT.md`, `REVIEW_KICKOFF.md`, `REVIEW_REPORT.md` | *adapter* `artifacts`, `stepFiles` |
| `fleet.tsv`, `herdr-workspace` and `.watch-state/*` in each epic folder | *adapter* `files` |
| `paths.runs_root` in each repo's `.claude/workflow.local.json`; the global one in `~/.claude/settings.json` → `pluginConfigs["orchestration@…"].options` | *adapter* `repoConfig`, `settingsKey`, `locations` |
| Ticket ids match `[A-Z]+-\d+`; worktrees are named `wt-<TICKET>` | *adapter* `idPattern`; `lib/sessions.mjs`, `lib/metrics.mjs` `WORKTREE` |
| The orchestrator is started with `/…orchestrate-work <EPIC>` and watches with `workspace-dispatch.sh watch --epic <EPIC>` | *adapter* `epicCommand`, `epicWatch` |
| A dead orchestrator is restarted by running `claude --permission-mode <mode> "/orchestration:orchestrate-work <EPIC>"` (reconstruction mode) in the repo's herdr session: an `orchestrator` tab in the epic's workspace from `herdr-workspace` when that id and label are live (`tab create --workspace`), else a new workspace (`workspace create`), then `pane run`; `<mode>` comes from each ticket folder's `ORCHESTRATOR_PERMISSION_MODE`; the repo is the one whose `git worktree list` has a worktree named for the epic or a ticket | *adapter* `resumeCommand`, `files.permissionMode`; `lib/resume.mjs` |
| A ticket with no `PR` file: its PRs are the ones you wrote in a repo that has `repoConfig` under `MC_ROOT`, whose `origin` branch names it (`[A-Z]+-\d+`, any position). A repo with no config file isn't asked. A variant with lowercase ids or ids outside the branch name needs its own `branchTicket` | *adapter* `branchTicket`; `lib/runs.mjs` `cachedFoundPrs`, `ticketPrs` |
| Hand-run self-reviews live in `<runs_root>/delegate/<TICKET>/REVIEW_REPORT.md`; a ticket with only that folder counts when it has PRs of yours, so reviews of teammates' PRs stay out. A variant without the folder sets `reviewDir: null` | *adapter* `reviewDir`, `reviewReport`; `lib/runs.mjs` `collectReviewOnly`, `lib/metrics.mjs` |
| Plan-gate dialog screen format | `lib/attention.mjs` `parseDialog`, fixture `test/fixtures/screens/plan-gate.txt` |
| Plan gates are answered with `herdr pane send-keys <pane> down|up|enter`, one key per call, re-reading the pane (`herdr agent read`) between keys; the dialog uses ❯ for the selected option and "Enter to select" in its footer | `lib/gate.mjs`, `server.mjs` `answerPlanGate` |
| Merges are approved by sending the orchestrator "Merge PR #N for TICKET." (plus " when its CI is green" while checks are running or failing, or when CI couldn't be read: no checks entry, because the SCM lookup failed or there's no SCM access) with `herdr agent prompt`; the orchestrator must act on that wording, and `mergeApprovals` must recognise it. The PR number comes from the URL (`prNumber()`, either host) | `server.mjs` `approveMerge`, `lib/orchestrators.mjs` `mergeApprovals` |
| Background task output is written by Claude Code to `<os tmp>/claude/<project>/<session>/tasks/<task id>.output` (task ids are read from the launch acknowledgement in the transcript) | `lib/tasks.mjs`, `lib/orchestrators.mjs` `parseActivity` |
| Flow step detail (model and effort per step): the adapter's `files.launch` (the ticket folder's `LAUNCH_implement` / `LAUNCH_review`, `role= model= effort=` lines), the repo config's `agents.<role>.model` / `.effort` (`agents.orchestrator.effort` read as the planner's; its `.model` ignored), transcripts' `assistant` records (`message.model` and `effort` / `perTurnEffort` on the record), the subagent transcripts under `<session>/subagents/`, and the worker's plan-gate answer (the tool result of its AskUserQuestion with header "Plan gate"), where planning ends; `agents.reviewer.executor` `codex` gives the reviewer the planner's values | *adapter* `roleOfStep`, `actorOf`, `roleConfig`, `launchOf`, `configured`, `replyOf`, `gateAnswerOf`, `boundaryOf`, `stepWindow`; `lib/stepmodel.mjs` |
| Process metrics: stage times are the artifacts' file mtimes (`KICKOFF.md` → `PLAN.md` → `REPORT.md` → `REVIEW_REPORT.md`); plan-gate waits are worker transcripts' AskUserQuestion calls with header "Plan gate" (ask → answer), with the ticket id in the question, answer or opening prompt | *adapter* `timeline`, `gateHeader` |
| Usage panel: a ticket's worktree folder is `<repo>-wt-<TICKET>` (or `wt-<TICKET>` inside a folder named for the repo); a worker that starts outside its worktree opens with the worker prompt (`workerPrompt`, "GOAL: … (TICKET)"); a reviewer's opening prompt matches `reviewerPrompt`; an orchestrator is found by `epicCommand`/`epicWatch`, and each of its replies counts toward the epic it was running then | *adapter* `reviewerPrompt`, `workerPrompt`; `lib/usage.mjs` `WORKTREE`, `attribute` |
| Process metrics count you away during any gap of 3 h or more between signs of you: a transcript's `type: "user"` entries with `origin.kind` `"human"` (not `isMeta`, `isSidechain` or `isCompactSummary`) outside ticket worktrees' project folders, and tool results answering an `AskUserQuestion` call in any transcript. herdr types the orchestrator's prompts into worker panes, where Claude Code records them as typed, so prompts in a worktree's session don't count | `lib/metrics.mjs` `presence`, `awayStretches` |

A quick way to check: point `RUNS_DIR` at a run folder the variant has produced and open the flows panel.
Then capture one real plan-gate screen into a fixture and run `npm test`.

## A second machine (a headless worker)

Run a second Cleon on the worker and show its rows in yours. Nothing here listens on a network. The worker's
Cleon stays on its own loopback, and yours reads it through an SSH local forward.

**On the worker:**

- **Start Cleon in the desktop session (RDP), not over SSH.** A Windows SSH login with a key is an S4U logon. It
  can't read Windows Credential Manager, so anything it starts (herdr servers, orchestrators restarted from
  Cleon) has no git credentials, and that only shows up at push time. An SSH login is also elevated, and herdr
  refuses ordinary clients for an elevated server. herdr servers started over SSH do survive logout; that isn't
  the problem. Disconnecting RDP leaves everything running.
- **Its `.env`:** `MC_HEADLESS=1`, so jumps, restarts and herdr updates never raise or open windows on a desktop
  no one sees. It needs no source-control token and no Linear key, because the main machine looks up the
  worker's PRs and CI. Without them the worker's own Linear and source-control panels show offline. Its merge
  cards show "CI unknown", and their prompts always ask the orchestrator to wait for green.
- **Start it with `node server.mjs`,** for example in a herdr pane started from RDP. `scripts/launch.sh` also
  opens a Chrome window, which has no use there.

**On the main machine:**

- **`.env`:** `MC_PEERS=worker=ssh://<worker>`, where `<worker>` is an ssh_config Host alias (or host name) that
  logs in with a key and no prompt.
  - Cleon runs the tunnel itself and keeps it up: `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes
    -o ConnectTimeout=10 -o ServerAliveInterval=30 -L 127.0.0.1:<port>:127.0.0.1:4317 -- <worker>`. The arguments
    are fixed in `lib/tunnel.mjs`; only the host comes from `.env`, and nothing that could be an option is accepted.
  - It keeps the same local port from start to start (`data/peer-tunnels-<Cleon's port>.json`). At startup it
    ends any ssh a killed Cleon left behind. Stopping or restarting Cleon, or closing its window, ends the tunnel.
  - **When it drops:** if the tunnel had been up a minute it is tried again after 1 s; after a network error,
    after 1 s and then doubling up to a minute. After a refused login, or anything else the worker's sshd
    closed, it waits a full minute, because OpenSSH's `PerSourcePenalties` blocks a source address that fails
    logins quickly. That block would also cut off every other ssh from this machine, herdr's saved machine among
    them.
  - The header's peer chip links to the worker's own Cleon page. Its tooltip shows the tunnel's state and ssh's
    last error, which stays on this machine because it names the account and the worker's address.
  - A Windows worker on a domain needs its domain controller to accept a key login. A worker whose VPN dropped
    refuses keys (`Permission denied (publickey)`) until it can reach the controller again.
- **Or run the tunnel yourself:** `ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:4319:127.0.0.1:4317 <worker>`,
  with `MC_PEERS=worker=http://127.0.0.1:4319`. A URL that isn't loopback is refused at startup and never contacted.
- Either way, never forward to `0.0.0.0` (`-L 0.0.0.0:…`, `-g`, `GatewayPorts`): that would put the worker's
  Cleon on the network. The Host and Origin checks pass through the forward unchanged, since both sides are
  `127.0.0.1`.

**What shows:**

- **Shown, tagged with the machine:** sessions, runs, orchestrators, workers, attention, herdr workspaces and
  session activity. The header shows each peer as up or offline, and a peer that stops answering has its rows
  hidden until it answers again. A peer on an older Cleon stays up. Only what it doesn't serve yet is left out,
  and its tooltip names those parts, so the two machines can be updated one at a time.
- **Handed to the worker's Cleon:** plan gates, merge approvals, jumps and orchestrator restarts on its rows.
  A jump focuses the herdr pane there and opens no window there. This machine then raises and flashes its own
  herdr window that is switched to the worker (the worker's saved machine, picked in herdr's sidebar), which
  follows the focus. The window is found by its title, `<worker's host>: <workspace label>`. The host comes
  from the worker's `/api/herdr`; an older worker Cleon doesn't report it, so the label alone is matched. To set
  it up, add the worker as a herdr saved machine (`herdr machine add <worker> --remote-session <session>`) once
  its herdr server is running, and keep one herdr window here switched to it. Run `machine add` only after that
  server is up: if none is running, it starts one over SSH, as S4U. With no window showing the worker, the jump's
  message names the saved machine to switch to. Cleon itself runs no SSH and opens nothing. (`herdr --remote`
  can't attach to a Windows worker whose SSH shell is PowerShell, and herdr has no API to switch a window to a
  saved machine.)
- **Process panel:** away time is computed over both machines' signs of you (`/api/process-input`). A worker
  ticket's stage times come from the worker.
- **Resources panel:** each peer's own CPU, memory, disks, GPU (when it has one) and top processes, in a
  section of its own under this machine's, greyed with the reason while it isn't answering. A peer is asked
  only while the panel is open, and only for its own machine (`/api/resources?local=1`).
- **Usage panel:** each peer's Claude spend counted with this machine's (`/api/usage-input`: each transcript's
  token counts, role, ticket, epic and project name, never a path or prompt text). A ticket or epic worked on
  both machines is one row; projects and sessions are per machine, with its chip. A peer's totals are never
  saved into this machine's `data/usage-ledger.json`, and a peer that isn't counted is named above the views.
- **Per machine (not merged):** Projects, the knowledge map, Linear, Docker and herdr
  updates.

## The Inbox scan (optional)

Off unless `MC_SCAN=1`. When on, Cleon runs `claude -p` at each of `MC_SCAN_HOURS` (local; default 8, 12 and 16)
and on the Inbox panel's Scan now, to find Teams meetings whose transcript isn't filed in their project yet
(`lib/scan.mjs`).

- **Needs:** the `claude` CLI on `PATH`, signed in with a claude.ai account whose Microsoft 365 connector is
  connected. `claude mcp list` should show `claude.ai Microsoft 365 … Connected`. Cleon holds no Microsoft Graph
  credentials of its own. `--bare`, `--strict-mcp-config` and `--setting-sources` without `user` all drop that
  connector, which is why the scan doesn't use them.
- **What the run can do:** only `outlook_calendar_search`, `read_resource`, `outlook_email_search` and
  `chat_message_search` from that connector, all read-only (the last two look for answers to waiting-on items,
  `lib/waiting.mjs`). Every built-in
  tool but ToolSearch is off (`--tools ToolSearch`: with none at all, every MCP server's tool definitions load up
  front, which cost $0.50 a run). `--permission-mode dontAsk` refuses everything else. One gap: a tool your own
  Claude settings pre-allow (`permissions.allow` in `~/.claude/settings.json`) would also run, so keep MCP tools
  that change things out of that list on a machine that scans.
- **Settings:** `MC_SCAN_MODEL` (default `haiku`, also used for Ingest's session) and `MC_SCAN_BUDGET` (dollars per
  run, default 1, passed as `--max-budget-usd`).
- **Cost (measured 2026-11-06, list prices, as the Usage panel counts them):** a scan of the last few hours took
  3 turns, about $0.006 on Haiku and $0.12 on Sonnet. The first scan covers 7 days: $0.04 on Haiku, $0.96 on
  Sonnet. Both models found the same 20 meetings and differed on one match. A waiting-on item adds a mail
  search and a chat search; its first check covers everything since it was added (one going back four weeks
  took the run to 17 turns, $0.05 on Haiku), later ones only the hours since the last scan. Each scan's tokens
  are kept in `data/inbox-<port>.json` and counted in Usage under Cleon's own folder, since the run keeps no
  transcript.
- **Waiting on** (`lib/waiting.mjs`, the Waiting on panel): items you type, kept in `data/waiting-<port>.json`.
  Open items without a "maybe answered" are put in each scan's prompt (what and who as JSON strings) with the
  time to look from: when added, after a Not yet, or the last check less 6 hours. An answer must name an item it
  was asked about, or the whole scan fails the check.
- **Transcripts filed:** a project counts as having a meeting's transcript when a file named `YYYY-MM-DD…` for
  the meeting's date, ending `.vtt` or with "transcript" in its name, is anywhere up to four folders deep
  (dependency, build and hidden folders skipped). New ones are suggested for the folder that holds most of the
  project's transcripts, else `communications/`.
- **Fetching transcripts** needs the Teams setting `EnableGraphTranscriptAccess` on in the tenant
  (`Set-CsTeamsMeetingConfiguration`, off by default). The scan checks once a day; until it works, flags say to
  download the VTT. Ingest then opens an interactive Claude session in the project, through herdr, that reads
  the meeting and its transcript and saves the file.
- **Windows:** a scan still running after 10 minutes, or when Cleon exits, is ended with `taskkill /T /F`
  (elsewhere, a plain kill).

## CI

`.github/workflows/test.yml` runs `npm test` on GitHub Actions (Windows, Node 24). A Bitbucket repo
needs its own pipeline running the same two commands, `npm ci` then `npm test`, on a Windows runner.
The tests don't read `.env`, so the pipeline needs no secrets.

## Platform assumptions (Windows)

These parts are Windows-only. A non-Windows machine would need replacements:

- `lib/raise-window.py`: brings a VS Code window, a window by its class name, a herdr client window
  (title "<host>: <workspace label>"), or the terminal window a process runs in (`--pid`: its Windows
  parents, Toolhelp32), to the front. Git Bash breaks the Windows parent chain, so `lib/vscode.mjs` also
  walks Git Bash's own process table (`<MC_GIT_DIR>/usr/bin/ps.exe -W`) up to the mintty window.
  A raised window's border and title bar then pulse cyan for about 1.5 s (`--flash`, run detached; DWM
  border, caption and text colors, so Windows 11 only: Windows 10 refuses them and nothing flashes).
  For herdr updates it also closes Cleon's windows on a session (`--close`, `WM_CLOSE`, printing each one's
  `GetWindowPlacement`) and puts the new window in the same place (`--place`, `SetWindowPlacement`, run
  per-monitor DPI aware so mixed-scale monitors round-trip).
- `lib/proc-stats.py`: per-process CPU, and (`--io PID`) the server's own bytes read and written for the
  Activity panel's I/O tile. Elsewhere that tile shows "—"; the rest of the panel uses only Node built-ins.
- `typeperf` and `tasklist` in `lib/resources.mjs`.
- `scripts/launch.sh`: the desktop launcher (Git Bash + Chrome app window). The shortcut: target
  `C:\Program Files\Git\bin\bash.exe`, arguments `--login "<repo>/scripts/launch.sh"`, run minimized, icon
  `assets/mission-control-radar.ico`. It sets `MC_SUPERVISED=1` and starts the server again whenever it exits
  with 75 (`RESTART_CODE`), which is how ＋ Panels → Restart server works. Any other exit ends it (Stop server
  exits 0, so the window closes). Another launcher needs the same loop.
- `lib/open.mjs` (the Knowledge panel's project buttons): herdr and bash open in Git for Windows' `mintty.exe` (`MC_GIT_DIR`), a
  standalone Git Bash window with Git's icon and a per-window class; herdr, a native console program, runs
  there with `-o ConPTY=true`. The window takes `git-bash.exe`'s taskbar identity (`AppID=GitForWindows.Bash`,
  relaunch command `<MC_GIT_DIR>/git-bash.exe`) so it groups with other Git Bash windows. Every name `.env`
  sets is removed from the environment these windows and headless herdr servers get. VS Code is found with
  `where code.cmd` and its `../Code.exe` is run directly.
- `openFile` in `lib/open.mjs` (the viewer's Open in default app, for Office files): runs `explorer.exe "<path>"`,
  the path one quoted argument passed verbatim (`windowsVerbatimArguments`), never through `cmd`, so a name with
  `&` or `^` can't run anything. On macOS it runs `open`, elsewhere `xdg-open`; neither has been tried. Every
  name `.env` sets is removed from the app's environment. Refused when `MC_HEADLESS=1`.
- Close sessions… (`lib/close.mjs`, the Sessions panel's button): ends a session with `taskkill /PID <pid> /T /F`
  after checking, with `Get-CimInstance Win32_Process`, that the pid is still `claude.exe` started at the session
  file's `procStart` (a FILETIME). Both start through `lib/bin.mjs`. Elsewhere `/api/close-sessions` answers
  `{ supported: false }`, the close routes refuse, and the button isn't shown. The reopen list is
  `data/closed-sessions-<port>.json`. A session the VS Code extension hosts (`entrypoint` other than `cli`) is
  listed as "close it in VS Code" and never ended; what ending one does there hasn't been tried.

## The knowledge match (optional)

Off unless `MC_KNOWLEDGE_MATCH=1`. The knowledge map's belts (`lib/belts.mjs`) place vault pages and the notes of
memory stores no project claims by a free first pass: mentions of a project's name, and links from its own files.
With the match on, items that pass leaves unmatched go to Haiku (`lib/belt-match.mjs`) after an index build: in the
background, one pass at a time, 20 items to a run and at most 200 a pass. When the pass is saved the index is
built again with its answers.

- **Needs:** the `claude` CLI on `PATH`, signed in (the same claude.ai login as the Inbox scan). No connector.
- **What the run can do:** nothing. `--tools ""` turns every built-in tool off, `--strict-mcp-config` loads no MCP
  server, `--setting-sources ""` loads no settings file and no CLAUDE.md (none of your settings, hooks or
  pre-allowed tools, and nothing from the run's folder or one above it: with `project`, `~/.claude/CLAUDE.md` went
  with every run, since the temp folder is under your home), `--system-prompt` replaces Claude Code's, and
  `--no-session-persistence` keeps no transcript.
  The prompt goes in on stdin: each project's `category/name` and description, then each item's path and first
  1500 characters as a JSON string. Each run may spend at most $0.25 (`--max-budget-usd`).
- **What's sent:** vault pages and memory notes, which can name people and internal systems. Nothing matching
  `MC_EXCLUDE` is a belt item, so none of it is sent, and a project's README or CLAUDE.md that `MC_EXCLUDE` matches
  isn't read for its description. A store no project claims is checked by reading its folder's path back from its
  name, so a pattern written for a path still keeps it out: every folder on disk the path may run through, and below
  each every reading of the part that's gone, each folder of it tested as well as the whole. The path is read from
  `MC_ROOT` as configured when the store is under it, else from its drive or `/`. Links to folders are followed
  (macOS's `/tmp` is one), and each folder is tested as found and as its real path. A gone part with more than five
  `-` can't be read back every way, so while `MC_EXCLUDE` is set that store is left out. **Windows-only:** a part
  written as an 8.3 short name (`RUNNER~1`, `ACME-S~1`, from a session started on a short path) is asked for
  directly, since no folder listing shows it.
- **Cache:** `data/knowledge-match-<port>.json` holds each answer by the file's content hash (SHA-1), so an item
  is sent again only when it changes. A run whose reply fails the check stops the pass and caches nothing from it.
  Answers apply only while the match is on.
- **Cost (measured 2026-11-08, list prices, as the Usage panel counts them):** the first pass over 186 belt items
  left 102 for Haiku: 6 runs, about 25k tokens each (written to Claude Code's 1-hour cache), $0.033 in all on
  Haiku 5.5, about a minute. Later passes send only new or changed items. Each run's tokens are kept in the cache
  file and counted in Usage under Cleon's own folder, since the run keeps no transcript.

## Kept in sync

| Change | Date |
|---|---|
| Initial checklist (through the Docker panel, `de05f82`) | 2026-11-01 |
| Phase 2 done: machine settings moved to `.env` via `lib/config.mjs` | 2026-11-01 |
| CI added (GitHub Actions); tests made independent of `.env` | 2026-11-01 |
| Background task progress reads Claude Code's task output files | 2026-11-01 |
| Plan gates answerable from the dashboard (herdr send-keys) | 2026-11-01 |
| Merge approval button (herdr agent prompt) | 2026-11-01 |
| CI checks for your own PRs, and each session's PRs | 2026-11-01 |
| Runs reconcile ticket PRs against GitHub (`prState`) | 2026-11-01 |
| Process metrics panel (`prDetail`, run-file mtimes, plan-gate transcripts) | 2026-11-01 |
| Orchestration adapter (`MC_ORCH_ADAPTER`, `lib/adapters/`, `docs/RUN-FORMAT.md`); renamed to Cleon | 2026-11-02 |
| Project map panel (`MC_GIT_DIR`, headless `herdr --session <name> server`, `workspace create`, `session attach` in mintty with ConPTY, `agent`/`tab focus`, `pane run`, Code.exe) | 2026-11-02 |
| Phase 3: Bitbucket adapter (`MC_SCM`, `BITBUCKET_URL`, `BITBUCKET_TOKEN`; `lib/bitbucket.mjs`, `lib/scm.mjs`, `prNumber()`) | 2026-11-02 |
| Restart button (`launch.sh` restarts on exit code 75; `MC_SUPERVISED`, `/api/restart`, `/api/boot`) | 2026-11-02 |
| Stop button (`/api/stop` exits 0; the page closes its own window) | 2026-11-02 |
| Bitbucket adapter waits out rate limits (429 + `Retry-After`) instead of caching them as failures | 2026-11-02 |
| Jumps find sessions run from plain Git Bash or Windows Terminal (`raise-window.py --pid`, `ps.exe -W`), and herdr in any window (class, then title, then VS Code) | 2026-11-02 |
| Project map windows group with Git Bash (`git-bash.exe` AppID and relaunch command) and don't inherit `.env`; open checks the folder without git (`findProject`) | 2026-11-02 |
| Activity panel (`lib/activity.mjs`: Node's `child_process`, `undici:request:*` and `http.server.*` diagnostics channels; `note()` in `sessions.mjs` and `readActivity`; `/api/activity`; `proc-stats.py --io`) | 2026-11-03 |
| Lighter polling: the repo scan finds repos by their `.git` entry and reads each with `git status --porcelain=v2 --branch --no-ahead-behind` (**git 2.17+**; older git leaves every branch blank) plus `git log -1`, 8 folders at a time; the herdr snapshot, session list and scan are shared across endpoints (`cached` in `server.mjs`); the page's timed polls never overlap (`single`) | 2026-11-03 |
| A window Cleon raises flashes its border and title bar (`raise-window.py --flash`, Windows 11 DWM colors) | 2026-11-03 |
| Restart a dead orchestrator from its flow card (`/api/runs/restart`, `lib/resume.mjs`; *adapter* `resumeCommand`, `files.permissionMode`; `git worktree list --porcelain`; `startInHerdr` in `lib/open.mjs`, which also makes the Project map raise a window already showing the session instead of attaching a second); the orchestrator opens as a tab in the epic's restored workspace (`tab create`) | 2026-11-03 |
| Jumps into herdr attach a window when none shows the session (`herdrFocus` `attach`, `attachHerdrWindow`), so panes stay reachable after a crash closes every window | 2026-11-03 |
| Process panel counts a wait while you were away (nights) apart from waiting on you (`presence`, `awayStretches`, `awayWithin` in `lib/metrics.mjs`; Claude Code transcripts' `origin.kind`, `isCompactSummary`, and `AskUserQuestion` answers) | 2026-11-04 |
| Usage panel (`lib/usage.mjs`, `/api/usage`): every transcript's `message.usage` (input, output, `cache_creation.ephemeral_1h_input_tokens` and the rest of `cache_creation_input_tokens`, `cache_read_input_tokens`, `speed`) priced from the `PRICES` table (Anthropic list prices as of 2026-10-06; update it when prices change); totals kept in `data/usage-ledger.json`; *adapter* `reviewerPrompt`, `workerPrompt`; Codex placeholder counts `~/.codex/sessions/**/*.jsonl` | 2026-11-04 |
| Tickets with no `PR` file found on the host by branch name, yours only (`repoPrs`, `me` in both adapters; `gh pr list`, `gh api user`, `git remote get-url origin`; *adapter* `branchTicket`, `reviewDir`, `reviewReport`); Process rows combine a ticket's PRs; `/api/runs` and `/api/process-input` carry review-only tickets to peers | 2026-11-05 |
| herdr update badge and button (`lib/herdr-update.mjs`, `/api/herdr/version`, `/api/herdr/update`): reads herdr's own update check from `release-notes.json` beside the default session's socket (`herdr status --json` → `server.socket`) and each server's version (`herdr --session <name> status --json`); updates with `herdr update`, then restarts servers with `herdr --session <name> server stop` and a headless start; only at a pause (no herdr agent `working` or `blocked`, no live orchestrator with a ticket not `done`); `raise-window.py --close`/`--place` | 2026-11-04 |
| Merge approvals treat CI that couldn't be read as not yet green (`ciGates`; `ciUnknown` in `/api/merge/approve`'s answer; a "CI unknown" chip on the merge card), so a Cleon without SCM access never drops the CI condition | 2026-11-04 |
| Peers, reading (`MC_PEERS`, `lib/peers.mjs`, `/api/peers`, `settleRuns` in `lib/runs.mjs`): `/api/sessions`, `/api/runs`, `/api/orchestrators`, `/api/workers`, `/api/attention`, `/api/herdr` and `/api/session-activity` add each peer's rows tagged `machine`; a peer's workers and CI checks go by `<machine>\|<ticket>`; a peer's PRs are checked with this machine's source control | 2026-11-04 |
| Peers, acting: an action on a peer's row (`/api/gate/answer`, `/api/merge/approve`, `/api/herdr/focus`, `/api/session/focus`, `/api/runs/restart`) names its `machine` and is POSTed to that peer with its Host, a matching Origin and JSON, minus `machine`; `/api/run-file` and `/api/task-output` take `?machine=`. `MC_HEADLESS` (`startInHerdr` `headless`) | 2026-11-04 |
| Peers, Process panel: each peer serves `/api/process-input` (`processInputs` in `lib/metrics.mjs`: signs of you, plan-gate waits and each PR'd ticket's artifact times, as timestamps and ticket ids only); `processMetrics` takes `peers`, computes away time over every machine's signs of you, and takes a peer ticket's stage times from its peer | 2026-11-04 |
| Peers, page: a peer's rows show a machine chip; tickets, epics, workers and CI checks are looked up by `<machine>\|<id>` (`ref`, `findTicket`, `orchFor`, `livePane` in `public/app.js`), and every action and file read on a peer's row sends its `machine`; the header shows each peer up or offline (`/api/peers`, polled with the 5 s poll) | 2026-11-04 |
| Peers, Resources: `/api/resources` adds `peers` (`peerSamples` in `lib/peers.mjs`: each peer's own sample, or why there's none), read from each peer's `/api/resources?local=1`, which answers with that machine's sample only; the panel draws a section per peer (`resTiles`, `procTable` in `public/app.js`) | 2026-11-04 |
| Peers, Usage: each Cleon serves `/api/usage-input` (`usageInput` in `lib/usage.mjs`: attributed per-transcript totals, no paths or prompt text) from one shared scan (`usageFiles`); `usageReport` takes `peers` and merges tickets and epics across machines, keeping projects (`<machine>\|<project>`) and sessions per machine; `/api/usage` adds `peers` (`peerCounts` in `lib/peers.mjs`) for the note on who's counted | 2026-11-04 |
| Peers, jumps: `/api/herdr` adds `host` (`os.hostname()`). When a peer answers a forwarded `/api/herdr/focus` or `/api/session/focus` with a herdr `session` and `workspace`, `forward` adds `here` (`peerWindow` in `server.mjs`). It raises and flashes the herdr window here titled `<peer host>: <workspace label>` (`raisePeerHerdr` in `lib/vscode.mjs`, `--herdr <label> --host <host>` in `lib/raise-window.py`, `herdr_title`). Otherwise it names the saved machine to switch to (`herdrMachines`: `herdr machine list --json`, target = the peer's name, matching session) or the `herdr machine add` command | 2026-11-05 |
| Peers, tunnels: `MC_PEERS` takes `name=ssh://<host>` (`parsePeers`, `SSH_TARGET` in `lib/tunnel.mjs`). `startTunnels` in `server.mjs` runs one `supervise` per such peer: a fixed `tunnelArgs` (`ssh -N … -L 127.0.0.1:<port>:127.0.0.1:4317 -- <host>`), restarted by `failureKind` (port taken: a new port; network: 1 s doubling to 60 s; anything sshd said: 60 s). It stops on exit and on SIGINT, SIGTERM and SIGHUP. The local port and ssh pid are kept in `data/peer-tunnels-<port>.json`, read at startup by `killOrphans` (Windows `Get-CimInstance Win32_Process`). `peerSource` gains `retarget`. `/api/peers` adds `tunnel`, and the header's peer chip links to the peer's page | 2026-11-05 |
| Inbox scan: `MC_SCAN`, `MC_SCAN_HOURS`, `MC_SCAN_MODEL`, `MC_SCAN_BUDGET` (`lib/config.mjs`). `lib/scan.mjs` runs `claude -p` (new CLI dependency, with the claude.ai Microsoft 365 connector) with fixed `scanArgs`, checks its reply (`checkScan`), finds filed transcripts on disk (`filingsIn`), and keeps state in `data/inbox-<port>.json`. `/api/inbox` and the `/api/inbox/scan`, `dismiss` and `ingest` actions are this machine's only (not in `FORWARDED`, never merged from peers). Scan costs join `usageFiles` (`scanUsageFiles`). The side panel's Inbox tab (`renderInbox`, `pollInbox` in `public/app.js`) replaces the Gmail placeholder. Windows: `taskkill /T /F` ends an overrunning scan | 2026-11-06 |
| Waiting on: `lib/waiting.mjs` (`cleanItem`, `toCheck`, `applyAnswers`, `waitingView`) and `data/waiting-<port>.json`; `/api/waiting` plus `/api/waiting/save`, `close` and `not-yet`, this machine's only. The scan adds `outlook_email_search` and `chat_message_search` to `SCAN_TOOLS`, a `waiting` list to its prompt and reply (`checkScan` takes `asked`), and `runScan` now resolves `{ state, answers }`. Panel `waiting` in `public/app.js` (`renderWaiting`, `pollWaiting`, polled every 60 s even when closed, for the overdue notice) | 2026-11-06 |
| Views: header tabs Dev, Groom and Exec (`VIEWS`, `VIEW_DEFAULTS`, `setBoardView`, `renderViewTabs` in `public/app.js`), each with its own layout in the browser (`mc.layout.<view>`; the old `mc.layout` is read as Dev's until Dev saves its own) and the last view in `mc.view`. The Inbox left the side panel's tabs for its own panel (`inbox`). Browser only: no server change | 2026-11-06 |
| Groom queue: `lib/groom.mjs` (`groomQueue`, `snoozeUntil`, `pruneGroom`, `ticketCommand`) and `data/groom-<port>.json`; `/api/groom` and `/api/groom/act` (key plus action, looked up again on the server; `ingestMeeting` now shared with `/api/inbox/ingest`), this machine's only. Sources: the Inbox, Waiting on, `reviewRequests` from the SCM summary, and Linear's assigned issues (Triage, or a description under 20 characters). Links are kept only on `github.com`, `linear.app` or `BITBUCKET_URL`'s host. Panel `groom` in `public/app.js` (`renderGroom`, `pollGroom`, polled every 30 s for Groom's tab count); Groom's default layout leads with it | 2026-11-06 |
| Exec summary: `lib/exec.mjs` (`spendCard`, `cycleCard`, `stalledCard`, `portfolioCard`, `groomCard`, `execCards`, weekly `snapshotIfDue` to `data/exec-<port>.jsonl`); `/api/exec` builds them from `usage()`, `metrics()` (both with peers), `allRuns()`, Linear, `inboxProjects()` (so `MC_EXCLUDE` applies) and the Groom queue. Panel `exec` in `public/app.js` (`renderExec`, `pollExec`, only while on the board); Exec's default layout leads with it. Test anything that opens it from a scratch copy, since it reads Usage (shared ledger) | 2026-11-06 |
| Knowledge index (`lib/knowledge.mjs`, `MC_KNOWLEDGE_FOLDERS`): each project's docs, comms, outputs and Claude memory store (the store whose folder is Claude Code's slug of the project's path, or of a folder inside it), document types only; the vault isn't read for now. `/api/knowledge` (`{ root, tree }`) replaces `/api/graph` and `/api/projmap`; `/api/file` reads only the index's text types (others answer 415). The Knowledge panel replaces the Project map, whose saved place it takes (`readLayout` in `public/app.js`) | 2026-11-08 |
| Asteroid belts: `MC_VAULT` is read again (Markdown pages, links not followed) and memory stores no project claims are no longer dropped (`lib/belts.mjs`; `belt` on project nodes and the root; `/api/file-info` adds `orbits`). A stray store is kept out when `MC_EXCLUDE` matches its folder's path, read back from the store's name (`strayExcluded`, `slugFolders`, `readings` in `lib/knowledge.mjs`: from `MC_ROOT` when under it, every folder on the way and above, following links, on Windows asking for 8.3 short names directly, and left out when it can't be read back; a README or CLAUDE.md `MC_EXCLUDE` matches isn't read for a project's description). The knowledge match: `MC_KNOWLEDGE_MATCH` (`lib/config.mjs`), `lib/belt-match.mjs` runs `claude -p` with no tools, no MCP servers and `--setting-sources ""`, caches answers in `data/knowledge-match-<port>.json`, and its runs join `usageFiles` (`scanUsageFiles` takes a prefix) | 2026-11-08 |
| Reading any knowledge item: the index takes PNG, JPEG, GIF and WebP images (not SVG). `/api/file` serves every index type as its own content type, as bytes, with `nosniff` and `no-store`, HTML under `Content-Security-Policy: sandbox allow-scripts` and every other type under `sandbox`, Office files as attachments (no more 415). `/api/file-info` gives a file's name, size, time, item, project, group and versions. `/view?id=` (`public/view.html`, `showFile` in `public/viewer.mjs`) shows one file in its own window. `/api/file/open` (Office files only, refused when headless, this machine only) runs `openFile` in `lib/open.mjs` (Windows `explorer.exe`). Rendered Markdown keeps only safe link and image schemes (`markdownSafety`, `safeUrl` in `public/view-lib.mjs`) | 2026-11-08 |
| Knowledge map centre: `MC_ROOT/CLAUDE.md` is read into the knowledge index (`tree.file` on the root, `lib/knowledge.mjs`), so `/api/file` serves it by id; a fixed file name under `MC_ROOT`, left out when `MC_EXCLUDE` matches its path as written or with forward slashes, or when it's a link (`lstat`) | 2026-11-08 |
| Every by-id read of a knowledge file (`/api/file`, `/api/file-info`, `/api/file/open`, so also `/view?id=`) checks the file again on each ask (`stillIndexed` in `lib/knowledge.mjs`, called from `indexFile` in `server.mjs`, and before `buildText` in `lib/search.mjs` reads a file's text): `MC_EXCLUDE` not matching it, still a plain file (`lstat`), and once links, junctions and 8.3 short names are resolved (`realpath`) at the same place below the nearest folder the index was read from, under where that folder really was at build time (`roots` from `buildIndex`: `MC_ROOT`, each category, each memory store's `memory` folder, `MC_VAULT`, so a link the index itself reads through stays readable; the walk follows no link below them, so any other difference is a swap). Hard links aren't caught. Its tests swap a folder for a junction (no privilege needed on Windows) and a file for a file link (skipped where the account may not make one) | 2026-11-09 |
| Programs started by the pollers (herdr, git) run from one worker thread: `execFile` in `lib/bin.mjs`, imported by `lib/herdr.mjs`, `herdr-update.mjs`, `attention.mjs`, `projects.mjs`, `runs.mjs`, `sessionprs.mjs`, `resume.mjs` and `server.mjs`. Starting a program holds up the thread that starts it while Windows creates the process (100–400 ms here under load), which stalled every route; options passed to it must be plain data. The Activity panel still sees each program through a stand-in on the `child_process` diagnostics channel. No new setting or dependency | 2026-11-09 |
| Docker and the peer ssh tunnel start from the same worker: `lib/docker.mjs` (its `execFile` and the long-lived `docker events`) and `lib/tunnel.mjs` (`ssh` and the `powershell` process lookup) import from `lib/bin.mjs`, which adds `spawn` for a program that runs on: output streams back as text, the pid arrives with the `spawn` event (the tunnel records it then), and `kill()` ends it straight from the server's thread once the pid is known, so it still works from a process `exit` handler (a server that exits in the moment between starting ssh and learning its pid leaves it running on Linux or macOS, unrecorded; Windows ends it with the server). The source guard in `test/bin.test.mjs` covers git, herdr, docker, ssh and powershell. An exit-time `taskkill` (`lib/scan.mjs`) stays on node's own, since a start posted to the worker never runs during exit. No new setting or dependency | 2026-11-09 |
| Close sessions… (Windows only): `lib/close.mjs` (`closable`, `sameProcess`, `closer`, reopen list in `data/closed-sessions-<port>.json`); `GET /api/close-sessions` and the `/api/close-sessions/start` and `now` actions, this machine's only (not in `FORWARDED`); `taskkill` and a `powershell` `Get-CimInstance` check started through `lib/bin.mjs`, and the source guard in `test/bin.test.mjs` now covers `taskkill` (allowing `lib/scan.mjs`'s exit-time one). New setting `MC_SESSIONS_DIR` (`lib/config.mjs`); `listSessions` also returns `entrypoint` and `procStart` | 2026-11-10 |
| Flow step detail: `/api/step-models` (`lib/stepmodel.mjs`, `mergeStepModels` in `lib/peers.mjs`) shows each step's model and effort from the sessions' transcripts (found through Usage's attribution, honouring `MC_EXCLUDE` like it) or, for a step not reached, the role's launch record or config; polled only while Flows is open (and read when it opens), the answer shared for 10 s. Planning ends at the worker's last plan-gate answer. A peer's tickets come from the peer's own `/api/step-models`, with the same 60 s timeout as its usage read (an older Cleon shows "—" with that reason). Reading Usage, it runs `scanUsage` while Flows is open, so CLAUDE.md lists it with the Usage readers. No new environment variable, outside request or Windows-only piece. | 2026-11-11 |
| Fonts are served from the repo, not Google Fonts: `public/fonts.css` (`@font-face`) points at latin woff2 files in `public/vendor/fonts/` (Inter, Saira, JetBrains Mono, Orbitron; licences in `public/vendor/fonts/LICENSES/`, all SIL OFL), linked from `index.html` and `view.html`, and `server.mjs` serves `.woff2` as `font/woff2`. The page no longer makes any outside request. A machine with no internet needs nothing more. No new environment variable or Windows-only piece | 2026-11-11 |
| Today view candidates: `GET /api/today/candidates` (`lib/today.mjs` pure, `lib/today-read.mjs` reads; this machine only, cached 60 s). Sends nothing anywhere and makes no Claude call. New reads: Linear `dueDate` (`lib/linear.mjs`); per project, file names and modified times in `communications/` and the first 8 KB of each file in `adrs/`, `adr/`, `decisions/`, `decision/` (only the status word "Proposed" is kept); `<TICKET>-plan.md` names in the orchestration plans dir (`runLocations().plans`); and one `git status --porcelain=v2 --branch` (with ahead/behind) per repo that already has uncommitted changes, at most 4 at once, never on a clean repo. Every path goes through `excludesFolder`/`excludesPath` (`MC_EXCLUDE`). The orchestration plugin's plan files are named `<TICKET>-plan.md` and its run folders `<runs>/<EPIC>/<TICKET>`; a tool that names them otherwise breaks the "plan with no run" rule. No new environment variable or Windows-only piece | 2026-11-12 |
