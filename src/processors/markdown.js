import * as cheerio from 'cheerio';

// A port of markdownify with the settings the archive has always used, so saved files keep their format.

const YOUTUBE_ID = /(?:youtube\.com|youtube-nocookie\.com)\/embed\/([\w-]+)/;
// 1280x720 is YouTube's largest thumbnail; GitHub shrinks it to fit the column. The service adds the play button.
const youtubeThumbnail = (id) => `https://markdown-videos-api.jorgenkh.no/youtube/${id}?width=1280&height=720`;
const HEADING = /^h\d/;
const HEADING_TAGS = 'h1, h2, h3, h4, h5, h6';
const BLOCKS = new Set(['p', 'blockquote', 'article', 'div', 'section', 'ol', 'ul', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);

// Whitespace as markdownify sees it (Python's str.isspace), which differs a little from JS's \s.
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const LEADING_WS = new RegExp(`^[${WS}]+`);
const TRAILING_WS = new RegExp(`[${WS}]+$`);
const ALL_WS = new RegExp(`[${WS}]+`, 'g');
const rstrip = (text) => text.replace(TRAILING_WS, '');
const strip = (text) => rstrip(text).replace(LEADING_WS, '');
const stripLines = (text) => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''); // not nbsp
// Python's str.splitlines separators.
const LINE_BREAKS = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]'); // eslint-disable-line no-control-regex

const isTag = (node) => ['tag', 'script', 'style'].includes(node?.type);
const nameOf = (node) => (node.type === 'root' ? '[document]' : node.name ?? null);
const removeInside = (node) => isTag(node) && (HEADING.test(node.name) || BLOCKS.has(node.name));
const removeOutside = (node) => removeInside(node) || (isTag(node) && node.name === 'pre');
const isContent = (node) => isTag(node) || (node?.type === 'text' && strip(node.data) !== '');
const prevTag = (node) => {
	let at = node.prev;
	while (at && !isTag(at)) {
		at = at.prev;
	}
	return at;
};
const nextContent = (node) => {
	let at = node.next;
	while (at && !isContent(at)) {
		at = at.next;
	}
	return at;
};
const inside = (node, name) => {
	for (let at = node.parent; at; at = at.parent) {
		if (at.name === name) {
			return true;
		}
	}
	return false;
};

function descendants(node, test, out = []) {
	for (const child of node.children ?? []) {
		if (test(child)) {
			out.push(child);
		}
		descendants(child, test, out);
	}
	return out;
}

const escape = (text) => text.replaceAll('*', '\\*').replaceAll('_', '\\_');
const indentLines = (text, indent) => text.split('\n').map((line) => (line ? indent + line : '')).join('\n');
const colspan = (cell) => (/^\d+$/.test(cell.attribs.colspan ?? '') ? Math.max(1, Math.min(1000, Number(cell.attribs.colspan))) : 1);

/** Leading and trailing spaces of an inline tag's text go outside its markup, so <b> foo</b> isn't ** foo**. */
function chomp(text) {
	return [text.startsWith(' ') ? ' ' : '', text.endsWith(' ') ? ' ' : '', strip(text)];
}

const inline = (markup) => (el, text, tags) => {
	if (tags.has('_noformat')) {
		return text;
	}
	const [prefix, suffix, inner] = chomp(text);
	return inner ? prefix + markup + inner + markup + suffix : '';
};

