import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { safeUrl, markdownSafety, vttTurns, viewKind, fmtSize } from '../public/view-lib.mjs';

const md = new Marked(markdownSafety);
// An attribute value as the browser reads it: character references decoded once (a numeric one even without its ";").
const decode = s => s.replace(/&(#x[0-9a-f]+;?|#\d+;?|amp;|lt;|gt;|quot;)/gi, (_, e) => e[0] === '#'
  ? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : { 'amp;': '&', 'lt;': '<', 'gt;': '>', 'quot;': '"' }[e.toLowerCase()]);
// Every href and src in the output, with the scheme the browser would follow.
const targets = html => [...html.matchAll(/\s(href|src)="([^"]*)"/g)]
  .map(([, attr, v]) => ({ attr, scheme: new URL(decode(v), 'http://cleon.invalid/').protocol }));
const live = html => targets(html).filter(t => !(t.attr === 'href' ? ['http:', 'https:', 'mailto:'] : ['http:', 'https:']).includes(t.scheme));

test('safeUrl keeps http, https and mailto links, http and https images, and scheme-less ones; nothing else', () => {
  for (const ok of ['https://acme.example/a', 'http://acme.example', 'mailto:a@acme.example', './doc.md', '/path', '#frag', '?q=1', '//acme.example/x'])
    assert.equal(safeUrl(ok, 'link'), ok, ok);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' java\tscript:alert(1)', 'java\nscript:x', 'vbscript:x', 'data:text/html,x', 'file:///c:/x', 'blob:x', 'http://['])
    assert.equal(safeUrl(bad, 'link'), null, bad);
  assert.equal(safeUrl('https://acme.example/i.png', 'image'), 'https://acme.example/i.png');
  assert.equal(safeUrl('i.png', 'image'), 'i.png');
  assert.equal(safeUrl('mailto:a@acme.example', 'image'), null);
  assert.equal(safeUrl('data:image/png;base64,AAAA', 'image'), null);
});

