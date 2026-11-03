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
- **herdr.** Missing herdr shows as offline. Jumps fall back to raising the session's own terminal window (Git Bash via `ps -W` under `MC_GIT_DIR`, or Windows Terminal), then the VS Code window. The Project map's
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
| `MC_VAULT` | no vault in the knowledge map (memory stores and `CLAUDE.md` files still are) |
| `MC_EXCLUDE` | **nothing excluded**: the server prints a warning at startup. Set it before opening the knowledge map. |
| `MC_DOCKER_DISK` | Docker Desktop's WSL2 default |
| `MC_HOST`, `MC_PORT` | `127.0.0.1`, `4317` |
| `MC_GIT_DIR` | `C:/Program Files/Git` (Project map's bash button runs its `usr/bin/mintty.exe`) |

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

**Host-neutral now:** PR numbers come from `prNumber()` (`lib/scm.mjs`, and its twin in `public/app.js`), which
reads `/pull/N` and `/pull-requests/N`. `prMentions` in `lib/sessionprs.mjs` matches both link forms.

**Still says "GitHub" on Bitbucket:** the Process panel's first loading placeholder, and the tab (and the side
panel's name in ＋ Panels) until the first data load finishes (about 10 s on a cold start).

**Checked against a live Data Center server (2026-11-02):** the dashboard, PR, commits and diff endpoints all answer;
line counts matched `git diff --shortstat` of the merge commits; merged PRs reconcile run tickets to done. The
build-status endpoint answers (the per-repo `.../commits/{sha}/builds` returns 400 without a build key, so it isn't
an alternative). Not yet seen with data: build statuses (none were posted) and the `participantStatus` filter (no
review requests at the time).

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
| Ticket ids match `[A-Z]+-\d+`; worktrees are named `wt-<TICKET>` | *adapter* `idPattern`; `lib/sessions.mjs` |
| The orchestrator is started with `/…orchestrate-work <EPIC>` and watches with `workspace-dispatch.sh watch --epic <EPIC>` | *adapter* `epicCommand`, `epicWatch` |
| Plan-gate dialog screen format | `lib/attention.mjs` `parseDialog`, fixture `test/fixtures/screens/plan-gate.txt` |
| Plan gates are answered with `herdr pane send-keys <pane> down|up|enter`, one key per call, re-reading the pane (`herdr agent read`) between keys; the dialog uses ❯ for the selected option and "Enter to select" in its footer | `lib/gate.mjs`, `server.mjs` `answerPlanGate` |
| Merges are approved by sending the orchestrator "Merge PR #N for TICKET." (plus " when its CI is green" only while checks are running or failing) with `herdr agent prompt`; the orchestrator must act on that wording, and `mergeApprovals` must recognise it. The PR number comes from the URL (`prNumber()`, either host) | `server.mjs` `approveMerge`, `lib/orchestrators.mjs` `mergeApprovals` |
| Background task output is written by Claude Code to `<os tmp>/claude/<project>/<session>/tasks/<task id>.output` (task ids are read from the launch acknowledgement in the transcript) | `lib/tasks.mjs`, `lib/orchestrators.mjs` `parseActivity` |
| Process metrics: stage times are the artifacts' file mtimes (`KICKOFF.md` → `PLAN.md` → `REPORT.md` → `REVIEW_REPORT.md`); plan-gate waits are worker transcripts' AskUserQuestion calls with header "Plan gate" (ask → answer), with the ticket id in the question, answer or opening prompt | *adapter* `timeline`, `gateHeader` |

A quick way to check: point `RUNS_DIR` at a run folder the variant has produced and open the flows panel.
Then capture one real plan-gate screen into a fixture and run `npm test`.

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
- `lib/proc-stats.py`: per-process CPU, and (`--io PID`) the server's own bytes read and written for the
  Activity panel's I/O tile. Elsewhere that tile shows "—"; the rest of the panel uses only Node built-ins.
- `typeperf` and `tasklist` in `lib/resources.mjs`.
- `scripts/launch.sh`: the desktop launcher (Git Bash + Chrome app window). The shortcut: target
  `C:\Program Files\Git\bin\bash.exe`, arguments `--login "<repo>/scripts/launch.sh"`, run minimized, icon
  `assets/mission-control-radar.ico`. It sets `MC_SUPERVISED=1` and starts the server again whenever it exits
  with 75 (`RESTART_CODE`), which is how ＋ Panels → Restart server works. Any other exit ends it (Stop server
  exits 0, so the window closes). Another launcher needs the same loop.
- `lib/open.mjs` (Project map buttons): herdr and bash open in Git for Windows' `mintty.exe` (`MC_GIT_DIR`), a
  standalone Git Bash window with Git's icon and a per-window class; herdr, a native console program, runs
  there with `-o ConPTY=true`. The window takes `git-bash.exe`'s taskbar identity (`AppID=GitForWindows.Bash`,
  relaunch command `<MC_GIT_DIR>/git-bash.exe`) so it groups with other Git Bash windows. Every name `.env`
  sets is removed from the environment these windows and headless herdr servers get. VS Code is found with
  `where code.cmd` and its `../Code.exe` is run directly.

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
