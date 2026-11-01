# Mission Control

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
