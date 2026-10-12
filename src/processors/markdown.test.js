import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toMarkdown } from './markdown.js';

const fixture = (name) => fs.readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8');

test('whitespace is normalised: one final newline, no blank runs, no trailing spaces but a hard break', () => {
	const text = toMarkdown(fixture('article-24296142.html'));
	assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
	assert.ok(!text.includes('\n\n\n'));
	assert.ok(text.split('\n').every((line) => line === line.trimEnd() || line.endsWith('  ')));
	assert.equal(toMarkdown('<p>a</p><script>x()</script><style>p{}</style>'), 'a\n');
});

test('a line break is two trailing spaces, and one ending a paragraph is dropped', () => {
	assert.equal(toMarkdown('<p>one<br/>\r\n\xa0</p><p>two<br/>three</p>'), 'one\n\ntwo  \nthree\n');
	assert.ok(toMarkdown(fixture('article-24244888.html')).includes('**Luminous Sporeglider Mount**  \n*This mount is earned'));
});

test('in-page links point at GitHub\'s heading anchors', () => {
	const text = toMarkdown(fixture('article-24244888.html'));
	assert.ok(text.includes('[TRAVEL TO VAL AND NAIGTAL TO QUELL LEADERS OF THE VOID](#travel-to-val-and-naigtal-to-quell-leaders-of-the-void)'));
	assert.ok(text.includes('[Back to Top](#table-of-contents)'));
	assert.ok(!text.includes('(#item1)'));
	assert.ok(toMarkdown('<a href="#x">jump</a><h2 id="x">Patch\nNotes</h2>').includes('[jump](#patch-notes)'));
});

test('identical headings get numbered anchors, and a tab pane\'s id points at its first heading', () => {
	const text = toMarkdown('<a href="#a">x</a><a href="#b">y</a><div id="a"><h3>Talents</h3></div><div id="b"><h3>Talents</h3></div>');
	assert.ok(text.includes('[x](#talents)') && text.includes('[y](#talents-1)'));
	const tabs = toMarkdown(fixture('article-24301515.html'));
	assert.ok(tabs.includes('- [Hunter](#taking-aim-at-the-hunter-class)') && tabs.includes('- [Druid](#shifting-forms-with-the-druid-class)'));
});

test('a YouTube embed becomes a thumbnail link, any other video a plain link', () => {
	const youtube = toMarkdown('<iframe src="https://www.youtube-nocookie.com/embed/ab_-12"></iframe>');
	assert.ok(youtube.includes('youtube/ab_-12?width=1280&height=720') && youtube.includes('watch?v=ab_-12)'));
	assert.equal(toMarkdown('<iframe src="https://player.vimeo.com/video/1"></iframe>'), '[https://player.vimeo.com/video/1](https://player.vimeo.com/video/1)\n');
});

test('nested lists indent by the bullet, and a table without a header row gets an empty one', () => {
	assert.equal(toMarkdown('<ul><li>a<ul><li>b</li></ul></li></ul><ol start="3"><li>c</li><li>d</li></ol>'), '- a\n  - b\n\n3. c\n4. d\n');
	assert.equal(toMarkdown('<table><tr><td>a</td><td>b</td></tr></table>'), '|  |  |\n| --- | --- |\n| a | b |\n');
});
