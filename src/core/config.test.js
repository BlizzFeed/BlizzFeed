import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShopConfig, loadSources, loadYoutubeConfig, youtubeSweepMinutes } from './config.js';

test('an unquoted channel ID stops the run instead of losing its last digits', (t) => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'config-')), 'sources.yaml');
	t.after(() => fs.rmSync(path.dirname(file), { recursive: true }));
	const write = (channels, shop) => fs.writeFileSync(file, `channels:\n  WOW: ${channels}\nshop:\n  channel: ${shop}\nsources:\n  - {id: wow, type: json, url: "https://x/en-gb/f", channels: WOW}\n`);
	write('{all: "1555101974746103818"}', '"1557956587790934078"');
	assert.deepEqual(loadSources(file)[0].tierChannels.all, ['1555101974746103818']);
	assert.equal(loadShopConfig(file).channel, '1557956587790934078');
	write('{all: 1555101974746103818}', '"1"');
	assert.throws(() => loadSources(file), /channels\.WOW\.all in quotes/);
	write('{all: "1"}', '1557956587790934078');
	assert.throws(() => loadShopConfig(file), /shop\.channel in quotes/);
});

test('the youtube block is checked against the channel labels, and the sweep follows the channel count', (t) => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'config-')), 'sources.yaml');
	t.after(() => fs.rmSync(path.dirname(file), { recursive: true }));
	const id = 'UC' + 'a'.repeat(22);
	const write = (channel) => fs.writeFileSync(file, `channels:\n  WOW: {all: "1"}\nyoutube:\n  channels:\n    A: {id: ${id}, ${channel}}\nsources: []\n`);
	write('feeds: [WOW]');
	const config = loadYoutubeConfig(file);
	assert.deepEqual(config.channels.A.kinds, ['video', 'short', 'stream']);
	assert.equal(youtubeSweepMinutes(config), 2);
	assert.equal(youtubeSweepMinutes({ min_sweep_minutes: 2, daily_units: 9000, channels: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [i, {}])) }), 4);
	write('feeds: [WOWW]');
	assert.throws(() => loadYoutubeConfig(file), /"WOWW", which isn't under channels/);
	write('kinds: [clip]');
	assert.throws(() => loadYoutubeConfig(file), /kinds has "clip"/);
	write('logo: World_Of_Warcraft');
	assert.throws(() => loadYoutubeConfig(file), /logo "World_Of_Warcraft" isn't a logo name/);
	write('logo: diablo-4');
	assert.equal(loadYoutubeConfig(file).channels.A.logo, 'https://raw.githubusercontent.com/BlizzFeed/BlizzFeed/main/logos/games/diablo-4.png');
	write('routes: [{match: x, feeds: [WOWW]}]');
	assert.throws(() => loadYoutubeConfig(file), /routes\[0\]\.feeds has "WOWW"/);
	write('routes: [{feeds: [WOW]}]'); // would match every title
	assert.throws(() => loadYoutubeConfig(file), /routes\[0\] has no match/);
	write('routes: [{match: "Diablo (", feeds: [WOW]}]');
	assert.throws(() => loadYoutubeConfig(file), /routes\[0\]\.match isn't a valid pattern/);
});
