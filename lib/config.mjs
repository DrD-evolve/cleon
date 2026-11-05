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
// Obsidian vault for the knowledge map; unset leaves it out.
export const VAULT = env('MC_VAULT');
// Privacy: paths matching this never enter the knowledge graph, file tiles, or session dialog reads.
export const EXCLUDE_SRC = env('MC_EXCLUDE');
export const EXCLUDE = excludePattern(EXCLUDE_SRC);
// Project map: the Git for Windows install, whose mintty opens "open in bash".
export const GIT_DIR = env('MC_GIT_DIR') ?? 'C:/Program Files/Git';
// Other machines' Cleons whose rows this one shows beside its own: `name=http://127.0.0.1:<port>`, comma-
// separated, each reached over loopback (an SSH local forward). Unset: this machine only. See lib/peers.mjs.
export const PEERS_SRC = env('MC_PEERS');
// Docker Desktop's disk file (WSL2 default location).
export const DOCKER_DISK = env('MC_DOCKER_DISK') ?? join(process.env.LOCALAPPDATA ?? '', 'Docker', 'wsl', 'disk', 'docker_data.vhdx');
