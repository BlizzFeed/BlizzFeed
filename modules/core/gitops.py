import subprocess


def git(data_dir, *args):
    result = subprocess.run(["git", *args], cwd=data_dir, capture_output=True,
                            text=True, encoding="utf-8", timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def commit_paths(data_dir, paths, message):
    """Commit only the given paths. Returns the new SHA, or None if nothing changed."""
    git(data_dir, "add", "--", *paths)
    if not git(data_dir, "status", "--porcelain", "--", *paths):
        return None
    git(data_dir, "commit", "-m", message, "--", *paths)
    return git(data_dir, "rev-parse", "HEAD")


def push(data_dir):
    """Plain push, no rebase: a rebase would rewrite the SHAs the messages link to.

    The workflow's concurrency group prevents overlapping runs. If the push is
    still rejected, fail the run; the next run redoes the same changes from the
    remote state, so nothing is lost or announced without a commit.
    """
    git(data_dir, "push")
