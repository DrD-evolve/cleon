// The source-control host in use: MC_SCM=bitbucket selects lib/bitbucket.mjs; otherwise lib/github.mjs
// (the gh CLI). Both return the same shapes; docs/PORTING.md (Phase 3) lists them.
import { SCM } from './config.mjs';

const bitbucket = SCM === 'bitbucket';
const mod = await import(bitbucket ? './bitbucket.mjs' : './github.mjs');
export const scmName = mod.NAME;
export const scmSummary = bitbucket ? mod.bitbucketSummary : mod.githubSummary;
export const { prChecks, prState, prDetail, repoPrs, me } = mod;

// Pure: a PR's number from its address on either host (…/pull/12, …/pull-requests/12[/overview]), or null.
export const prNumber = url => Number(String(url ?? '').match(/\/pull(?:-requests)?\/(\d+)/)?.[1]) || null;
