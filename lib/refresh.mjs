// A source that is read again in the background and served from its last value in between (Resources, Docker, Process,
// Usage). Once a value exists a caller gets it at once and nothing awaits the refresh behind it, so a refresh that
// fails must be handled here: left alone, its rejection is unhandled and ends the server. A failure keeps the last
// value and its age, so the very next call tries again. With no value yet the caller gets the rejection (the route
// answers with its reason). One refresh runs at a time, and each streak of failures is logged once, so a source that
// keeps failing doesn't fill the log on every poll.
//   get()      the last value if it is younger than `ttl` ms, else start a refresh and still serve the last value.
//   get(true)  wait for a refresh (the running one, or a new one): after an action that changed the source.
export function refreshed(name, fn, { ttl, log = console.warn } = {}) {
  let last, has = false, doneAt = 0, running = null, failing = false;
  const start = () => {
    running = Promise.resolve().then(fn).then(v => { last = v; has = true; doneAt = Date.now(); failing = false; return v; }, e => {
      if (!failing) log(`${name}: refresh failed: ${e?.message ?? e}${has ? ' (the last value is still served)' : ''}`);
      failing = true;
      throw e;
    }).finally(() => { running = null; });
    running.catch(() => {}); // a caller that holds the promise still sees the rejection; this one only marks it handled
    return running;
  };
  return (fresh = false) => {
    if (fresh || !has || Date.now() - doneAt >= ttl) running ??= start();
    return fresh || !has ? running : Promise.resolve(last);
  };
}
