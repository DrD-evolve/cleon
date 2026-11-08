// Markdown for the page: the one marked instance every render goes through (notes, ticket and PR bodies, files).
import { marked } from '/vendor/marked.esm.js';
import { esc, markdownSafety } from './view-lib.mjs';

// Raw HTML is shown as text, never executed; links and images keep only safe schemes (view-lib.mjs).
marked.use(markdownSafety);
export { marked };

// Markdown file → HTML, with any front matter shown as-is above it.
export function mdHtml(text) {
  if (text == null) return '<p class="placeholder">Not readable.</p>';
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return (fm ? `<pre class="fm">${esc(fm[1])}</pre>` : '') + marked.parse(fm ? text.slice(fm[0].length) : text);
}
