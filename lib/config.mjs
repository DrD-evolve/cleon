// Machine-specific settings, read from .env (gitignored; see .env.example). Loaded here rather than in
// server.mjs because ES imports run before the importing module's own code, so every lib module that
// reads a setting gets it from here. Defaults are generic; this machine's values live in .env.
import { join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
try { process.loadEnvFile(ENV_FILE); } catch { /* no .env: defaults */ }
// Every name .env sets (tokens among them), which windows the project map opens mustn't inherit, even
// when the server's own environment already had it (say, started from a shell Cleon opened earlier).
export const ENV_FILE_KEYS = (() => { try { return Object.keys(parseEnv(readFileSync(ENV_FILE, 'utf8'))); } catch { return []; } })();

const env = k => process.env[k]?.trim() || null;
const list = v => v ? v.split(',').map(s => s.trim()).filter(Boolean) : null;

// Pure: a case-insensitive pattern from the setting; unset matches nothing.
export const excludePattern = src => src ? new RegExp(src, 'i') : /(?!)/;

// Repos live one level down, in category folders: <ROOT>/<category>/<repo>.
export const ROOT = env('MC_ROOT') ?? join(os.homedir(), 'dev');
// Unset: every folder under ROOT is a category.
export const CATEGORIES = list(env('MC_CATEGORIES'));
// Orchestration runs/plans when no plugin config names any (each repo's paths.runs_root is still read).
export const RUNS_DIR = env('MC_RUNS_DIR');
export const PLANS_DIR = env('MC_PLANS_DIR');
// What Cleon assumes about the orchestration tool's files (see docs/RUN-FORMAT.md); unset uses the
// orchestration plugin's, in lib/adapters/orchestration-plugin.mjs.
export const ORCH_ADAPTER = env('MC_ORCH_ADAPTER');
// Source control: "bitbucket" reads Bitbucket Server / Data Center's REST API (BITBUCKET_URL, plus a
// read-only BITBUCKET_TOKEN); unset uses GitHub through the gh CLI.
export const SCM = env('MC_SCM')?.toLowerCase() ?? 'github';
export const BITBUCKET_URL = env('BITBUCKET_URL');
export const BITBUCKET_TOKEN = env('BITBUCKET_TOKEN');
// Obsidian vault: its Markdown pages are belt items on the knowledge map, orbiting the projects they name or that link
// to them (lib/belts.mjs). Unset: no vault pages.
export const VAULT = env('MC_VAULT');
// The knowledge match (lib/belt-match.mjs): "1" sends belt items the free first pass leaves unmatched (vault pages and
// stray memory notes) to Haiku through a headless claude run with no tools. Off by default: it sends their text to
// Anthropic and spends money.
export const MATCH_ON = env('MC_KNOWLEDGE_MATCH') === '1';
// Knowledge map: the folders (any depth, any case) that hold each project's docs, comms and outputs, as
// `docs=docs,adrs,decisions;comms=communications,meetings,transcripts;outputs=output,outputs,reports` (the defaults).
// A group named here gets exactly that list; the others keep theirs. Parsed by lib/knowledge.mjs.
export const KNOWLEDGE_FOLDERS_SRC = env('MC_KNOWLEDGE_FOLDERS');
// Privacy: paths matching this never enter the knowledge map, file tiles, or session dialog reads.
export const EXCLUDE_SRC = env('MC_EXCLUDE');
export const EXCLUDE = excludePattern(EXCLUDE_SRC);
// Knowledge panel's project buttons: the Git for Windows install, whose mintty opens "open in bash".
export const GIT_DIR = env('MC_GIT_DIR') ?? 'C:/Program Files/Git';
// Other machines' Cleons whose rows this one shows beside its own: `name=http://127.0.0.1:<port>`, comma-
// separated, each reached over loopback (an SSH local forward). Unset: this machine only. See lib/peers.mjs.
export const PEERS_SRC = env('MC_PEERS');
// "1" on a machine nobody sits at (a worker reached over RDP or a tunnel): never raise or attach windows,
// since they'd open on a desktop no one is looking at. herdr panes are still focused.
export const HEADLESS = env('MC_HEADLESS') === '1';
// The Inbox scan (lib/scan.mjs): "1" turns on a scheduled, read-only headless Claude run over this account's
// Microsoft 365 calendar, through the claude.ai Microsoft 365 connector. Off by default: it reads mail-side data
// and spends money. Hours are local, comma-separated; the budget caps each run (claude --max-budget-usd).
export const SCAN_ON = env('MC_SCAN') === '1';
export const SCAN_HOURS_SRC = env('MC_SCAN_HOURS');
export const SCAN_MODEL = env('MC_SCAN_MODEL') ?? 'haiku';
export const SCAN_BUDGET = Number(env('MC_SCAN_BUDGET') ?? 1);
// Docker Desktop's disk file (WSL2 default location).
export const DOCKER_DISK = env('MC_DOCKER_DISK') ?? join(process.env.LOCALAPPDATA ?? '', 'Docker', 'wsl', 'disk', 'docker_data.vhdx');
