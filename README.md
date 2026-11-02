# Cleon

(Named for Cleon: the Warriors' leader in *The Warriors*, and the Galactic Emperor in *Foundation*.)

A local-only dashboard for everything running on this machine: Claude Code sessions, Herdr workspaces,
orchestration flows, project repos and the knowledge base. It runs on `127.0.0.1` and makes no cloud calls.

```bash
cp .env.example .env   # then fill in: paths, privacy exclusions, Linear key
npm install
npm start          # http://127.0.0.1:4317  (MC_HOST / MC_PORT to override)
npm test
```

Machine-specific settings (repo root and categories, runs and plans folders, the Obsidian vault, privacy
exclusions, the Docker disk path) live in `.env`. `.env.example` documents each one, and `lib/config.mjs`
reads them. To stand up a copy elsewhere, see `docs/PORTING.md`. The orchestration panels read run files
through one adapter; to drive them from another tool, see `docs/RUN-FORMAT.md`.

**Desktop launcher:** `scripts/launch.sh` starts the server unless it's already running, then opens the
dashboard in its own Chrome app window. The "Cleon" desktop shortcut runs it in a minimized
Git Bash window. That window is the server, so closing it stops the dashboard.

**Icon:** an all-seeing eye. `python -I scripts/make-icon.py` regenerates the shortcut icon
(`assets/mission-control-radar.ico`) and the page icon (`public/icon-192.png`). The window icon is redrawn
live. Normally the eye is cyan; when something is waiting on you, it turns magenta and pings.

## Panels and data sources

| Panel | Source | Refresh |
|---|---|---|
| Sessions | `~/.claude/sessions/*.json`, with the pid checked so dead sessions are shown dimmed | 5 s |
| Herdr | `herdr api snapshot`; shows "offline" when the herdr server isn't running | 5 s |
| Orchestration flows | Each runs root the plugin config names (plus `MC_RUNS_DIR`): `<root>/<EPIC>/` (`fleet.tsv`, `STAGE`, `REVIEW_STAGE`, `.watch-state/*.pr`), and the plans folder | 5 s |
| Projects | Every repo under `<MC_ROOT>/<category>/`, categories from `MC_CATEGORIES`, read through `git` | 60 s |
| Linear | GraphQL API, issues assigned to you that aren't completed or canceled. Needs `LINEAR_API_KEY` in `.env`. | 60 s, cached server-side |
| GitHub | `gh search` for your open PRs, PRs waiting on your review and assigned issues, plus `gh pr view` for CI and review state | 60 s, cached server-side |
| Knowledge map | Obsidian vault `MC_VAULT` (including its `projects/` junctions), `~/.claude/projects/*/memory`, and each project's `CLAUDE.md` | on load and on ⟳ |

Flow steps are the orchestrate-work lifecycle collapsed to the steps the files can show:
queued → planning → plan gate ◆ → implementing → self-review → review·merge ◆ → done.
A ◆ marks a step that waits on you. An implementer working again after review shows as **Fix round**.
A ticket with no live pane that hasn't merged is marked inactive; tick "show inactive" to see those.
A ticket that merged in any run counts as done in every run, so a stale copy left at an earlier step
in an old run doesn't show up as waiting on you.

The current step pulses (expanding rings and a breathing glow), and a particle travels along the edge
leading into it. Gates that wait on you are diamonds and pulse magenta. The two feedback loops are
drawn as arcs: "redirect" from the plan gate back to planning, and "changes requested" from review back
to implementing. That second arc animates when the implementer is on a fix round.

Clicking a flow step opens that step's artifacts (plan, kickoff, report, review). Clicking a graph node,
or pressing Enter in the search box, opens the file as a draggable tile.

## Privacy

- **Excluded:** any path matching the `MC_EXCLUDE` regex in `.env` never enters the graph, can't be opened
  as a tile, and isn't read for session dialogs. If it's unset, nothing is excluded and the server warns at startup.
- **What can be read:** `/api/file` serves only file ids from the current graph index, never a path.
  `/api/run-file` serves only the named orchestration artifacts. Raw HTML inside notes is shown as text.
- **Secrets:** the Linear key is read from `.env` (gitignored) and sent only to `api.linear.app`. GitHub goes
  through `gh`'s own stored login, so this app never touches that token.
- **Network:** the server binds to loopback. Exposing it over Tailscale (`MC_HOST`) would expose your
  notes to the tailnet, and nothing here does authentication.

## Testing

`node --test` with no extra dependencies:

- Adapters are tested against fixtures in `test/fixtures`. The pure functions are tested directly:
  `deriveStep`, `parseFleet`, link parsing and the exclusion pattern.
- Server tests cover the read guards: unknown file ids and path traversal must return 404.
- The UI is checked by hand in the browser for this POC.

## Roadmap

1. ✅ POC: sessions, herdr, knowledge graph, file tiles
2. ✅ Orchestration flow charts
3. ✅ Linear and GitHub panels
4. ⬜ Email panel: threads that need action (source still to be decided: Gmail MCP Server project or the Gmail API)
