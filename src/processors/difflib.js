// A port of Python's difflib.SequenceMatcher (without its junk heuristics), so the archive's line counts stay the same.

/** The longest block a[i..i+size] equal to b[j..j+size] within the ranges, as [i, j, size]; the first such block. */
function longestMatch(a, positions, alo, ahi, blo, bhi) {
	let [besti, bestj, bestsize] = [alo, blo, 0];
	let runs = new Map(); // j: length of the match ending at a[i - 1], b[j]
	for (let i = alo; i < ahi; i++) {
		const next = new Map();
		for (const j of positions.get(a[i]) ?? []) {
			if (j < blo) {
				continue;
			}
			if (j >= bhi) {
				break;
			}
			const k = (runs.get(j - 1) ?? 0) + 1;
			next.set(j, k);
			if (k > bestsize) {
				[besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
			}
		}
		runs = next;
	}
	return [besti, bestj, bestsize];
}

/** [[tag, i1, i2, j1, j2]] turning a into b: 'equal', 'replace', 'delete' or 'insert'. */
export function opcodes(a, b) {
	const positions = new Map();
	b.forEach((line, j) => positions.set(line, [...(positions.get(line) ?? []), j]));
	const blocks = [];
	const queue = [[0, a.length, 0, b.length]];
	while (queue.length) {
		const [alo, ahi, blo, bhi] = queue.pop();
		const [i, j, k] = longestMatch(a, positions, alo, ahi, blo, bhi);
		if (k) {
			blocks.push([i, j, k]);
			if (alo < i && blo < j) {
				queue.push([alo, i, blo, j]);
			}
			if (i + k < ahi && j + k < bhi) {
				queue.push([i + k, ahi, j + k, bhi]);
			}
		}
	}
	blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const joined = []; // adjacent blocks as one
	for (const [i, j, k] of blocks) {
		const last = joined.at(-1);
		if (last && last[0] + last[2] === i && last[1] + last[2] === j) {
			last[2] += k;
		} else {
			joined.push([i, j, k]);
		}
	}
	joined.push([a.length, b.length, 0]);
	const codes = [];
	let [i, j] = [0, 0];
	for (const [ai, bj, size] of joined) {
		const tag = i < ai && j < bj ? 'replace' : i < ai ? 'delete' : j < bj ? 'insert' : '';
		if (tag) {
			codes.push([tag, i, ai, j, bj]);
		}
		[i, j] = [ai + size, bj + size];
		if (size) {
			codes.push(['equal', ai, i, bj, j]);
		}
	}
	return codes;
}
