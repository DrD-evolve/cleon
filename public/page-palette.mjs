// The colours and fonts JavaScript draws with, shared by the board (app.js) and the project page (project.mjs).
// Everything drawn in JavaScript (the Knowledge map, the Activity picture, the window icon, the Usage charts, the project
// panel's glyphs) takes its colours and fonts from the stylesheet's tokens through PAL. PAL is read from the page once at
// load and once each time something fires `cleon:theme-changed` on the document (a theme picker sets tokens on :root, then
// fires it); never per frame. The event rebuilds PAL, then runs each redraw registered with onPalette. A colour is #rrggbb,
// or rgba() when its token is translucent, so a surface keeps its alpha.
import { TOKENS, FONTS, FONT_FALLBACK, buildPalette, parseColor, toCss, mix } from '/palette.mjs';

export const PAL = { font: {} };
const palProbe = document.createElement('span');
palProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
const palPx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
const palRedraws = [];
export const onPalette = fn => palRedraws.push(fn);
// A token read through a hidden element, so var() and color-mix() come back resolved as rgb() or color(srgb ...). A
// token that is missing, or isn't a colour (or a font), reads as '' and takes its fallback: through the element it would
// read as the page's own colour and font, which the element inherits.
function palRead(prop, token, root) {
  const raw = root.getPropertyValue(token).trim();
  if (!raw || !CSS.supports(prop === 'color' ? 'color' : 'font-family', raw)) return '';
  if (!palProbe.isConnected) document.documentElement.append(palProbe);
  palProbe.style[prop] = '';
  palProbe.style[prop] = `var(${token})`;
  const v = getComputedStyle(palProbe)[prop];
  if (prop !== 'color' || parseColor(v)) return v;
  // A colour the parser doesn't read (oklch(), lab(), a color-mix() in oklab come back as written): a canvas gives its sRGB.
  palPx.clearRect(0, 0, 1, 1); palPx.fillStyle = v; palPx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = palPx.getImageData(0, 0, 1, 1).data;
  return toCss([r, g, b, a / 255]);
}
export function palRebuild() {
  const root = getComputedStyle(document.documentElement);
  for (const [name, c] of Object.entries(buildPalette(name => palRead('color', TOKENS[name], root)))) PAL[name] = toCss(c);
  for (const [name, token] of Object.entries(FONTS)) PAL.font[name] = palRead('fontFamily', token, root).trim() || FONT_FALLBACK[name];
  PAL.min = parseFloat(root.getPropertyValue('--text-min')) || 0; // the smallest size the theme allows; canvas text never goes under it
}
palRebuild();
document.addEventListener('cleon:theme-changed', () => { palRebuild(); for (const fn of palRedraws) fn(); });

// Git state is a status: [colour, words]. The colours are filled from PAL, now and on each theme change (kmColors).
export const PMAP_STATE = { clean: ['', 'clean'], dirty: ['', 'uncommitted changes'], norepo: ['', 'no repo'] };
export const pmapState = p => !p.repo ? 'norepo' : p.dirty ? 'dirty' : 'clean';
// Sector colours: the five category tokens by the category's place in the tree (no category name is special), then the
// same five lighter, and lighter again. Chart series use the same set.
export const catColor = i => { const c = PAL[`cat${i % 5 + 1}`], step = Math.floor(i / 5); return step ? mix(c, PAL.ink, Math.min(0.75, 0.3 * step)) : c; };
export const KM_SRC = { vault: ['', 'Vault page'], memory: ['', 'Memory note'] };
// How a belt item was matched to a project (lib/belts.mjs, lib/belt-match.mjs): a category each, never a status.
export const KM_HOW = { mention: '', link: '', haiku: '' };
// An ADR's status, as a tint on its diamond: a status, so a status token.
const KM_STATUS = [[/accept|approv|done|implement/i, 'ok'], [/propos|draft|review|progress/i, 'working'], [/supersed|deprecat|reject|withdraw/i, 'muted2']];
export const kmStatusC = s => PAL[KM_STATUS.find(([re]) => re.test(s))?.[1] ?? 'muted2'];
export function kmColors() {
  PMAP_STATE.clean[0] = PAL.ok; PMAP_STATE.dirty[0] = PAL.working; PMAP_STATE.norepo[0] = PAL.muted;
  KM_SRC.vault[0] = PAL.cat5; KM_SRC.memory[0] = PAL.cat4;
  KM_HOW.mention = PAL.cat5; KM_HOW.link = PAL.cat1; KM_HOW.haiku = PAL.cat4;
}
kmColors();
