// Rewrites branch files through stringify and reports any that differ.
// Usage: node scripts/parity-json.js [--sort-keys] <file>...
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { stringify } from '../src/json.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'sort-keys': { type: 'boolean' } } });

let bad = 0;
for (const file of positionals) {
	const original = fs.readFileSync(file, 'utf8');
	if (original !== stringify(JSON.parse(original), { sortKeys: values['sort-keys'] })) {
		bad++;
		console.log(`DIFFERS  ${file}`);
	}
}
console.log(`${positionals.length - bad}/${positionals.length} identical`);
process.exit(bad ? 1 : 0);
