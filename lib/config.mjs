// Machine-specific settings, read from .env (gitignored; see .env.example). Loaded here rather than in
// server.mjs because ES imports run before the importing module's own code, so every lib module that
// reads a setting gets it from here. Defaults are generic; this machine's values live in .env.
import { join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch { /* no .env: defaults */ }

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
// Obsidian vault for the knowledge map; unset leaves it out.
export const VAULT = env('MC_VAULT');
// Privacy: paths matching this never enter the knowledge graph, file tiles, or session dialog reads.
export const EXCLUDE_SRC = env('MC_EXCLUDE');
export const EXCLUDE = excludePattern(EXCLUDE_SRC);
// Docker Desktop's disk file (WSL2 default location).
export const DOCKER_DISK = env('MC_DOCKER_DISK') ?? join(process.env.LOCALAPPDATA ?? '', 'Docker', 'wsl', 'disk', 'docker_data.vhdx');
