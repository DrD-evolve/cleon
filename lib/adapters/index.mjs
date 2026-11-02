// The orchestration adapter in use: MC_ORCH_ADAPTER (a path to a module whose default export has the
// same fields as orchestration-plugin.mjs), else the orchestration plugin's.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORCH_ADAPTER } from '../config.mjs';

const mod = await import(ORCH_ADAPTER ? pathToFileURL(resolve(ORCH_ADAPTER)).href : './orchestration-plugin.mjs');
export default mod.default;
