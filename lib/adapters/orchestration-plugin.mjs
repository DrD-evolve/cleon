// Adapter for the orchestration plugin (orchestrate-work in herdr/cmux mode). Everything Cleon assumes
// about that plugin's run files, config and transcripts lives here; the rest of Cleon only reads these
// fields. To drive Cleon from another tool, copy this file, change what differs, and point
// MC_ORCH_ADAPTER at the copy. docs/RUN-FORMAT.md describes each field.
//
// Run layout: <runs>/<EPIC>/{fleet.tsv, herdr-workspace, .watch-state/*, <TICKET>/{STAGE, REVIEW_STAGE, PR, *.md}}

// Lifecycle from skills/orchestrate-work/SKILL.md, collapsed to what the files can show.
// A worker that can't proceed writes STAGE=blocked, so where it stopped is read from its artifacts:
// it's held before the first step whose output is missing.
const HELD_BEFORE = [['PLAN.md', 'planning'], ['REPORT.md', 'implementing'], ['REVIEW_REPORT.md', 'self-review']];

// Pure: { role: { model, effort } } from one config's `agents` (see `roleConfig` below).
function roleConfigOf(cfg) {
  const a = cfg?.agents ?? {}, str = v => (typeof v === 'string' && v ? v : null);
  const planner = { model: str(a.planner?.model), effort: str(a.planner?.effort) ?? str(a.orchestrator?.effort) };
  return {
    planner,
    implementer: { model: str(a.implementer?.model), effort: str(a.implementer?.effort) },
    // With a Codex reviewer the Claude review session runs on the planner's values; the reviewer's model goes to Codex.
    reviewer: a.reviewer?.executor === 'codex' ? { ...planner } : { model: str(a.reviewer?.model), effort: str(a.reviewer?.effort) },
  };
}
const GATE_HEADER = 'Plan gate';

// The 16 steps of a ticket's run, each on a flow node. `signal` is what shows a step happened: a run file,
// the worker's transcript (read later), or nothing.
const SUB_STEPS = [
  [1, 'read-epic', 'Read the epic', 'queued', 'Orchestrator', 'The orchestrator reads the epic and its tickets.', 'file'],
  [2, 'dispatch', 'Dispatch', 'queued', 'Orchestrator', 'The orchestrator starts a worker with the ticket brief.', 'file'],
  [3, 'set-up', 'Set up', 'planning', 'Worker', 'The worker sets up its workspace and starts planning.', 'file'],
  [4, 'write-plan', 'Write the plan', 'planning', 'Worker', 'The worker writes the plan.', 'file'],
  [5, 'plan-gate', 'Plan gate', 'plan-gate', 'You', 'You approve, revise or stop the plan.', 'file'],
  [6, 'write-code', 'Write the code', 'implementing', 'Worker', 'The worker makes the change.', 'file'],
  [7, 'verify', 'Verify', 'implementing', 'Worker', 'The worker runs the checks.', 'transcript'],
  [8, 'ship', 'Ship', 'implementing', 'Worker', 'The worker pushes the branch and opens a pull request.', 'file'],
  [9, 'start-review', 'Start the review', 'self-review', 'Reviewer', 'The review starts in a fresh session.', 'file'],
  [10, 'find-defects', 'Find defects', 'self-review', 'Reviewer', 'The reviewer looks for defects in the change.', 'file'],
  [11, 'attack-claims', 'Attack each claim', 'self-review', 'Reviewer', 'The reviewer tests each claim the report makes.', 'transcript'],
  [12, 'fix-regate', 'Fix and re-gate', 'self-review', 'Reviewer', 'Defects found are fixed and checked again.', 'transcript'],
  [13, 'audit-comment', 'Audit comment', 'self-review', 'Reviewer', 'The reviewer writes its findings up.', 'file'],
  [14, 'verdict', 'Verdict relay', 'human-review', 'Reviewer', "The review's verdict is relayed on the pull request.", 'none'],
  [15, 'human-review', 'Human review and merge', 'human-review', 'You', 'You review the pull request and merge it.', 'file'],
  [16, 'close-out', 'Close out', 'done', 'Orchestrator', 'The orchestrator closes the ticket out.', 'file'],
].map(([n, id, label, node, who, what, signal]) => ({ n, id, label, node, who, what, signal }));
const [PLAN, REPORT, REVIEW_REPORT] = HELD_BEFORE.map(([f]) => f);

