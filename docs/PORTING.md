# Porting Mission Control to another machine

A checklist for standing up a copy of Mission Control on a different setup. The example target uses
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
| Create `.env` with `LINEAR_API_KEY` (that machine's Linear key) | The Linear tab lists your issues |
| Set `MC_PORT` if 4317 is taken | The page loads on `127.0.0.1` |
| Open the Sessions, Herdr and Resources panels | Each shows live data or a clean "offline" |

These already degrade cleanly and need no code changes:

- **Ollama.** Resources shows "Ollama: not running". To hide the line, drop the `#res-ollama` render in
  `renderResources()` (`public/app.js`).
- **Docker.** The panel is off by default. If Docker is missing, it says "Docker isn't running". The disk-file
  tile assumes Docker Desktop on WSL2 (`%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`).
- **herdr.** Missing herdr shows as offline. Jumps fall back to raising the VS Code window.
- **GitHub.** Without `gh`, the GitHub tab shows offline. Replacing it is Phase 2.

## Phase 2: configuration instead of hardcoded paths (about half a day)

Every one of these is a constant today. Move each to `.env` (or a gitignored `mc.config.json`) with the
current value as the default. Doing this here first means a new copy needs no edits.

| Constant | File | Today |
|---|---|---|
| `ROOT`, `CATEGORIES` | `lib/projects.mjs` | `C:/dev` + the five function folders |
| `RUNS_DIR`, `PLANS_DIR` | `lib/runs.mjs` | `C:/wt/.orchestrate-runs`, `C:/wt/plans` (fallbacks; per-repo `paths.runs_root` is still read) |
| Knowledge sources | `lib/graph.mjs` `SOURCES` | `C:/dev/knowledge` vault, `~/.claude/projects` memory, `CLAUDE.md` under `C:/dev` |
| `EXCLUDE` | `lib/graph.mjs` | personal project names |
| Docker disk path | `lib/docker.mjs` `VHDX` | Docker Desktop WSL2 default |

## Phase 3: Bitbucket Server adapter (about a day)

Everything GitHub-specific goes through `lib/github.mjs`, which runs on the `gh` CLI. Add a
`lib/bitbucket.mjs` that returns the **same shapes**, and pick one with an env var (e.g. `SCM=bitbucket`).

**Contract to match:**

- `githubSummary()` → `{ online, reason?, myPrs[], reviewRequests[], issues[] }`.
  - PRs: `{ repository: { name }, number, title, updatedAt, isDraft, url, body, author, checks, reviewDecision, branch }`.
  - `checks` is one of `passing | failing | pending | none`.
- `prChecks(url)` → `{ url, checks: [{ name, bucket, link, running, startedAt, completedAt, mutation }], mutations, at }`.
  - `bucket` is one of `pass | fail | pending | cancel | skipping`. `summarizeChecks()` is reusable as-is.

**Bitbucket Server REST (Data Center 7+/8+):**

- **Auth:** an HTTP access token in `.env` (`BITBUCKET_URL`, `BITBUCKET_TOKEN`), sent as `Authorization: Bearer`.
  Read access to projects and repos is enough.
- **My open PRs:** `GET /rest/api/1.0/dashboard/pull-requests?role=AUTHOR&state=OPEN`.
- **Review requests:** the same endpoint with `role=REVIEWER&state=OPEN`. Keep only PRs where your reviewer
  status is `UNAPPROVED`.
- **Issues:** Bitbucket Server has none. Return `issues: []`, since Linear covers them.
- **Build status:** `GET /rest/build-status/1.0/commits/{latestCommit}`.
  - Map `SUCCESSFUL→pass`, `FAILED→fail`, `INPROGRESS→pending`; `running` = `INPROGRESS`.
  - Bitbucket build status has no "queued" state, so the dashboard can't tell queued from running there.
- **Review decision:** from the PR's `reviewers[].status`. Any `NEEDS_WORK` → changes requested; all
  `APPROVED` → approved.

**Other places that assume GitHub URLs:**

- `PR_URL` in `lib/github.mjs` only accepts `github.com/.../pull/N`. Bitbucket uses
  `https://<host>/projects/<P>/repos/<r>/pull-requests/<N>[/overview]`.
- `public/app.js` gets the PR number with `url.split('/').pop()` in several places (`mergeApproved`, flow
  lanes, alerts). That returns `overview` on Bitbucket URLs. Replace it with one `prNumber(url)` helper that
  handles both forms.
- `githubCached` / `checksCached` in `server.mjs` call the adapter. Point them at whichever adapter
  `SCM` selects.
- Tab label: "GitHub" in `public/index.html`.

## Phase 4: orchestration plugin variant (depends on how it differs)

The flows panel reads the plugin's files; it never calls the plugin. Check the variant against these
assumptions. If it matches, the panel works unchanged. If not, the changes stay in the files listed.

| Assumption | Where it's read |
|---|---|
| Run folders at `<runs_root>/<EPIC>/<TICKET>/` with `STAGE`, `REVIEW_STAGE`, `PR`, `BLOCKED` | `lib/runs.mjs` |
| Artifacts named `KICKOFF.md`, `PLAN.md`, `REPORT.md`, `REDIRECT.md`, `REVIEW_KICKOFF.md`, `REVIEW_REPORT.md` | `lib/runs.mjs` `ARTIFACTS` |
| `fleet.tsv`, `herdr-workspace` and `.watch-state/*` in each epic folder | `lib/runs.mjs` |
| `paths.runs_root` in each repo's `.claude/workflow.local.json`; the global one in `~/.claude/settings.json` → `pluginConfigs["orchestration@…"].options` | `lib/runs.mjs` `runLocations()` |
| Ticket ids match `[A-Z]+-\d+`; worktrees are named `wt-<TICKET>` | `lib/runs.mjs`, `lib/sessions.mjs` |
| The orchestrator is started with `/…orchestrate-work <EPIC>` and watches with `workspace-dispatch.sh watch --epic <EPIC>` | `lib/orchestrators.mjs` |
| Plan-gate dialog screen format | `lib/attention.mjs` `parseDialog`, fixture `test/fixtures/screens/plan-gate.txt` |

A quick way to check: point `RUNS_DIR` at a run folder the variant has produced and open the flows panel.
Then capture one real plan-gate screen into a fixture and run `npm test`.

## Platform assumptions (Windows)

These parts are Windows-only. A non-Windows machine would need replacements:

- `lib/raise-window.py`: brings a VS Code window to the front.
- `lib/proc-stats.py`: per-process CPU.
- `typeperf` and `tasklist` in `lib/resources.mjs`.
- `scripts/launch.sh`: the desktop launcher (Git Bash + Chrome app window).

## Kept in sync

| Change | Date |
|---|---|
| Initial checklist (through the Docker panel, `ce56356`) | 2026-11-01 |
