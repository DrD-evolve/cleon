// A read shared for a moment. A call within `ttlMs` of the last finished read gets its value; a call that
// arrives while a read runs waits for that read rather than starting another, so the endpoints one page
// poll hits at once (and every open window) cost one read.
//   get()        the shared value.
//   get.reset()  after an action that changed what is read: the next call reads afresh. A read already
//                running is let go: it neither serves a later caller nor fills the cache, because it began
//                before the change and could show the old state.
export function cached(fn, ttlMs, now = Date.now) {
  let at = 0, value, running = null, gen = 0;
  const get = () => {
    if (now() - at < ttlMs) return Promise.resolve(value);
    if (running) return running;
    const mine = gen;
    const p = Promise.resolve().then(fn).then(v => {
      if (mine === gen) { value = v; at = now(); }
      return v;
    }).finally(() => { if (running === p) running = null; });
    return running = p;
  };
  get.reset = () => { at = 0; gen++; running = null; };
  return get;
}
