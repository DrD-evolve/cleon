// Linear: issues assigned to the API key's owner that are still open.
export const LINEAR_URL = 'https://api.linear.app/graphql';

const QUERY = `query {
  viewer {
    name
    assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes {
        identifier title url priority priorityLabel updatedAt description
        state { name type color }
        project { name }
        team { key }
      }
    }
  }
}`;

const STATE_ORDER = { started: 0, unstarted: 1, triage: 2, backlog: 3 };

// Pure: in-progress first, then by priority (1 = urgent … 4 = low, 0 = none last), then most recent.
export function sortIssues(issues) {
  const pri = p => (p === 0 ? 9 : p);
  return [...issues].sort((a, b) =>
    (STATE_ORDER[a.state.type] ?? 5) - (STATE_ORDER[b.state.type] ?? 5)
    || pri(a.priority) - pri(b.priority)
    || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

// A request that never answers ends after `ms` and reads as offline. The timer also aborts the request, and races it,
// so a `fetchFn` that ignores the signal can't hold the panel up either.
export async function linearIssues(key = process.env.LINEAR_API_KEY, fetchFn = fetch, ms = 15_000) {
  if (!key) return { online: false, reason: 'LINEAR_API_KEY is not set in .env' };
  const ctl = new AbortController();
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => { const e = new Error(`no answer in ${ms / 1000} s`); ctl.abort(e); no(e); }, ms); });
  try {
    const j = await Promise.race([late, (async () => {
      const r = await fetchFn(LINEAR_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query: QUERY }),
        signal: ctl.signal,
      });
      return r.json();
    })()]);
    if (j.errors?.length) return { online: false, reason: j.errors[0].message };
    const v = j.data.viewer;
    return { online: true, user: v.name, issues: sortIssues(v.assignedIssues.nodes) };
  } catch (e) {
    return { online: false, reason: e.message };
  } finally {
    clearTimeout(timer);
  }
}
