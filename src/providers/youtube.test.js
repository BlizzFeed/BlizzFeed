import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { buildVideo, fetchUploads, fetchVideos } from './youtube.js';

const resource = (fields = {}, live) => ({
	id: 'abc', snippet: { title: 'A title', description: '', publishedAt: '2026-10-12T17:00:13Z', liveBroadcastContent: 'none', ...fields },
	...(live && { liveStreamingDetails: live }),
});
const none = new Set();

test('a plain upload is a video, and a Short only when the Shorts playlist lists it', () => {
	assert.equal(buildVideo(resource(), none).kind, 'video');
	assert.equal(buildVideo(resource(), new Set(['abc'])).kind, 'short');
});

test('a stream moves through upcoming, live and ended, and is never a Short', () => {
	const scheduled = { scheduledStartTime: '2026-10-13T18:00:00Z' };
	const upcoming = buildVideo(resource({ liveBroadcastContent: 'upcoming' }, scheduled), new Set(['abc']));
	assert.deepEqual([upcoming.kind, upcoming.live, upcoming.scheduled, upcoming.started], ['stream', 'upcoming', scheduled.scheduledStartTime, null]);
	assert.equal(buildVideo(resource({ liveBroadcastContent: 'live' }, { ...scheduled, actualStartTime: 'x' }), none).live, 'live');
	const ended = buildVideo(resource({}, { ...scheduled, actualStartTime: 'x', actualEndTime: 'y' }), none);
	assert.deepEqual([ended.live, ended.started, ended.ended], ['ended', 'x', 'y']);
});

test('private and deleted uploads are dropped from the list', async (t) => {
	const item = (videoId, title) => ({ snippet: { title, description: '' }, contentDetails: { videoId } });
	t.mock.method(globalThis, 'fetch', async () => Response.json({ items: [item('a', 'Real'), item('b', 'Private video'), item('c', 'Deleted video')] }));
	assert.deepEqual(await fetchUploads('KEY', 'UC' + 'x'.repeat(22)), [{ id: 'a', title: 'Real', description: '' }]);
});

test('more than 50 ids are fetched in batches', async (t) => {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url) => {
		const ids = new URL(url).searchParams.get('id').split(',');
		calls.push(ids.length);
		return Response.json({ items: ids.map((id) => ({ id })) });
	});
	const found = await fetchVideos('KEY', Array.from({ length: 120 }, (_, i) => `v${i}`));
	assert.deepEqual(calls, [50, 50, 20]);
	assert.equal(found.size, 120);
});

test('the API key never shows in an error, and the reason Google gives does', async (t) => {
	const body = JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } });
	t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 403, statusText: 'Forbidden' }));
	await assert.rejects(fetchUploads('SECRETKEY', 'UC' + 'x'.repeat(22)), (error) => error.message === 'playlistItems 403: quotaExceeded');
});

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8'));

test('real API responses build into the kinds and phases they show on YouTube', () => {
	const shorts = new Set(fixture('youtube-shorts.json').items.map((item) => item.contentDetails.videoId));
	const videos = Object.fromEntries(fixture('youtube-videos.json').items.map((resource) => [resource.id, buildVideo(resource, shorts)]));
	assert.deepEqual([videos['phxy5Gat_Gs'].kind, videos['phxy5Gat_Gs'].live], ['video', 'none']);
	assert.equal(videos['NYTy-KF05rM'].kind, 'short');
	assert.deepEqual([videos['3ZK1AJ3kZMY'].kind, videos['3ZK1AJ3kZMY'].live, videos['3ZK1AJ3kZMY'].started], ['stream', 'upcoming', null]);
	assert.deepEqual([videos['Duqv2j_7XSg'].live, Boolean(videos['Duqv2j_7XSg'].started), Boolean(videos['Duqv2j_7XSg'].ended)], ['ended', true, true]);
	assert.equal(videos['Bv16SAgjQGY'].description, '');
	assert.deepEqual([videos['phxy5Gat_Gs'].duration, videos['3ZK1AJ3kZMY'].duration], [79, 0]);
	assert.ok(videos['Duqv2j_7XSg'].duration > 7 * 3600);
	assert.ok(Object.values(videos).every((video) => video.thumbnail?.startsWith('https://')));
});

test('a stream with a length before it ends is a premiere, and a livestream is not', () => {
	const premiere = { ...resource({ liveBroadcastContent: 'upcoming' }, { scheduledStartTime: 'x' }), contentDetails: { duration: 'PT2M21S' } };
	const livestream = { ...resource({ liveBroadcastContent: 'upcoming' }, { scheduledStartTime: 'x' }), contentDetails: { duration: 'P0D' } };
	assert.deepEqual([buildVideo(premiere, none).premiere, buildVideo(livestream, none).premiere], [true, false]);
});
