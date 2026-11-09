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

// Pure: the character references in a link's destination or title decoded, as CommonMark reads them (marked leaves
// them as written): numeric ones, and a few named ones; any other name stays as written.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', Tab: '\t', NewLine: '\n', nbsp: '\u00a0' };
const decodeRefs = s => String(s ?? '').replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]+));/g, (m, dec, hex, name) => {
  if (name) return NAMED[name] ?? m;
  const cp = dec ? Number(dec) : parseInt(hex, 16);
  return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\ufffd' : String.fromCodePoint(cp);
});

// A marked extension for everything rendered from Markdown on the page: raw HTML is shown as text, and links and
// images are written here, never by marked's own renderer. marked leaves entities in a destination as they are
// (`&#106;avascript:`) and its renderer writes them unescaped, so the browser would decode them into a scheme no one
// checked. Here they're decoded first, and the string that was checked is written fully escaped, so the browser reads
// exactly that. A link to anything else becomes its text; an image, its alt text. A link opens in a window of its own
// (a #fragment excepted), so a click never takes Cleon's window, or the standalone viewer's, somewhere else.
export const markdownSafety = {
  renderer: {
    html: t => esc(t.text ?? t),
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens), url = safeUrl(decodeRefs(href), 'link');
      if (url == null) return text;
      return `<a href="${esc(url)}"${title ? ` title="${esc(decodeRefs(title))}"` : ''}${url.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"'}>${text}</a>`;
    },
    image({ href, title, text, tokens }) {
      const alt = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text, url = safeUrl(decodeRefs(href), 'image');
      return url == null ? esc(alt) : `<img src="${esc(url)}" alt="${esc(alt)}"${title ? ` title="${esc(decodeRefs(title))}"` : ''}>`;
    },
  },
};

// Pure: how the viewer shows a file of this type.
const KINDS = { md: 'md', markdown: 'md', html: 'html', htm: 'html', pdf: 'pdf', vtt: 'vtt',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  docx: 'office', doc: 'office', xlsx: 'office', xls: 'office', pptx: 'office', ppt: 'office' };
export const viewKind = ext => KINDS[String(ext ?? '').toLowerCase()] ?? 'text';

// Pure: a byte count as people read it.
export const fmtSize = n => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB`
  : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;

// Pure: a WebVTT transcript → its turns, [{ start, speaker, text }]. A cue is an optional id line, a timing line, then
// its text; the speaker comes from a voice tag (`<v Name>` or `<v.class Name>`, as Teams writes them), other tags
// are dropped and the common entities decoded. Consecutive cues by the same named speaker make one turn, from the
// first one's start (cues with no speaker stay apart, so each keeps its time). WEBVTT, NOTE, STYLE and REGION
// blocks are skipped. The start is shown without its milliseconds.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', lrm: '\u200e', rlm: '\u200f' };
export function vttTurns(text) {
  const turns = [];
  for (const block of String(text ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').filter(l => l.trim());
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
    const t = lines.findIndex(l => /^(\S+)\s+-->\s+(\S+)/.test(l));
    if (t < 0 || t > 1) continue;
    const payload = lines.slice(t + 1).join(' ');
    const speaker = payload.match(/<v(?:\.[^\s>]*)?\s+([^>]+)>/)?.[1].trim() || null;
    const said = payload.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39|nbsp|lrm|rlm);/g, (_, e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
    if (!said) continue;
    const start = lines[t].match(/^(\S+)/)[1].replace(/\.\d+$/, ''), last = turns.at(-1);
    if (speaker && last?.speaker === speaker) last.text += ` ${said}`;
    else turns.push({ start, speaker, text: said });
  }
  return turns;
}

// The one message a Knowledge preview's HTML frame sends its page: Esc was pressed inside it. The page acts on it only
// from that preview's own frame, and only by closing the preview.
export const PREVIEW_ESC = 'cleon:preview-esc';
// Pure: an HTML file's text, as a Knowledge preview's frame shows it: the file, then a fixed script that sends
// PREVIEW_ESC on Esc. It goes at the end, so a doctype stays first.
export const escFrameDoc = html => `${html}\n<script>addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage(${JSON.stringify(PREVIEW_ESC)},'*')},true)</script>`;
// Pure: the encoding an HTML file's bytes are read in, as the server serves them: the charset its Content-Type names,
// else its own (a byte-order mark, or a <meta> charset in its first 1024 bytes), else UTF-8.
export function htmlCharset(bytes, contentType) {
  const sent = /;\s*charset=["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (sent) return sent;
  const b = bytes;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  const head = String.fromCharCode(...b.subarray(0, 1024));
  return /<meta[^>]*\bcharset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ?? 'utf-8';
}
