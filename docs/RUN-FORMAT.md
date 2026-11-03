# Run format: driving Cleon from your orchestration tool

Cleon's **Orchestration flows** and **Process** panels show tickets that agents are working through:
planning, a plan gate you approve, implementing, self-review, then your review and merge. Cleon doesn't
run any of this. It reads files that your orchestration tool writes. Every assumption about those
files lives in one adapter module. The default one, `lib/adapters/orchestration-plugin.mjs`, matches
the orchestration plugin this was built with.

There are two ways to use another tool:

1. **Write this layout.** Have your tool write the files below, and Cleon needs no changes.
2. **Write an adapter.** Copy `lib/adapters/orchestration-plugin.mjs`, change the fields that differ,
   and set `MC_ORCH_ADAPTER=path/to/your-adapter.mjs` in `.env`. Every field is described below.

The other panels (Sessions, Herdr, Knowledge, Linear, GitHub, Repos, Resources, Docker) don't depend
on this at all.

## The layout

```
<runs dir>/
  <EPIC>/                      an epic id, e.g. ACME-100 (matches idPattern)
    fleet.tsv                  optional: which terminal panes work on which ticket (herdr only)
    herdr-workspace            optional: "<workspace id>\t<label>" (herdr only)
    .watch-state/
      <TICKET>.pr              optional: OPEN | MERGED | CLOSED, written by a merge watcher
    <TICKET>/                  a ticket id, e.g. ACME-101
      STAGE                    one word: the implementation stage (see below)
      REVIEW_STAGE             one word: the self-review stage, once it starts
      PR                       the pull request's URL, once opened
      BLOCKED                  why the worker stopped, when STAGE is "blocked"
      KICKOFF.md               the brief the worker was given
      PLAN.md                  its plan
      REPORT.md                what it did
      REDIRECT.md              course corrections you sent it
      REVIEW_KICKOFF.md        the self-review brief
      REVIEW_REPORT.md         the self-review's findings
      ORCHESTRATOR_PERMISSION_MODE  optional: the orchestrator's --permission-mode when it dispatched
<plans dir>/
  <TICKET>-plan.md             the plan shown at the plan gate
```

Only the ticket folder and `STAGE` are needed. Everything else adds detail when it's there: a PR link
and merge state, artifacts you can open from a ticket, and process timings.

### Stage words

`STAGE` and `REVIEW_STAGE` hold one word each. The default adapter maps them onto Cleon's flow:

| Cleon step | Shown when |
|---|---|
| Queued | `STAGE` is missing or unknown |
| Planning | `STAGE=planning` |
| Plan gate (you) | `STAGE=plan-gate` |
| Implementing | `STAGE=implementing` (with `REVIEW_STAGE` set, it's a fix round after review) |
| Self-review | `STAGE=report-done`, or `REVIEW_STAGE=review-running` |
| Review · merge (you) | `REVIEW_STAGE=review-done` |
| Done | the PR merged (from `.watch-state/<TICKET>.pr`, or checked on GitHub) |

`STAGE=blocked` holds the ticket before the first step whose artifact is missing (`PLAN.md`,
`REPORT.md`, `REVIEW_REPORT.md`). `STAGE=failed` and `REVIEW_STAGE=review-failed` mark it failed.

A ticket with a `PR` that isn't marked merged is checked against GitHub (`gh pr view`). Merge watchers
die, and this keeps finished tickets from looking stuck.

### Where Cleon looks for runs

- `MC_RUNS_DIR` and `MC_PLANS_DIR` in `.env`.
- The tool's global options in `~/.claude/settings.json`, under a `pluginConfigs` key starting with
  `settingsKey`, read by `locations()`.
- Each repo's own config file (`repoConfig`, relative to the repo), also read by `locations()`.

## Adapter fields

An adapter is an ES module whose default export has these fields:

| Field | What it is |
|---|---|
| `settingsKey` | Prefix of the tool's key under `pluginConfigs` in `~/.claude/settings.json` |
| `repoConfig` | Path, inside each repo, of the tool's per-repo config |
| `locations(cfg)` | Returns `{ runs, plans }` dirs from one config object (null where unset) |
| `idPattern` | Regex that epic and ticket folder names match |
| `files` | Names of `stage`, `reviewStage`, `pr`, `blocked`, `fleet`, `workspace`, `watchDir` and (optional) `permissionMode` |
| `artifacts` | The markdown files Cleon may show. Nothing else in a ticket folder is ever read. |
| `stepFiles` | For each flow step, which artifacts a ticket tile offers (`'plan'` is the plans-dir plan) |
| `planFile(ticket)` | The plan's file name in the plans dir |
| `deriveStep({ stage, reviewStage, prState, files })` | Returns `{ step, held?, failed?, fixRound? }`. `step` is one of `queued`, `planning`, `plan-gate`, `implementing`, `self-review`, `human-review`, `done`. |
| `timeline` | For the Process panel: the artifacts whose last-modified times end the `kickoff`, `plan`, `report` and `review` stages |
| `gateHeader` | The header of the plan-gate question dialog in Claude Code (`AskUserQuestion`) |
| `epicCommand` | Regex run on your prompts to spot an orchestrator session; group 1 is the epic |
| `epicWatch` | Regex run on that session's shell commands, for the same purpose |
| `resumeCommand(epic, mode)` | The shell command that restarts a dead orchestrator for `epic` (the flows panel's "restart in herdr"). `mode` is the newest valid `files.permissionMode` record among the epic's tickets, or null. It runs in the herdr session of the epic's repo (the repo with a `repoConfig` whose `git worktree list` has a worktree whose folder or branch carries the epic's or a ticket's id), as an `orchestrator` tab in the workspace `files.workspace` records when one with that id and label is live there, else in a new workspace |

`test/run-format.test.mjs` builds a run from this document alone and checks that Cleon reads it.
