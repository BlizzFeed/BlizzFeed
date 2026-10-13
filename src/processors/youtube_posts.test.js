import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadYoutubeConfig } from '../core/config.js';
import fs from 'node:fs';
import { feedsFor, logoFor, postFor } from './youtube_posts.js';

const channel = (fields = {}) => ({ feeds: ['WOW', 'WOW_US'], kinds: ['video', 'short', 'stream'], routes: [], ...fields });
const route = (match, feeds) => ({ pattern: new RegExp(match, 'i'), feeds });

test('the first matching route replaces the channel feeds, and no match keeps them', () => {
	const routes = [route('Warcraft III', ['WARCRAFT3']), route('Warcraft', ['NEVER'])];
	assert.deepEqual(feedsFor(channel({ routes }), { kind: 'video', title: 'Warcraft III Reforged | Trailer' }), ['WARCRAFT3']);
	assert.deepEqual(feedsFor(channel({ routes }), { kind: 'video', title: 'Midnight Content Update' }), ['WOW', 'WOW_US']);
});

test('a kind the channel keeps out of the feeds goes nowhere, whatever its title', () => {
	const routes = [route('Warcraft III', ['WARCRAFT3'])];
	assert.deepEqual(feedsFor(channel({ routes, kinds: ['video', 'stream'] }), { kind: 'short', title: 'Warcraft III clip' }), []);
	assert.deepEqual(feedsFor(channel({ routes }), { kind: 'short', title: 'Warcraft III clip' }), ['WARCRAFT3']);
});

// Titles seen on the channels, through the real sources.yaml: a pattern typo there would route them wrong.
test('real titles reach the right game feeds', () => {
	const { channels } = loadYoutubeConfig(fileURLToPath(new URL('../../sources.yaml', import.meta.url)));
	const cases = [
		['Diablo', 'Diablo IV | Lord of Hatred | Making the Music Score', ['DIABLO4', 'DIABLO']],
		['Diablo', 'Diablo | Through the Years', ['DIABLO']],
		['Diablo', 'Diablo | BlizzCon 2026 | ICYMI', ['DIABLO']],
		['Diablo', 'Diablo IV: Season of Hell\'s Legacy | Live Now', ['DIABLO4', 'DIABLO']],
		['Diablo', 'Your Prime Evil awaits', ['DIABLO4', 'DIABLO']],
		['Diablo', 'Diablo III: Reaper of Souls | Season 40', ['DIABLO3', 'DIABLO']],
		['Diablo', 'Diablo II: Resurrected | Ladder Season', ['DIABLO2', 'DIABLO']],
		['Warcraft', 'Warcraft III Reforged: Forsaken Kingdom | Launch Trailer', ['WARCRAFT3']],
		['Warcraft', 'Skyborne Lore & Abilities | World of Warcraft: Forever', ['WOW', 'WOW_US']],
		['Warcraft', 'The Last Titan Teaser | COLOSSAL | World of Warcraft', ['WOW', 'WOW_US']],
		['StarCraft', 'Classic Cup: Warcraft III - Entertainment Match', ['WARCRAFT3']],
		['StarCraft', 'Blizzcon 2026 | Classic Cup: StarCraft Remastered - Legacy Match', ['STARCRAFTREMASTERED']],
		['StarCraft', 'StarCraft II - 10th Anniversary Game Updates', ['STARCRAFT2']],
		['StarCraft', 'STARCRAFT | Announce Cinematic | Dominion', ['STARCRAFT']],
		['StarCraft', 'StarCraft | Co-op Commander: Mengsk', ['STARCRAFT2']], // the old games aren't in capitals
		['Diablo', 'Diablo IV | Lilith Resurrected', ['DIABLO4', 'DIABLO']], // a word from another game's name alone
		['Warcraft', 'Reforged Armor Sets | World of Warcraft', ['WOW', 'WOW_US']],
	];
	for (const [handle, title, feeds] of cases) {
		assert.deepEqual(feedsFor(channels[handle], { kind: 'video', title }), feeds, title);
	}
});

test('a video gets the logo of its game, else of its channel, and every logo is a file we host', () => {
	const { channels } = loadYoutubeConfig(fileURLToPath(new URL('../../sources.yaml', import.meta.url)));
	const file = (handle, title) => logoFor(channels[handle], { title }).split('/').pop();
	assert.equal(file('StarCraft', 'Classic Cup: Warcraft III - Entertainment Match'), 'warcraft-3.png'); // the game, not the channel
	assert.equal(file('Diablo', 'Diablo | Through the Years'), 'diablo-4.png'); // no one game: the channel's
	assert.equal(file('Warcraft', 'Midnight Content Update'), 'world-of-warcraft.png');
	for (const channel of Object.values(channels)) {
		for (const url of [channel.logo, ...channel.routes.map((route) => route.logo)].filter(Boolean)) {
			assert.ok(fs.existsSync(new URL(`../../logos/games/${url.split('/').pop()}`, import.meta.url)), url);
		}
	}
});

test('a stream that goes back to upcoming edits its scheduled post instead of posting again', () => {
	const post = postFor({ type: 'live', from: 'live', to: 'upcoming' }, { id: 'a', kind: 'stream' });
	assert.deepEqual([post.ref, post.edit], ['yt:a:scheduled', true]);
});
