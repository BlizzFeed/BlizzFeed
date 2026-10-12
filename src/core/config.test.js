import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShopConfig, loadSources } from './config.js';

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
