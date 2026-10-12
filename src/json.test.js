import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from './json.js';

test('sortKeys sorts nested keys, arrays keep their order', () => {
	assert.equal(stringify({ b: 1, a: [{ d: 1, c: 2 }] }, { sortKeys: true }), '{\n  "a": [\n    {\n      "c": 2,\n      "d": 1\n    }\n  ],\n  "b": 1\n}\n');
});

test('sortKeys sorts article ids as text, like Python, though a JS object puts them in number order', () => {
	assert.equal(stringify({ 100000000: 'b', 99999999: 'a', x: {}, y: [] }, { sortKeys: true }), '{\n  "100000000": "b",\n  "99999999": "a",\n  "x": {},\n  "y": []\n}\n');
});
