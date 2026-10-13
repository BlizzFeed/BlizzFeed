import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yd from './youtube_differ.js';

const T0 = '2026-10-12T10:00:00Z';
const T1 = '2026-10-12T10:02:00Z';

const video = (id = 'a', fields = {}) => ({
	id, title: id.toUpperCase(), description: 'About', published: '2026-10-12T09:00:00Z', kind: 'video', premiere: false, duration: 60, live: 'none', scheduled: null, started: null, ended: null, thumbnail: 't.jpg', ...fields,
});
const entry = (v) => ({ id: v.id, title: v.title, description: v.description });
const details = (...videos) => new Map(videos.map((v) => [v.id, v]));
const run = (old, listed, fetched = listed, now = T1) => yd.sweep(old, listed.map(entry), details(...fetched), now);
const baseline = (...videos) => run(null, videos, videos, T0)[0];
const types = (changes) => changes.map((c) => c.type);

test('a first run records everything and reports nothing', () => {
	const [state, changes] = run(null, [video('a'), video('b')]);
	assert.deepEqual(changes, []);
	assert.deepEqual(Object.keys(state.videos).sort(), ['a', 'b']);
});

test('new videos are reported oldest first, and an unchanged channel reports nothing', () => {
	const state = baseline(video('a'));
	const [c, b] = [video('c', { published: '2026-10-12T09:30:00Z' }), video('b', { published: '2026-10-12T09:10:00Z' })];
	const [, changes] = run(state, [c, b, video('a')], [c, b]);
	assert.deepEqual(changes.map((c) => c.id), ['b', 'c']);
	assert.deepEqual(run(state, [video('a')], [])[1], []);
});

test('a title or description edit is reported with what changed, and then stored', () => {
	const state = baseline(video('a'));
	const [next, changes] = run(state, [video('a', { title: 'New', description: 'About' })], []);
	assert.deepEqual(types(changes), ['edited']);
	assert.deepEqual([changes[0].title, changes[0].fields], ['New', { title: { from: 'A', to: 'New' } }]);
	assert.equal(next.videos.a.title, 'New');
	assert.deepEqual(run(next, [video('a', { title: 'New' })], [])[1], []);
});

test('a stream is followed from scheduled to live to ended', () => {
	const scheduled = video('s', { kind: 'stream', live: 'upcoming', scheduled: '2026-10-13T18:00:00Z' });
	const state = baseline(scheduled);
	const [moved, rescheduled] = run(state, [scheduled], [{ ...scheduled, scheduled: '2026-10-13T19:00:00Z' }]);
	assert.deepEqual(types(rescheduled), ['rescheduled']);
	const [live, started] = run(moved, [scheduled], [{ ...scheduled, scheduled: '2026-10-13T19:00:00Z', live: 'live', started: 'x' }]);
	assert.deepEqual([types(started), started[0].from, started[0].to], [['live'], 'upcoming', 'live']);
	const [, ended] = run(live, [scheduled], [{ ...scheduled, scheduled: '2026-10-13T19:00:00Z', live: 'ended', started: 'x', ended: 'y' }]);
	assert.equal(ended[0].to, 'ended');
});

test('a stream pushed out of the newest uploads is still followed, and one that vanished is dropped', () => {
	const stream = video('s', { kind: 'stream', live: 'live' });
	const state = baseline(stream);
	assert.deepEqual(yd.needsDetails(state, [entry(video('x'))]), ['x', 's']);
	const [next, changes] = run(state, [video('x')], [video('x'), { ...stream, live: 'ended' }]);
	assert.deepEqual(types(changes), ['new', 'live']);
	assert.deepEqual(yd.needsDetails(next, [entry(video('x'))]), []);
	const [gone] = run(state, [video('x')], [video('x')]);
	assert.ok(gone.videos.s.removed);
	assert.deepEqual(yd.needsDetails(gone, []), []);
});

test('details are asked for every listed video only on a baseline', () => {
	assert.deepEqual(yd.needsDetails(null, [entry(video('a')), entry(video('b'))]), ['a', 'b']);
	assert.deepEqual(yd.needsDetails(baseline(video('a')), [entry(video('a'))]), []);
});

test('a text file is written for new and edited videos only', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-'));
	t.after(() => fs.rmSync(dir, { recursive: true }));
	const [first] = run(null, [video('a'), video('b')]);
	yd.writeChannel(dir, 'Warcraft', first, [], true);
	assert.equal(fs.readFileSync(path.join(dir, 'Warcraft', 'a.md'), 'utf8'), '# A\n\nAbout\n');
	fs.rmSync(path.join(dir, 'Warcraft', 'b.md'));
	const [second, changes] = run(first, [video('a', { description: 'Edited' }), video('b')], []);
	yd.writeChannel(dir, 'Warcraft', second, changes, false);
	assert.equal(fs.readFileSync(path.join(dir, 'Warcraft', 'a.md'), 'utf8'), '# A\n\nEdited\n');
	assert.ok(!fs.existsSync(path.join(dir, 'Warcraft', 'b.md')));
	assert.deepEqual(yd.loadState(dir, 'Warcraft'), second);
});

test('a list that lags the video does not read as an edit, since the video itself settles it', () => {
	const state = baseline(video('a', { description: 'New text' }));
	const stale = [{ id: 'a', title: 'A', description: 'Old text' }];
	assert.deepEqual(yd.needsDetails(state, stale), ['a']);
	assert.deepEqual(yd.sweep(state, stale, details(video('a', { description: 'New text' })), T1)[1], []);
	const [, changes] = yd.sweep(baseline(video('a')), [{ id: 'a', title: 'A', description: 'Edited' }], details(video('a', { description: 'Edited' })), T1);
	assert.deepEqual(types(changes), ['edited']);
});

test('a premiere stays one after it ends, when it looks like any other stream', () => {
	const scheduled = video('p', { kind: 'stream', live: 'upcoming', premiere: true });
	const [next] = run(baseline(scheduled), [scheduled], [{ ...scheduled, live: 'ended', premiere: false }]);
	assert.equal(next.videos.p.premiere, true);
});
