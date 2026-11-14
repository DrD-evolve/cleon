import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
// Token blocks hold the only colour literals and size values: one block per theme (Horizon, the default, and Neon).
const blocks = [/^:root, :root\[data-theme="horizon"\] \{[\s\S]*?^\}/m, /^:root\[data-theme="neon"\] \{[\s\S]*?^\}/m].map(re => css.match(re)[0]);
const rest = blocks.reduce((text, b) => text.replace(b, ''), css);
// Every innermost rule outside the token block as [selector, declarations], comments and quoted strings removed,
// then every declaration as [selector, property, value].
const rules = [...rest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'|"[^"]*"/g, '""').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => [m[1].trim().replace(/\s+/g, ' '), m[2]]);
const decls = rules.flatMap(([sel, body]) => body.split(';').map(d => d.trim()).filter(Boolean)
  .map(d => [sel, d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));

// CSS named colours (transparent and currentColor are not literals of a colour, so they are allowed).
const NAMED = ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '
  + 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen '
  + 'darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray '
  + 'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia '
  + 'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender '
  + 'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink '
  + 'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta '
  + 'maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise '
  + 'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
  + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red '
  + 'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
  + 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' ');

test('no colour literal outside the token block', () => {
  const literal = new RegExp(String.raw`\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|#[0-9a-fA-F]{3,8}\b|(?<![\w-])(?:${NAMED.join('|')})(?![\w-])`, 'i');
  assert.deepEqual(decls.filter(([, , v]) => literal.test(v)), []);
});

test('no font size or font family written outside the token block', () => {
  const ok = ([, p, v]) => p === 'font-size' ? /^var\(--fs-[\w-]+\)$/.test(v)
    : p === 'font' ? /^(\d+ )?var\(--fs-[\w-]+\)(\/[\d.]+)? var\(--[\w-]+\)$/.test(v)
    : p === 'font-family' ? /^var\(--[\w-]+\)$/.test(v) : true;
  assert.deepEqual(decls.filter(d => !ok(d)), []);
});

test('pink is used for waiting on you only: these rules and no others', () => {
  // Blocked / plan-gate / human-review chips, your-turn tickets, the current pip at a gate, the orchestrator's needs strip and its (you) items,
  // session cards with a question open, gates, the Process panel's "you" segments, and the command bar's "waiting on you" mark.
  const WAITING = ['.c-blocked, .c-plan-gate, .c-human-review', '.tk.you', '.pip.current.gate .dot', '.pip.current.gate .halo', '.orch-strip.needs', '.orch-strip.needs .orch-dot',
    '.orch-strip.needs .orch-state', '.orch-strip.needs .orch-intent', '.wk-needs', '.orch-wants', '.orch-wants .ck-title',
    '.orch-more', '.card.needs', '.gate', '.gate-title', '.gate-opts li.rec b', '.pm-you', '.pm-you-tile', '.pm-you-node .shape',
    '.pm-you-node .pm-dur', '.cmd-you', ':root[data-theme=""] .card.needs']; // the last is Horizon's (quoted strings are blanked above)
  assert.deepEqual(rules.filter(([, body]) => /var\(--attention\)/.test(body)).map(([sel]) => sel), WAITING);
});

test('one rule stops repeating animations for reduced motion and for calm', async () => {
  const media = rest.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const calm = ':root[data-motion="calm"]', sys = ':root:not([data-motion="full"])'; // the system's setting yields to Full
  for (const [where, text, parts] of [['reduced motion', media, [`${sys} *, ${sys} *::before, ${sys} *::after { animation: none !important; }`,
    `${sys} .kp-it.flash { box-shadow:`, `${sys} .fc-particle { visibility: hidden; }`]], ['calm', rest, [`${calm} *, ${calm} *::before, ${calm} *::after { animation: none !important; }`,
    `${calm} .kp-it.flash { box-shadow:`, `${calm} .fc-particle { visibility: hidden; }`]]]) {
    for (const part of parts) assert.ok(text.includes(part), `${where}: ${part}`);
  }
  // `animation` cannot stop SVG <animate*> elements, so each one must sit in a .fc-particle, which both rules hide.
  const dir = new URL('../public/', import.meta.url);
  for (const f of (await readdir(dir)).filter(f => /\.m?js$/.test(f))) {
    const src = await readFile(new URL(f, dir), 'utf8');
    assert.equal((src.match(/<animate/g) ?? []).length, (src.match(/class="fc-particle"[^>]*><animate/g) ?? []).length, f);
  }
});

test('every repeating animation is allowed in Horizon or switched off there, so only three things move', () => {
  const ALLOWED = ['.tk.you .step .await', '.orch-strip.needs .orch-dot', '.orch-strip.needs .orch-state', '.wk-needs', '.gate-title', // waiting on you
    '.fc-node.current .shape',                                                                                                         // the current flow step
    '.pulse', '.orch-strip.working .orch-dot', '.dk-dot'];                                                                             // the status dot
  const off = rest.match(/:root\[data-theme="horizon"\] :is\(([^{}]*)\) \{ animation: none; \}/)?.[1] ?? '';
  const OFF = off.replace(/\s+/g, ' ').split(',').map(s => s.trim()).filter(Boolean);
  assert.ok(OFF.length >= 14, `found ${OFF.length} switched off`);
  const repeating = rules.filter(([, body]) => /animation:[^;]*\binfinite\b/.test(body)).map(([sel]) => sel);
  assert.ok(repeating.length >= 20, `found ${repeating.length} repeating animations`);
  for (const sel of repeating) assert.ok(ALLOWED.includes(sel) !== OFF.includes(sel), `${sel}: exactly one of allowed and off`);
  // gridstack.min.css repeats two of its own while a tile is armed for a touch drag
  for (const sel of ['.grid-stack-item.ui-draggable-armed', '.grid-stack-item > .ui-resizable-handle.ui-resizable-armed']) assert.ok(OFF.includes(sel), sel);
  assert.ok(rest.includes(':root[data-theme="horizon"] .fc-particle { visibility: hidden; }'));
});

test('buttons, inputs and links get a focus-visible outline in the accent, and no rule switches it off', () => {
  const rule = rest.match(/:focus-visible \{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /outline: 2px solid var\(--accent\)/);
  assert.deepEqual(decls.filter(([, p, v]) => /^outline(-style|-width)?$/.test(p) && /^(none|0)\b/.test(v)), []);
});
