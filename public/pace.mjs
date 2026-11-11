// Timed polls that slow or stop while the tab is hidden. `hiddenMs` 0 means stops. `env` is the page's (document.hidden
// and the timers), passed in so a test can drive it.
export function createPacer(env = { hidden: () => document.hidden, set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t) }) {
  const pacers = [];
  const paced = (fn, visibleMs, hiddenMs) => {
    const p = { timer: 0 };
    p.arm = () => {
      env.clear(p.timer); p.timer = 0;
      const ms = env.hidden() ? hiddenMs : visibleMs;
      if (ms) p.timer = env.set(p.run, ms);
    };
    p.run = async () => { try { await fn(); } finally { p.arm(); } };
    pacers.push(p);
    p.arm();
  };
  // The tab hid or showed: hiding re-times every poll; showing runs every one at once.
  const visibilityChanged = () => { for (const p of pacers) { if (env.hidden()) p.arm(); else p.run(); } };
  return { paced, visibilityChanged };
}