function code(el, text, tags) {
	if (tags.has('_noformat')) {
		return text;
	}
	const [prefix, suffix, inner] = chomp(text);
	if (!inner) {
		return '';
	}
	const ticks = Math.max(0, ...(inner.match(/`+/g) ?? []).map((run) => run.length));
	const fence = '`'.repeat(ticks + 1);
	return prefix + fence + (ticks ? ` ${inner} ` : inner) + fence + suffix;
}

function div(el, text, tags) {
	if (tags.has('_inline')) {
		return ` ${strip(text)} `;
	}
	const inner = strip(text);
	return inner ? `\n\n${inner}\n\n` : '';
}

function list(el, text, tags) {
	const next = nextContent(el);
	if (tags.has('li')) {
		return '\n' + rstrip(text);
	}
	return '\n\n' + text + (next && !['ul', 'ol'].includes(next.name) ? '\n' : '');
}

const cell = (el, text) => ` ${strip(text).replaceAll('\n', ' ')}${' |'.repeat(colspan(el))}`;

const title = (el) => (el.attribs.title ? ` "${el.attribs.title.replaceAll('"', '\\"')}"` : '');

const CONVERT = {
	'[document]': (el, text) => text.replace(/^\n+|\n+$/g, ''),
	'a': (el, text, tags) => {
		if (tags.has('_noformat')) {
			return text;
		}
		const [prefix, suffix, inner] = chomp(text);
		if (!inner) {
			return '';
		}
		const { href } = el.attribs;
		if (inner.replaceAll('\\_', '_') === href && !el.attribs.title) {
			return `<${href}>`;
		}
		return href ? `${prefix}[${inner}](${href}${title(el)})${suffix}` : inner;
	},
	'b': inline('**'),
	'strong': inline('**'),
	'em': inline('*'),
	'i': inline('*'),
	'del': inline('~~'),
	's': inline('~~'),
	'sub': inline(''),
	'sup': inline(''),
	'code': code,
	'kbd': code,
	'samp': code,
	'div': div,
	'article': div,
	'section': div,
	'dl': div,
	'blockquote': (el, text, tags) => {
		const inner = stripLines(text);
		if (tags.has('_inline')) {
			return ` ${inner} `;
		}
		return inner ? `\n${inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n\n` : '\n';
	},
	'br': (el, text, tags) => (tags.has('_inline') ? `${text} ` : `  \n${text}`),
	'dd': (el, text, tags) => {
		const inner = strip(text);
		if (tags.has('_inline')) {
			return ` ${inner} `;
		}
		return inner ? `:${indentLines(inner, '    ').slice(1)}\n` : '\n';
	},
	'dt': (el, text, tags) => {
		const inner = strip(text).replace(/[\t \r\n]+/g, ' ');
		if (tags.has('_inline')) {
			return ` ${inner} `;
		}
		return inner ? `\n\n${inner}\n` : '\n';
	},
	'hr': () => '\n\n---\n\n',
	'img': (el, text, tags) => {
		const alt = el.attribs.alt || '';
		return tags.has('_inline') ? alt : `![${alt}](${el.attribs.src || ''}${title(el)})`;
	},
	'video': (el, text, tags) => {
		if (tags.has('_inline')) {
			return text;
		}
		const src = el.attribs.src || descendants(el, (n) => n.name === 'source' && n.attribs.src !== undefined)[0]?.attribs.src || '';
		const poster = el.attribs.poster || '';
		if (src && poster) {
			return `[![${text}](${poster})](${src})`;
		}
		return src ? `[${text}](${src})` : poster ? `![${text}](${poster})` : text;
	},
	// Embedded YouTube video becomes a clickable thumbnail, any other video a plain link.
	'iframe': (el) => {
		const src = el.attribs.src;
		if (!src) {
			return '';
		}
		const video = src.match(YOUTUBE_ID)?.[1];
		return video ? `\n\n[![Video](${youtubeThumbnail(video)})](https://www.youtube.com/watch?v=${video})\n\n` : `\n\n[${src}](${src})\n\n`;
	},
	'ul': list,
	'ol': list,
	'li': (el, text) => {
		const inner = strip(text);
		if (!inner) {
			return '\n';
		}
		let bullet = '- ';
		if (el.parent?.name === 'ol') {
			const start = /^\d+$/.test(el.parent.attribs.start ?? '') ? Number(el.parent.attribs.start) : 1;
			bullet = `${start + el.parent.children.slice(0, el.parent.children.indexOf(el)).filter((n) => n.name === 'li').length}. `;
		}
		return bullet + indentLines(inner, ' '.repeat(bullet.length)).slice(bullet.length) + '\n';
	},
	'p': (el, text, tags) => {
		const inner = stripLines(text);
		if (tags.has('_inline')) {
			return ` ${inner} `;
		}
		return inner ? `\n\n${inner}\n\n` : '';
	},
	'pre': (el, text) => (text ? `\n\n\`\`\`\n${text.replace(/^[ \n]*\n/, '').replace(/[ \n]*$/, '')}\n\`\`\`\n\n` : ''),
	'q': (el, text) => `"${text}"`,
	'script': () => '',
	'style': () => '',
	'table': (el, text) => `\n\n${strip(text)}\n\n`,
	'caption': (el, text) => `${strip(text)}\n\n`,
	'figcaption': (el, text) => `\n\n${strip(text)}\n\n`,
	'td': cell,
	'th': cell,
	'tr': (el, text) => {
		const cells = descendants(el, (n) => n.name === 'td' || n.name === 'th');
		const { parent } = el;
		const first = !prevTag(el);
		const headRow = cells.every((c) => c.name === 'th') || (parent.name === 'thead' && descendants(parent, (n) => n.name === 'tr').length === 1);
		const headMissing = first && (parent.name !== 'tbody' || !descendants(parent.parent, (n) => n.name === 'thead').length);
		const width = cells.reduce((sum, c) => sum + colspan(c), 0);
		const row = (fill) => `| ${Array(width).fill(fill).join(' | ')} |\n`;
		if (headRow && first) {
			return `|${text}\n${row('---')}`;
		}
		if (headMissing || (first && (parent.name === 'table' || (parent.name === 'tbody' && !prevTag(parent))))) {
			return `${row('')}${row('---')}|${text}\n`;
		}
		return `|${text}\n`;
	},
};

function convertFor(name) {
	if (Object.hasOwn(CONVERT, name)) {
		return CONVERT[name];
	}
	const level = name?.match(/^h(\d+)/)?.[1];
	if (!level) {
		return null;
	}
	return (el, text, tags) => (tags.has('_inline') ? text : `\n\n${'#'.repeat(Math.max(1, Math.min(6, Number(level))))} ${strip(text).replace(/[\t \r\n]+/g, ' ')}\n\n`);
}

function processText(node, tags) {
	let text = node.data;
	if (!tags.has('pre')) {
		text = text.replace(/[\t \r\n]*[\r\n][\t \r\n]*/g, '\n').replace(/[\t ]+/g, ' ');
	}
	if (!tags.has('_noformat')) {
		text = escape(text);
	}
	if (removeOutside(node.prev) || (removeInside(node.parent) && !node.prev)) {
		text = text.replace(/^[ \t\r\n]+/, '');
	}
	if (removeOutside(node.next) || (removeInside(node.parent) && !node.next)) {
		text = rstrip(text);
	}
	return text;
}

function processTag(node, tags) {
	const name = nameOf(node);
	const removeIn = removeInside(node);
	const ignored = (child) => {
		if (isTag(child)) {
			return false;
		}
		if (child.type !== 'text' || strip(child.data) !== '') {
			return child.type !== 'text'; // comments, doctypes and the like
		}
		return (removeIn && (!child.prev || !child.next)) || removeOutside(child.prev) || removeOutside(child.next);
	};
	const childTags = new Set(tags).add(name);
	if (HEADING.test(name) || name === 'td' || name === 'th') {
		childTags.add('_inline');
	}
	if (['pre', 'code', 'kbd', 'samp'].includes(name)) {
		childTags.add('_noformat');
	}
	const parts = node.children.filter((child) => !ignored(child))
		.map((child) => (isTag(child) ? processTag(child, childTags) : processText(child, childTags))).filter(Boolean);
	let text;
	if (name === 'pre' || inside(node, 'pre')) {
		text = parts.join('');
	} else {
		// Newlines where two parts meet: the larger count of the two, at most 2.
		const joined = [''];
		for (const part of parts) {
			let [, leading, content, trailing] = part.match(/^(\n*)((?:[\s\S]*[^\n])?)(\n*)$/);
			if (joined.at(-1) && leading) {
				leading = '\n'.repeat(Math.min(2, Math.max(joined.pop().length, leading.length)));
			}
			joined.push(leading, content, trailing);
		}
		text = joined.join('');
	}
	const convert = convertFor(name);
	return convert ? convert(node, text, tags) : text;
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (text) => strip(text).split(ALL_WS).join(' ').toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-');

/** Point in-page links at GitHub's heading anchors; Blizzard's ids (item1) don't exist in Markdown. An id on a section
 * (a tab pane, say) points at the first heading inside it. */
function fixAnchors($) {
	const anchors = new Map();
	const seen = new Map();
	$(HEADING_TAGS).each((_, heading) => {
		const base = slug($(heading).text());
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		anchors.set(heading, n ? `${base}-${n}` : base);
	});
	const targets = new Map();
	$('[id]').each((_, el) => {
		const heading = anchors.has(el) ? el : $(el).find(HEADING_TAGS)[0];
		if (heading) {
			targets.set(el.attribs.id, anchors.get(heading));
		}
	});
	$('a[href]').each((_, a) => {
		const id = a.attribs.href.match(/^(?:\/news\/\d+)?#([^\n]+)$/)?.[1];
		if (targets.has(id)) {
			a.attribs.href = `#${targets.get(id)}`;
		}
	});
}

/** A <br> that ends its block (only whitespace after it) would render as a stray backslash. */
function dropTrailingBreaks($) {
	$('br').each((_, br) => {
		const after = [];
		for (let at = br.next; at; at = at.next) {
			after.push(at);
		}
		if (after.every((sib) => sib.name === 'br' || (!isTag(sib) && strip(sib.data ?? '') === ''))) {
			$(br).remove();
		}
	});
}

/** Article body HTML to normalised Markdown, one block per line so diffs stay line-level. */
export function toMarkdown(bodyHtml) {
	const $ = cheerio.load(bodyHtml, { xml: { xmlMode: false } });
	$('script, style').remove();
	fixAnchors($);
	dropTrailingBreaks($);
	const text = processTag($.root()[0], new Set())
		.split(LINE_BREAKS)
		// Two trailing spaces are the invisible hard line break; everything else is trimmed.
		.map((line) => rstrip(line) + (line.endsWith('  ') && strip(line) ? '  ' : ''))
		.join('\n')
		.replace(/^(#+) \*\*(.+)\*\*$/gm, '$1 $2'); // bold inside a heading adds nothing
	return strip(text.replace(/\n{3,}/g, '\n\n')) + '\n';
}
