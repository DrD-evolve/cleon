// The viewer's pure helpers: no imports, so the page and Node's tests load the same file.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Pure: `href` when a rendered link (kind 'link') or image ('image') may point there, else null. The scheme is read
// the way the browser reads it (the WHATWG URL parser: tabs and newlines dropped, case folded). Links keep http,
// https and mailto, images http and https; scheme-less ones (relative, /path, #fragment) resolve to http against the
// base, so they pass.
const SAFE = { link: new Set(['http:', 'https:', 'mailto:']), image: new Set(['http:', 'https:']) };
export function safeUrl(href, kind) {
  let u;
  try { u = new URL(href, 'http://cleon.invalid/'); } catch { return null; }
  return SAFE[kind]?.has(u.protocol) ? href : null;
}

// A marked extension for everything rendered from Markdown on the page: raw HTML is shown as text, and links and
// images are written here, never by marked's own renderer. marked leaves entities in a destination as they are
// (`&#106;avascript:`) and its renderer writes them unescaped, so the browser would decode them into a scheme no one
// checked. Here the string that was checked is written fully escaped, so the browser reads exactly that. A link to
// anything else becomes its text; an image, its alt text.
export const markdownSafety = {
  renderer: {
    html: t => esc(t.text ?? t),
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens), url = safeUrl(href, 'link');
      return url == null ? text : `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''}>${text}</a>`;
    },
    image({ href, title, text, tokens }) {
      const alt = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text, url = safeUrl(href, 'image');
      return url == null ? esc(alt) : `<img src="${esc(url)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''}>`;
    },
  },
};
