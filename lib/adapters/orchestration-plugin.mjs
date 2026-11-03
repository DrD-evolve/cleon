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

  // Process metrics: each stage ends when this artifact was last written.
  timeline: { kickoff: 'KICKOFF.md', plan: 'PLAN.md', report: 'REPORT.md', review: 'REVIEW_REPORT.md' },

  // Transcripts. A plan gate is a question dialog with this header; an orchestrator session is found by
  // the epic in the command it was given or in the watcher it armed.
  gateHeader: 'Plan gate',
  // Matched against your prompts; the first group is the epic.
  epicCommand: /<command-name>\/?[\w:-]*orchestrate-work<\/command-name>\s*<command-args>\s*([A-Z]+-\d+)/,
  // Matched against the session's shell commands; the first group is the epic.
  epicWatch: /workspace-dispatch\.sh"?\s+watch\s+--epic\s+([A-Z]+-\d+)/,

  // The shell command that restarts an epic's orchestrator after its session died. Run on an epic that
  // already has a progress comment, orchestrate-work enters reconstruction mode: it rebuilds the epic
  // from Linear, the PRs and the worktrees, re-arms its watcher and re-dispatches dead workers. `mode`
  // (a --permission-mode choice, or null) is the mode the last orchestrator ran in.
  resumeCommand: (epic, mode) => `claude${mode ? ` --permission-mode ${mode}` : ''} "/orchestration:orchestrate-work ${epic}"`,
};
