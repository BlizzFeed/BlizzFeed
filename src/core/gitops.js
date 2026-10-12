import { execFileSync } from 'node:child_process';

export function git(dir, ...args) {
	try {
		return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (error) {
		throw new Error(`git ${args.join(' ')} failed: ${(error.stderr ?? error.message).trim()}`);
	}
}

/** Commits only the given paths. The new SHA, or null if nothing changed. */
export function commitPaths(dir, paths, message) {
	git(dir, 'add', '--', ...paths);
	if (!git(dir, 'status', '--porcelain', '--', ...paths)) {
		return null;
	}
	git(dir, 'commit', '-m', message, '--', ...paths);
	return git(dir, 'rev-parse', 'HEAD');
}

/** A plain push, no rebase: a rebase would rewrite the SHAs the messages link to. The workflow's concurrency group
 * prevents overlapping runs; a rejected push fails the run, and the next run redoes the same changes. */
export const push = (dir) => git(dir, 'push');