export default {
  // Where runs and plans live. The plugin's global options sit in ~/.claude/settings.json under a
  // pluginConfigs key starting with this; each repo may override them in its own config file.
  settingsKey: 'orchestration@',
  repoConfig: '.claude/workflow.local.json',
  // Pure: runs/plans dirs from one config — runs_root, else <worktrees_root>/.orchestrate-runs. Accepts
  // the repo file's nested `paths` object or the global option's flat `paths_*` keys.
  locations(cfg = {}) {
    const get = k => cfg.paths?.[k] ?? cfg[`paths_${k}`];
    const wt = get('worktrees_root');
    return { runs: get('runs_root') ?? (wt ? `${wt}/.orchestrate-runs` : null), plans: get('plans_dir') ?? null };
  },

  // Epic and ticket folder names.
  idPattern: /^[A-Z]+-\d+$/,

  // Per-ticket and per-run files. Stage files hold one word; PR holds the PR's URL.
  files: {
    stage: 'STAGE', reviewStage: 'REVIEW_STAGE', pr: 'PR', blocked: 'BLOCKED',
    fleet: 'fleet.tsv', workspace: 'herdr-workspace', watchDir: '.watch-state',
    // Per ticket: what each pane was launched with (model and effort), written when the pane started.
    launch: ['LAUNCH_implement', 'LAUNCH_review'],
    // Per ticket: the orchestrator's permission mode when it dispatched, in the CLI's spelling.
    permissionMode: 'ORCHESTRATOR_PERMISSION_MODE',
  },
  // Markdown files the dashboard may show. Only these names are ever read.
  artifacts: ['KICKOFF.md', 'PLAN.md', 'REPORT.md', 'REDIRECT.md', 'REVIEW_KICKOFF.md', 'REVIEW_REPORT.md'],
  // Which of them a ticket tile offers at each flow step ('plan' is the ticket's plan in the plans dir).
  stepFiles: {
    planning: ['plan', 'PLAN.md'], 'plan-gate': ['plan', 'PLAN.md'], implementing: ['KICKOFF.md', 'REDIRECT.md', 'REPORT.md'],
    'self-review': ['REVIEW_KICKOFF.md', 'REVIEW_REPORT.md'], 'human-review': ['REVIEW_REPORT.md'], done: ['REPORT.md'],
  },
  // The ticket's plan, in the plans dir.
  planFile: ticket => `${ticket}-plan.md`,

  // Pure: map the raw stage words to a dashboard flow step (queued, planning, plan-gate, implementing,
  // self-review, human-review, done), plus held / failed / fixRound flags.
  deriveStep({ stage, reviewStage, prState, files = [] }) {
    if (prState === 'MERGED') return { step: 'done' };
    if (stage === 'blocked') return { step: HELD_BEFORE.find(([f]) => !files.includes(f))?.[1] ?? 'human-review', held: true };
    if (stage === 'failed' || reviewStage === 'review-failed') return { step: stage === 'failed' ? 'implementing' : 'self-review', failed: true };
    if (['queued', 'planning', 'plan-gate', 'implementing'].includes(stage)) {
      return { step: stage, fixRound: stage === 'implementing' && Boolean(reviewStage) };
    }
    if (reviewStage === 'review-done') return { step: 'human-review' };
    if (stage === 'report-done' || reviewStage === 'review-running') return { step: 'self-review' };
    return { step: ['done', 'human-review', 'self-review'].includes(stage) ? stage : 'queued' };
  },

  // The 16 sub-steps, in order. docs/RUN-FORMAT.md describes each field.
  subSteps: SUB_STEPS,
  // Pure: each sub-step's state, [{ n, state }] (seen, inferred, current, todo), from deriveStep's result plus the
  // raw stage words, the PR and the artifacts present. A step is present when its signal shows; transcript and
  // none steps never are, so they read inferred. Current: the last step of the ticket's node that is present, else
  // the node's first file-signal step; at done there is none. Before current: seen if present, else inferred; after
  // it: todo, except in a fix round, where the review's steps 9-13 keep what they had.
  deriveSubSteps({ step, fixRound, stage, reviewStage, prState, pr, files = [] }) {
    const has = f => files.includes(f), reviewDone = reviewStage === 'review-done';
    const present = [
      true, has('KICKOFF.md'), stage === 'planning' && !has(PLAN), has(PLAN), stage === 'plan-gate', stage === 'implementing',
      false, Boolean(pr) && has(REPORT) && stage === 'report-done',
      has('REVIEW_KICKOFF.md'), reviewStage === 'review-running', false, false, has(REVIEW_REPORT) && reviewDone,
      false, reviewDone && Boolean(pr) && prState !== 'MERGED', prState === 'MERGED',
    ];
    const kept = k => present[k] ? 'seen' : 'inferred';
    if (step === 'done') return SUB_STEPS.map((x, k) => ({ n: x.n, state: x.n === 16 ? 'seen' : kept(k) }));
    const onNode = SUB_STEPS.filter(x => x.node === step);
    const cur = onNode.findLast(x => present[x.n - 1]) ?? onNode.find(x => x.signal === 'file');
    return SUB_STEPS.map((x, k) => ({
      n: x.n,
      state: x.n === cur?.n ? 'current' : x.n < cur?.n || (fixRound && x.n >= 9 && x.n <= 13) ? kept(k) : 'todo',
    }));
  },

  // Model and effort per step. Roles are the config's `agents.<role>` keys: the worker that plans and ships
  // (planner), the executor its edits run on (implementer, a subagent of the worker) and the self-review (reviewer).
  // Nobody runs `queued` (the worker hasn't started), `human-review` (yours) or `done`.
  roleOfStep: step => ({
    planning: ['planner'], 'plan-gate': ['planner'], implementing: ['planner', 'implementer'], 'self-review': ['reviewer'],
  })[step] ?? [],
  // Pure: which role a session worked as: `role`/`sub` as the Usage panel attributes it (lib/usage.mjs attribute).
  actorOf: ({ role, sub }) => role === 'reviewer' ? 'reviewer' : role === 'implementer' ? (sub ? 'implementer' : 'planner') : null,
  // Pure: { role: { model, effort } } from one config's `agents`. The planner was called `orchestrator`: its
  // effort is still read from there, its model is not (the plugin ignores it). A value that isn't a non-empty
  // string is unset.
  roleConfig: cfg => roleConfigOf(cfg),
  // Pure: what a pane was launched with, from a launch record in the ticket's run folder: one line
  // `role=<role> mode=… model=<m> effort=<e> model_source=… effort_source=…`, `-` or `unset` for no value.
  // Returns { role, model, effort } or null when it isn't a record.
  launchOf(text) {
    const kv = Object.fromEntries([...String(text ?? '').matchAll(/(\w+)=(\S*)/g)].map(m => [m[1], m[2]]));
    const val = v => (!v || v === '-' || v === 'unset' ? null : v);
    return kv.role ? { role: kv.role, model: val(kv.model), effort: val(kv.effort) } : null;
  },
  // Pure: each role's configured values: the launch record when there is one (what the pane actually started
  // with: a flag beats config), else the config's, else null. A `-` in the record means the pane started without
  // that flag, on the CLI's own value, so it stays unknown rather than taking the config's. `launches`: launchOf results.
  configured(cfg, launches = []) {
    const out = roleConfigOf(cfg);
    for (const l of launches) if (l && out[l.role]) out[l.role] = { model: l.model, effort: l.effort };
    return out;
  },
  // Transcript lines worth parsing for `replyOf` (a cheap test before JSON.parse).
  replyHint: '"model"',
  // Pure: one transcript record → { model, effort, at } for a reply the model wrote, else null. The effort is
  // on the reply record itself (`effort`, or `perTurnEffort`); a reply that doesn't carry one has effort null.
  replyOf(rec) {
    const model = rec?.type === 'assistant' ? rec.message?.model : null;
    if (!model || model === '<synthetic>') return null;
    const effort = [rec.effort, rec.perTurnEffort].find(v => typeof v === 'string' && v) ?? null, at = Date.parse(rec.timestamp);
    return { model, effort, at: Number.isNaN(at) ? null : at };
  },
  // Pure: when a plan-gate question was answered, from one transcript record, else null. The gate is a question
  // dialog with the gate header; its tool id goes into `asked` (kept per transcript) when it is asked, and the
  // tool result for that id is the answer.
  gateAnswerOf(rec, asked) {
    let at = null;
    for (const b of Array.isArray(rec?.message?.content) ? rec.message.content : []) {
      if (b?.type === 'tool_use' && b.name === 'AskUserQuestion' && b.input?.questions?.some(q => q?.header === GATE_HEADER)) asked.add(b.id);
      else if (b?.type === 'tool_result' && asked.has(b.tool_use_id)) at = Date.parse(rec.timestamp);
    }
    return Number.isFinite(at) ? at : null;
  },
  // Pure: the time where the worker session's own replies (the planner's) pass from planning to implementing:
  // the last plan-gate answer (a plan redirected at the gate is asked again); else the first reply of one of its
  // subagents (it may hand its edits to one); else null (no reliable boundary, so no split). Neither the plan
  // file's write time (the plan can be rewritten while implementing) nor "every edit goes to a subagent" holds.
  // `spans`: [{ actor, from }]; `gates`: the planner's gate answer times.
  boundaryOf(spans, gates = []) {
    if (gates.length) return Math.max(...gates);
    const subs = spans.filter(x => x.actor === 'implementer' && x.from != null).map(x => x.from);
    return subs.length ? Math.min(...subs) : null;
  },
  // Pure: the time span [from, to] (ms; null = open) in which a role's replies belong to a step. The worker's
  // session and its subagents span planning and implementing, so they are split at `boundary`: a subagent the
  // worker ran while planning isn't the implementer. The reviewer belongs to its step by role.
  stepWindow: (step, role, boundary = null) => boundary == null || role === 'reviewer' ? [null, null]
    : step === 'implementing' ? [boundary, null] : step === 'planning' || step === 'plan-gate' ? [null, boundary] : [null, null],

  // Process metrics: each stage ends when this artifact was last written.
  timeline: { kickoff: 'KICKOFF.md', plan: 'PLAN.md', report: 'REPORT.md', review: 'REVIEW_REPORT.md' },

  // Work run by hand (dispatch and self-review scripts called directly) writes no PR file, so a ticket's PRs
  // are also found on the source-control host, by the ticket id in the branch name, on exact boundaries:
  // ACME-12 is in "ACME-12/fix" and "feature/ACME-12-fix", never in "ACME-123".
  branchTicket: branch => branch?.match(/(?<![A-Za-z0-9])[A-Z]+-\d+(?!\d)/)?.[0] ?? null,
  // Self-reviews run on their own are kept in <runs>/<reviewDir>/<TICKET>/<reviewReport>. null: the tool has none.
  reviewDir: 'delegate',
  reviewReport: 'REVIEW_REPORT.md',

  // Transcripts. A plan gate is a question dialog with this header; an orchestrator session is found by
  // the epic in the command it was given or in the watcher it armed.
  gateHeader: GATE_HEADER,
  // Matched against your prompts; the first group is the epic.
  epicCommand: /<command-name>\/?[\w:-]*orchestrate-work<\/command-name>\s*<command-args>\s*([A-Z]+-\d+)/,
  // Matched against the session's shell commands; the first group is the epic.
  epicWatch: /workspace-dispatch\.sh"?\s+watch\s+--epic\s+([A-Z]+-\d+)/,
  // Usage panel: a session in a ticket's worktree whose opening prompt matches this is the ticket's
  // self-reviewer ("Run `/orchestration:delegate review --self`…", "GOAL: Fresh-context self-review of PR…").
  reviewerPrompt: /\/orchestration:delegate review|fresh-context (self-)?review/i,
  // A worker started before its worktree exists works from the repo's folder; its opening prompt (the worker
  // prompt, "GOAL: … (TICKET-ID) …") says which ticket it's on: the first ticket id in it.
  workerPrompt: /^GOAL:/,

  // The shell command that restarts an epic's orchestrator after its session died. Run on an epic that
  // already has a progress comment, orchestrate-work enters reconstruction mode: it rebuilds the epic
  // from Linear, the PRs and the worktrees, re-arms its watcher and re-dispatches dead workers. `mode`
  // (a --permission-mode choice, or null) is the mode the last orchestrator ran in.
  resumeCommand: (epic, mode) => `claude${mode ? ` --permission-mode ${mode}` : ''} "/orchestration:orchestrate-work ${epic}"`,
};
