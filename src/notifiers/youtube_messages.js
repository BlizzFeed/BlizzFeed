import * as d from './discord.js';
import { lineChanges } from '../processors/archiver.js';

const MAX_BLURB = 280;
// Not worth showing as a description: links or hashtags only, and Blizzard's stock lines on its streams.
const BOILERPLATE = /^(https?:\/\/\S+|[#@]\S+|\s)+$|^(For more information|Like Blizzard on|Follow |Subscribe)/i;

// A line break after a word or a comma is a hard wrap in the middle of a sentence; one after "." or "!" is meant, and so is one before a list item.
const HARD_WRAP = /([\p{L}\p{N},])\n(?![-•*]|\d+[.)])/gu;

/** The first paragraph of real text in a description, hard wraps joined, cut at a word. Empty when there is none. */
export function blurb(description) {
	const found = description.replaceAll('\r\n', '\n').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !BOILERPLATE.test(p)) ?? '';
	const first = found.replace(HARD_WRAP, '$1 ');
	return first.length <= MAX_BLURB ? first : `${first.slice(0, MAX_BLURB).replace(/\s+\S*$/, '')}…`;
}

/** 2:21, or 8:24:31 past an hour. */
export function length(total) {
	const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
	const two = (n) => String(n).padStart(2, '0');
	return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export const watchUrl = (video) => `https://www.youtube.com/${video.kind === 'short' ? 'shorts/' : 'watch?v='}${video.id}`;
const time = (iso, style) => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;
const lines = (...parts) => parts.filter(Boolean).join('\n');

/** What the post says first, its footer word and time, its button, and its colour, from the video's kind and phase. */
function status(video, channel) {
	const [name, long] = [channel.name, length(video.duration)];
	if (video.kind === 'stream') {
		// A premiere is a finished video shown at a set time, so its length is known from the start and its recording is the video.
		const words = video.premiere
			? { upcoming: `🗓️ **Premiere scheduled** · ${name} · ${long}`, live: `🔴 **Premiering now** · ${name} · ${long}`, ended: `🎬 **Premiered** · ${name} · ${long}`, watch: 'Watch now', recording: 'YouTube' }
			: { upcoming: `🗓️ **Livestream scheduled** · ${name}`, live: `🔴 **Live now** · ${name}`, ended: `⏹️ **Stream ended** · ${name} · ${long}`, watch: 'Watch live', recording: 'Watch the VOD' };
		// A time YouTube leaves out (a stream that never started) is left out of the post too.
		const states = {
			upcoming: { info: lines(words.upcoming, video.scheduled && `Starts ${time(video.scheduled, 'F')} (${time(video.scheduled, 'R')})`),
				foot: ['Scheduled', video.published], button: 'YouTube' },
			live: { info: lines(words.live, video.started && `Started ${time(video.started, 'R')}`),
				foot: ['Live since', video.started ?? video.published], button: words.watch },
			ended: { info: lines(words.ended, video.started && video.ended && `${time(video.started, 'f')} to ${time(video.ended, 't')}`),
				foot: ['Ended', video.ended ?? video.published], button: words.recording },
		};
		return { ...states[video.live], color: d.COLORS.stream };
	}
	const [emoji, word] = video.kind === 'short' ? ['📱', 'New Short'] : ['🎬', 'New video'];
	return { info: `${emoji} **${word}** · ${name} · ${long}`, foot: ['Posted', video.published], button: 'YouTube', color: d.COLORS.added };
}

/** A ```diff block of what an edit changed: the old and new title, and the description's line counts. */
function editLines(fields) {
	const lines = [];
	if (fields.title) {
		lines.push(`- ${d.trim(fields.title.from, 100)}`, `+ ${d.trim(fields.title.to, 100)}`);
	}
	if (fields.description) {
		const [added, changed, removed] = lineChanges(fields.description.from.replaceAll('\r\n', '\n'), fields.description.to.replaceAll('\r\n', '\n'));
		lines.push(...d.lineCountLines({ added, changed, removed }));
	}
	return lines;
}

/** A video, Short or stream post in the state the video is in. With an edit (change.fields), the orange edit post instead:
 * a title and a description edit made together are one post. channel is { name, logo }. */
export function buildVideoMessage(video, channel, { change = null, repoUrl = null, commitUrl = null, now = new Date().toISOString() } = {}) {
	const shown = status(video, channel);
	const edited = change ? Object.keys(change.fields).join(' and ').replace(/^./, (c) => c.toUpperCase()) : null;
	const info = edited ? `✏️ **${edited} changed** · ${channel.name}` : shown.info;
	const head = d.text(`## ${d.trim(video.title, 256)}\n${info}`);
	const inner = [channel.logo ? { type: 9, components: [head], accessory: { type: 11, media: { url: channel.logo }, description: channel.name } } : head, d.DIVIDER];
	const about = blurb(video.description);
	if (about) {
		inner.push(d.text(about));
	}
	if (video.thumbnail) {
		inner.push({ type: 12, items: [{ media: { url: video.thumbnail }, description: d.trim(video.title, 1024) }] });
	}
	const block = change ? d.diffBlock(editLines(change.fields)) : null;
	if (block) {
		inner.push(block);
	}
	const buttons = [d.linkButton(edited ? 'YouTube' : shown.button, watchUrl(video))];
	if (edited && commitUrl) {
		buttons.push(d.linkButton(change.fields.description ? 'Description Changes' : 'Changes', commitUrl));
	}
	const [word, when] = edited ? ['Updated', now] : shown.foot;
	inner.push(d.DIVIDER, { type: 1, id: d.BUTTONS_ID, components: buttons }, d.DIVIDER,
		d.text(`-# ${word} ${d.discordTime(when)} · ${repoUrl ? `[BlizzFeed](${repoUrl})` : 'BlizzFeed'}`, d.FOOTER_ID));
	return { flags: d.IS_COMPONENTS_V2, components: [{ type: 17, accent_color: edited ? d.COLORS.updated : shown.color, components: inner }] };
}
