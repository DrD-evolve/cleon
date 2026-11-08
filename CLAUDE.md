# Cleon

Local-only Node dashboard (see `README.md`). Run tests with `npm test`; check UI changes in the browser.

## Keep `docs/PORTING.md` current

`docs/PORTING.md` is the checklist for standing up a copy elsewhere (e.g. a machine with Bitbucket
Server and no Ollama). Update it **in the same commit** when a change:

- adds a data source, CLI dependency or environment variable,
- adds or moves a hardcoded path, folder name or personal name,
- changes the GitHub adapter's contract (`lib/github.mjs` shapes) or adds a place that parses PR URLs,
- relies on something new from the orchestration plugin's run files or commands,
- adds a Windows-only piece.

Add a row to its "Kept in sync" table, with the date and commit.

## Testing changes

- The user's own server (port 4317, started from the desktop shortcut) is theirs: never stop or restart it.
  Test on a second server with `MC_PORT=4318 node server.mjs`, and tell them when theirs needs a restart
  (anything outside `public/` changed).
- In a ticket worktree, run `npm ci` first (a new worktree has no `node_modules`). Use a port of your own,
  4400 plus the ticket number's last two digits, because several workers can test at once.
- Check UI changes in the browser with real clicks; tests can't catch layout or clicks that miss.
- To test without real state, wrap `window.fetch` in the page and swap in the state you need. For dialog
  or merge tests, use a throwaway run folder and a stub Claude session in a temporary herdr workspace,
  and remove both afterwards.
- Tests must not depend on `.env` (CI has none).
- Anything that reads Usage (the Usage panel, the Exec view, `/api/usage`, `/api/usage-input`, `/api/exec`) runs
  from a ticket worktree or a scratch copy of the working tree, never from the main clone. A 4318 server in the
  main clone shares `data/usage-ledger.json` with 4317, and two writers can corrupt it; a worktree has its own
  `data/`. Load `.env` into the test server's environment rather than copying the file.
- Anything that starts a herdr session (Ingest, Make a ticket, open in herdr) runs against a throwaway project root
  (`MC_ROOT`, `MC_CATEGORIES`) with `MC_HEADLESS=1`, so no window opens. A stand-in `claude` on `PATH` does not
  win over the real one in a herdr pane. Afterwards, `herdr session stop` and `herdr session delete` the test session.
- Real Inbox scans cost money and read real mail. Use seeded `data/*-<port>.json` state for UI checks, and remove
  it afterwards.

## Commits and PRs

The repo is public.

- Commit messages, code, tests and docs carry no tracker ids and no company or client names (use `ACME-` in
  tests).
- Branch names, PR titles and bodies, and PR comments may carry a bare tracker id (`ABC-123`). They never carry
  a tracker URL (it names the workspace), a company name or a client name.
- Every change goes through a ticket branch in its own worktree and a PR against `master`. Nothing is committed
  on `master` directly; the orchestration plugin's branch guard enforces this. Its config,
  `.claude/workflow.local.json`, is machine-local and gitignored.
- The owner merges a PR by fast-forwarding the main clone: `git merge --ff-only origin/<branch>`, then
  `git push`. Never use GitHub's merge button: a merge commit carries the branch name and the merging account.
  If `master` has moved on, rebase the branch onto it and push the branch with `--force-with-lease`. Never
  force-push `master`.
- If a push is rejected, fetch and compare before anything else: history may have been rewritten upstream.
  Rebase your new commits onto it.
