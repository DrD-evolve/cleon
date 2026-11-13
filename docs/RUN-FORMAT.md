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
      LAUNCH_implement         optional: what the worker pane was launched with (model, effort)
      LAUNCH_review            optional: the same for the self-review pane
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

### Sub-steps and artifact times

Each ticket in `/api/runs` also carries `fileTimes`, the last-modified time (ms) of each artifact in its `files`
(one `stat` per artifact, no file opened; a name that isn't an artifact, or a file gone before its `stat`, has no
entry), and `subSteps`, a list of
`{ n, state }` for the adapter's sub-steps, `state` being `seen` (its signal was found), `inferred` (passed, but
nothing shows it), `current` or `todo`. The payload's own `subSteps` list (beside `flow` and `stepFiles`) describes
the steps. A ticket from a peer on an older Cleon, or from an adapter with no `deriveSubSteps`, has no `subSteps`
and is drawn as before. A step's state is worked out again after the PR checks, so a merged ticket reads done. A
peer's ticket that has `subSteps` gets them worked out again here, by this machine's adapter, so they match the
payload's list; its `fileTimes` stay the peer's.

### Tickets with no PR file

Work run by hand may write no `PR`. For those tickets, Cleon lists each configured repo's recent PRs on the
source-control host and takes the ones **you** wrote whose branch names the ticket (`branchTicket`). The ticket
is done once one has merged and none is open, unless it's in a live pane at a stage before the report, where
the worker may be on its next PR.

A ticket with no run folder at all, only `<runs dir>/<reviewDir>/<TICKET>/`, appears in Process and Usage when
it has PRs of yours, and never in the flows. Its stages have no files, so Process marks it approximate.

### Where Cleon looks for runs

- `MC_RUNS_DIR` and `MC_PLANS_DIR` in `.env`.
- The tool's global options in `~/.claude/settings.json`, under a `pluginConfigs` key starting with
  `settingsKey`, read by `locations()`.
- Each repo's own config file (`repoConfig`, relative to the repo), also read by `locations()`.

Each machine reads only its own run folders. Another machine's runs come from its own Cleon (`MC_PEERS`), so the
layout above doesn't change. Epic, ticket, herdr workspace and pane ids are per machine. A ticket can sit on both
machines, for example an epic started on one and resumed on the other, and herdr ids repeat on every machine. So
Cleon keys a peer's rows by `<machine>|<id>`, and a ticket merged on either machine counts as done on both.

## Adapter fields

An adapter is an ES module whose default export has these fields:

