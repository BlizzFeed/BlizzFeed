import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYoutubeEntries } from './outbox.js';

const tiers = (label) => ({ all: `${label}-all`, new: `${label}-new`, updated: `${label}-updated` });
const channel = (fields = {}) => ({ name: 'Diablo', logo: 'logo.png', feeds: ['DIABLO4', 'DIABLO'], kinds: ['video', 'short', 'stream'], routes: [], ...fields });
const config = (channels = { Diablo: channel() }) => ({ channel: 'yt', stream_edit_days: 14, channels, labels: { DIABLO4: tiers('d4'), DIABLO: tiers('d'), WOW: tiers('wow') } });
const video = (fields = {}) => ({ title: 'T', description: 'About', published: '2026-10-12T09:00:00Z', kind: 'video', duration: 60, live: 'none', scheduled: null, started: null, ended: null, thumbnail: 't.jpg', ...fields });
const run = (changes, stored = {}, cfg = config()) => buildYoutubeEntries(
	{ channels: { Diablo: { commit: 'abc', changes } } }, cfg, { Diablo: { videos: { a: video(stored) } } }, 'https://repo', '2026-10-13T10:00:00Z');
const where = (entries) => entries.map((e) => e.channel).sort();

test('a new video goes to #youtube and the all and new channels of its feeds', () => {
	const entries = run([{ type: 'new', id: 'a' }]);
	assert.deepEqual(where(entries), ['d-all', 'd-new', 'd4-all', 'd4-new', 'yt']);
	assert.ok(entries.every((e) => e.kind === 'video' && !('ref' in e) && e.article === 'a' && e.source === 'youtube:Diablo'));
});

test('an edit goes to the all and updated channels, as a post of its own', () => {
	const entries = run([{ type: 'edited', id: 'a', fields: { title: { from: 'Old', to: 'T' } } }]);
	assert.deepEqual(where(entries), ['d-all', 'd-updated', 'd4-all', 'd4-updated', 'yt']);
	assert.ok(entries.every((e) => e.kind === 'video_updated' && !e.edit));
});

test('a stream is posted when scheduled and again when live, and its end and a new start time edit those posts', () => {
	const stream = { kind: 'stream', scheduled: '2026-10-18T16:30:00Z', started: '2026-10-18T16:35:00Z', ended: '2026-10-18T20:00:00Z' };
	const first = (changes, live) => run(changes, { ...stream, live })[0];
	assert.deepEqual([first([{ type: 'new', id: 'a' }], 'upcoming').ref, first([{ type: 'new', id: 'a' }], 'upcoming').edit], ['yt:a:scheduled', false]);
	assert.deepEqual([first([{ type: 'live', id: 'a', from: 'upcoming', to: 'live' }], 'live').ref, first([{ type: 'live', id: 'a', from: 'upcoming', to: 'live' }], 'live').edit], ['yt:a:live', false]);
	const ended = first([{ type: 'live', id: 'a', from: 'live', to: 'ended' }], 'ended');
	assert.deepEqual([ended.ref, ended.edit, ended.edit_for], ['yt:a:live', true, 14 * 86400]);
	const moved = first([{ type: 'rescheduled', id: 'a' }], 'upcoming');
	assert.deepEqual([moved.ref, moved.edit], ['yt:a:scheduled', true]);
});

test('a channel with no feeds goes to #youtube only, and a kind it keeps out of its feeds does too', () => {
	assert.deepEqual(where(run([{ type: 'new', id: 'a' }], {}, config({ Diablo: channel({ feeds: [] }) }))), ['yt']);
	assert.deepEqual(where(run([{ type: 'new', id: 'a' }], { kind: 'short' }, config({ Diablo: channel({ kinds: ['video', 'stream'] }) }))), ['yt']);
});

test('the routed feeds replace the channel feeds, and with no #youtube channel set only the feeds get it', () => {
	const routed = channel({ routes: [{ pattern: /Wow/i, feeds: ['WOW'], logo: null }] });
	assert.deepEqual(where(run([{ type: 'new', id: 'a' }], { title: 'Wow news' }, config({ Diablo: routed }))), ['wow-all', 'wow-new', 'yt']);
	assert.deepEqual(where(run([{ type: 'new', id: 'a' }], {}, { ...config(), channel: '' })), ['d-all', 'd-new', 'd4-all', 'd4-new']);
});

test('a change whose video is missing from the saved state is skipped', () => {
	assert.deepEqual(run([{ type: 'new', id: 'gone' }]), []);
});
