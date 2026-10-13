import test from 'node:test';
import assert from 'node:assert/strict';
import { blurb, buildVideoMessage, length } from './youtube_messages.js';

const video = (fields = {}) => ({
	id: 'abc', title: 'A title', description: 'About it', published: '2026-10-12T09:00:00Z', kind: 'video', duration: 141, live: 'none',
	scheduled: null, started: null, ended: null, thumbnail: 't.jpg', ...fields,
});
const channel = { name: 'Diablo', logo: 'logo.png' };
const body = (message) => message.components[0];
const texts = (message) => JSON.stringify(body(message).components);
const buttons = (message) => body(message).components.find((c) => c.type === 1).components;

test('a description shows its first paragraph of real text, cut at a word', () => {
	assert.equal(blurb('First.\n\nSecond.'), 'First.');
	assert.equal(blurb('https://a.com #tag\n\nThe real text.'), 'The real text.');
	assert.equal(blurb('For more information, visit Blizzard.com.\r\n\r\nLike Blizzard on Facebook: x'), '');
	assert.equal(blurb(''), '');
	const long = blurb('word '.repeat(100));
	assert.ok(long.length <= 281 && long.endsWith('word…'));
});

test('lengths read as m:ss, or h:mm:ss past an hour', () => {
	assert.deepEqual([length(29), length(141), length(30271)], ['0:29', '2:21', '8:24:31']);
});

test('a post without a description or a thumbnail leaves those out instead of showing blanks', () => {
	const bare = buildVideoMessage(video({ description: '', thumbnail: null }), channel);
	assert.deepEqual(body(bare).components.map((c) => c.type), [9, 14, 14, 1, 14, 10]);
});

test('a Short links to its Shorts page, and a stream has a button for each phase', () => {
	assert.ok(buttons(buildVideoMessage(video({ kind: 'short' }), channel))[0].url.includes('/shorts/abc'));
	const stream = { kind: 'stream', scheduled: '2026-10-18T16:30:00Z', started: '2026-10-18T16:35:00Z', ended: '2026-10-18T20:00:00Z' };
	const labels = ['upcoming', 'live', 'ended'].map((live) => buttons(buildVideoMessage(video({ ...stream, live }), channel))[0].label);
	assert.deepEqual(labels, ['YouTube', 'Watch live', 'Watch the VOD']);
});

test('a title edit and a description edit together are one orange post with both changes', () => {
	const change = { fields: { title: { from: 'Old', to: 'A title' }, description: { from: 'One\nTwo', to: 'One\nTwo\nThree' } } };
	const message = buildVideoMessage(video(), channel, { change, commitUrl: 'https://c' });
	assert.equal(body(message).accent_color, 0xFAA61A);
	const shown = texts(message);
	assert.ok(shown.includes('Title and description changed') && shown.includes('- Old') && shown.includes('+ A title') && shown.includes('+ 1 line added'));
	assert.equal(buttons(message)[1].label, 'Description Changes');
});

test('a stream with a time YouTube left out shows no broken timestamp', () => {
	const ended = texts(buildVideoMessage(video({ kind: 'stream', live: 'ended', started: null, ended: null }), channel));
	assert.ok(ended.includes('Stream ended') && !ended.includes('NaN'));
});

test('a premiere is named as one in each phase, and its recording is just the video', () => {
	const premiere = { kind: 'stream', premiere: true, scheduled: '2026-10-18T16:30:00Z', started: '2026-10-18T16:30:00Z', ended: '2026-10-18T16:33:00Z' };
	const said = ['upcoming', 'live', 'ended'].map((live) => texts(buildVideoMessage(video({ ...premiere, live }), channel)));
	assert.ok(said[0].includes('Premiere scheduled') && said[1].includes('Premiering now') && said[2].includes('Premiered'));
	assert.equal(buttons(buildVideoMessage(video({ ...premiere, live: 'ended' }), channel))[0].label, 'YouTube');
});
