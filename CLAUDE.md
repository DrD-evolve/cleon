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
- Check UI changes in the browser with real clicks; tests can't catch layout or clicks that miss.
- To test without real state, wrap `window.fetch` in the page and swap in the state you need. For dialog
  or merge tests, use a throwaway run folder and a stub Claude session in a temporary herdr workspace,
  and remove both afterwards.
- Tests must not depend on `.env` (CI has none).