| Field | What it is |
|---|---|
| `settingsKey` | Prefix of the tool's key under `pluginConfigs` in `~/.claude/settings.json` |
| `repoConfig` | Path, inside each repo, of the tool's per-repo config |
| `locations(cfg)` | Returns `{ runs, plans }` dirs from one config object (null where unset) |
| `idPattern` | Regex that epic and ticket folder names match |
| `files` | Names of `stage`, `reviewStage`, `pr`, `blocked`, `fleet`, `workspace`, `watchDir` and (optional) `permissionMode` |
| `files.launch` | Names of the optional launch records in a ticket folder (`['LAUNCH_implement', 'LAUNCH_review']`) |
| `artifacts` | The markdown files Cleon may show. Nothing else in a ticket folder is ever read. |
| `stepFiles` | For each flow step, which artifacts a ticket tile offers (`'plan'` is the plans-dir plan) |
| `planFile(ticket)` | The plan's file name in the plans dir |
| `deriveStep({ stage, reviewStage, prState, files })` | Returns `{ step, held?, failed?, fixRound? }`. `step` is one of `queued`, `planning`, `plan-gate`, `implementing`, `self-review`, `human-review`, `done`. |
| `subSteps` | Optional. The steps of a ticket's run, in order: `{ n, id, label, node, who, what, signal }`. `node` is a flow step id; `who` is `Orchestrator`, `Worker`, `Reviewer` or `You`; `signal` is what shows the step happened: `file` (a run file), `transcript` (the worker's transcript) or `none`. The default adapter has 16 |
| `deriveSubSteps({ step, held, failed, fixRound, stage, reviewStage, prState, pr, files })` | Optional: without it tickets carry no `subSteps`. Returns `[{ n, state }]`, one per sub-step, `state` one of `seen`, `inferred`, `current`, `todo`. A step is present when its signal shows (a `transcript` or `none` step never is). **Current step:** the last step of the ticket's node (`step`) whose signal is present; if none, the node's first step with a `file` signal; at `done` there is no current step, every step is `seen` if present else `inferred`, and step 16 is `seen`. Before the current step, a step is `seen` if present, else `inferred`; after it, `todo`, except in a fix round (`step` is `implementing` and `reviewStage` is set, `failed` or not), where steps 9 to 13 keep `seen` or `inferred` up to the last of them present (all five once the review is done) |
| `roleOfStep(step)` | The roles whose model and effort a flow step shows (`planner`, `implementer`, `reviewer`; `[]` for a step no role runs: `queued`, `human-review`, `done` in the default). Used by the step detail |
| `actorOf({ role, sub })` | The role a session worked as, from the Usage panel's attribution (`role`: `implementer` or `reviewer`; `sub`: a subagent of another session), or null |
| `roleConfig(cfg)` | `{ role: { model, effort } }` from one repo config's `agents` keys (unset values are null). The default adapter reads `agents.<role>.model` and `.effort`, and reads `agents.orchestrator.effort` as the planner's effort (its `orchestrator.model` is ignored, as the plugin does), and gives the reviewer the planner's values when `agents.reviewer.executor` is `codex` (the Claude review session runs on them) |
| `launchOf(text)` | One launch record → `{ role, model, effort }` (`-` and `unset` are null), or null. The default format is one line, `role=planner mode=pane model=<m> effort=<e> model_source=… effort_source=…` |
| `configured(cfg, launches)` | Each role's configured values: its launch record when there is one (a launch flag beats config; a `-` there stays null, as the pane started on the CLI's own value), else `roleConfig`, else null |
| `replyHint`, `replyOf(record)` | A cheap substring a transcript line must contain, and one transcript record → `{ model, effort, at }` for a reply the model wrote, else null. The default reads `type: "assistant"` records: `message.model`, and `effort` (or `perTurnEffort`) on the record itself; a reply without one has effort null |
| `gateAnswerOf(record, asked)` | When a plan-gate question (`gateHeader`) was answered, from one transcript record, else null; `asked` keeps the gate questions' tool ids per transcript |
| `boundaryOf(spans, gates)`, `stepWindow(step, role, boundary)` | Where the worker session passes from planning to implementing: its last plan-gate answer, else the first reply of one of its subagents, else none (no split). The step detail shows the worker's replies before it for planning and plan gate, and the worker's and its subagents' replies after it for implementing; the reviewer belongs to its step by role |
| `timeline` | For the Process panel: the artifacts whose last-modified times end the `kickoff`, `plan`, `report` and `review` stages |
| `branchTicket(branch)` | The ticket id a branch name carries, or null. Matched on exact boundaries, so `ACME-12` isn't in `ACME-123` |
| `reviewDir`, `reviewReport` | Where self-reviews run on their own are kept: `<runs dir>/<reviewDir>/<TICKET>/<reviewReport>`. Its modified time ends the review stage when the ticket folder has none. `reviewDir: null` if your tool has no such folder |
| `gateHeader` | The header of the plan-gate question dialog in Claude Code (`AskUserQuestion`) |
| `epicCommand` | Regex run on your prompts to spot an orchestrator session; group 1 is the epic |
| `epicWatch` | Regex run on that session's shell commands, for the same purpose |
| `reviewerPrompt` | For the Usage panel: regex run on the opening prompt of a session in a ticket's worktree; a match makes it the ticket's reviewer, anything else its implementer |
| `workerPrompt` | For the Usage panel: regex run on the opening prompt of a session outside any worktree; a match makes it a worker on the first ticket id in that prompt (its reviewer when `reviewerPrompt` matches too) |
| `resumeCommand(epic, mode)` | The shell command that restarts a dead orchestrator for `epic` (the flows panel's "restart in herdr"). `mode` is the newest valid `files.permissionMode` record among the epic's tickets, or null. It runs in the herdr session of the epic's repo (the repo with a `repoConfig` whose `git worktree list` has a worktree whose folder or branch carries the epic's or a ticket's id), as an `orchestrator` tab in the workspace `files.workspace` records when one with that id and label is live there, else in a new workspace |

`test/run-format.test.mjs` builds a run from this document alone and checks that Cleon reads it.