test('rendered Markdown never carries a live unsafe-scheme link or image', () => {
  const cases = [
    '[a](javascript:alert(1))', '[a](JaVaScRiPt:alert(1))', '[a](<java\tscript:alert(1)>)', '[a](javascript\\:alert(1))',
    '[a](&#106;avascript:alert(1))', '[a](&#x6A;avascript:alert(1))', '[a](&#106avascript:alert(1))',
    '<javascript:alert(1)>', '<JAVASCRIPT:alert(1)>', '[a][x]\n\n[x]: javascript:alert(1)', '[a]\n\n[a]: <javascript:alert(1)> "t"',
    '[a](vbscript:msgbox(1))', '[a](data:text/html,<script>alert(1)</script>)',
    '![x](javascript:alert(1))', '![x](&#106;avascript:alert(1))', '![x][i]\n\n[i]: javascript:alert(1)', '![x](vbscript:x)',
    '![x](data:text/html,<script>alert(1)</script>)', '[![x](javascript:a)](javascript:b)',
  ];
  for (const c of cases) {
    const out = md.parse(c);
    assert.deepEqual(live(out), [], `${c} → ${out}`);
    assert.doesNotMatch(out, /(href|src)="&#/, `${c} → ${out}`); // an entity is never left for the browser to decode
  }
  // Refused: the link becomes its text, the image its alt text.
  assert.equal(md.parse('[click *me*](javascript:alert(1))').trim(), '<p>click <em>me</em></p>');
  assert.equal(md.parse('<javascript:alert(1)>').trim(), '<p>javascript:alert(1)</p>');
  assert.equal(md.parse('![a "b" <c>](javascript:x)').trim(), '<p>a &quot;b&quot; &lt;c&gt;</p>');
  // An entity-encoded destination is written escaped, so the browser reads the literal (relative) string.
  assert.match(md.parse('[a](&#106;avascript:alert(1))'), /href="&amp;#106;avascript:alert\(1\)"/);
});

test('safe links and images survive, raw HTML stays text, and a mailto image is dropped', () => {
  assert.equal(md.parse('[h](https://acme.example/x?a=1&b=2 "A \\"T\\"")').trim(), '<p><a href="https://acme.example/x?a=1&amp;b=2" title="A &quot;T&quot;">h</a></p>');
  assert.equal(md.parse('[h](http://acme.example)').trim(), '<p><a href="http://acme.example">h</a></p>');
  assert.equal(md.parse('[m](mailto:a@acme.example)').trim(), '<p><a href="mailto:a@acme.example">m</a></p>');
  assert.equal(md.parse('[r](./doc.md) [f](#frag)').trim(), '<p><a href="./doc.md">r</a> <a href="#frag">f</a></p>');
  assert.equal(md.parse('<https://acme.example>').trim(), '<p><a href="https://acme.example">https://acme.example</a></p>');
  assert.equal(md.parse('[a][x]\n\n[x]: https://acme.example/ref').trim(), '<p><a href="https://acme.example/ref">a</a></p>');
  assert.equal(md.parse('![logo](https://acme.example/l.png "L")').trim(), '<p><img src="https://acme.example/l.png" alt="logo" title="L"></p>');
  assert.equal(md.parse('![rel](img/l.png)').trim(), '<p><img src="img/l.png" alt="rel"></p>');
  assert.equal(md.parse('![m](mailto:a@acme.example)').trim(), '<p>m</p>');
  const raw = md.parse('<a href="javascript:x">y</a> <img src=x onerror=alert(1)>');
  assert.equal(raw.trim(), '<p>&lt;a href=&quot;javascript:x&quot;&gt;y&lt;/a&gt; &lt;img src=x onerror=alert(1)&gt;</p>');
  assert.deepEqual(targets(raw), []);
});

test('vttTurns reads a Teams transcript into turns: speakers from voice tags, consecutive cues by one speaker merged', () => {
  const vtt = [
    'WEBVTT', '',
    'NOTE This line is a comment', 'and so is this', '',
    'STYLE', '::cue { color: lime }', '',
    '0a1b2c3d-1111/12-0', '00:00:03.120 --> 00:00:05.480', '<v Ann Acme>Hello everyone.</v>', '',
    '0a1b2c3d-1111/13-0', '00:00:05.480 --> 00:00:07.000', '<v Ann Acme>Shall we start?</v>', '',
    '00:00:07.500 --> 00:00:09.000 align:start', '<v.loud Bo Builder>Q&amp;A first &lt;please&gt;, it&#39;s &quot;quick&quot;&nbsp;now</v>', '',
    '00:01:10.000 --> 00:01:12.000', 'A cue with <b>no</b> speaker', 'on two lines', '',
    '00:01:12.000 --> 00:01:13.000', 'and another', '',
    '01:14.250 --> 01:15.000', '<v Ann Acme><c.x>Back</c> to me.</v>', '',
    'not a cue at all', '',
  ].join('\r\n');
  assert.deepEqual(vttTurns(vtt), [
    { start: '00:00:03', speaker: 'Ann Acme', text: 'Hello everyone. Shall we start?' },
    { start: '00:00:07', speaker: 'Bo Builder', text: `Q&A first <please>, it's "quick" now` },
    { start: '00:01:10', speaker: null, text: 'A cue with no speaker on two lines' },
    { start: '00:01:12', speaker: null, text: 'and another' },
    { start: '01:14', speaker: 'Ann Acme', text: 'Back to me.' },
  ]);
  assert.deepEqual(vttTurns('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n&amp;lt;b&amp;gt; &lrm;x&rlm;'), [{ start: '00:00:01', speaker: null, text: '&lt;b&gt; ‎x‏' }]);
  assert.deepEqual(vttTurns(''), []);
  assert.deepEqual(vttTurns(null), []);
});

test('viewKind picks how each type is shown; fmtSize reads a byte count', () => {
  const kinds = { md: 'md', MARKDOWN: 'md', html: 'html', htm: 'html', pdf: 'pdf', vtt: 'vtt', png: 'image', jpg: 'image', jpeg: 'image',
    gif: 'image', webp: 'image', docx: 'office', doc: 'office', xlsx: 'office', xls: 'office', pptx: 'office', ppt: 'office',
    txt: 'text', csv: 'text', eml: 'text', mht: 'text', mhtml: 'text', svg: 'text', '': 'text' };
  for (const [ext, kind] of Object.entries(kinds)) assert.equal(viewKind(ext), kind, ext);
  assert.equal(viewKind(undefined), 'text');
  assert.deepEqual([0, 1023, 1024, 1536, 5 * 1024 ** 2, 3 * 1024 ** 3].map(fmtSize), ['0 B', '1023 B', '1.0 KB', '1.5 KB', '5.0 MB', '3.0 GB']);
});
