#!/usr/bin/env python3
"""Run one launch item in a disposable worktree. Usage: crsi_team_driver.py CONFIG.json

Required paths: repository, stateDir (outside the checkout), backlog, battery
(tracked, repo-relative). upstream names the ref that sync refreshes. sync,
scan, build and runner are argv arrays. scan prints open PRs as "- #... files:
path ..." or exactly "no open PRs". runner consumes the substituted harness battery and receives its
receipt directory through a literal {out} argument. Its summary.json must
record a completed LIVE turn with at least one task. verify may name a separate acceptance command.
timeoutSeconds bounds each process. Optional dependencyDir supplies node_modules.
maxAttempts limits claimed attempts per item (default two). Invoke again for the next turn.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import uuid

ITEM = re.compile(r"^- (L\d+) (\S+) (#\d+) \| files: ([^|]*)\| test: ([^|]*)\| (.+)$")


class Stop(Exception):
    pass


def run(label, argv, cwd, timeout):
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise Stop(f"{label} requires an argument array")
    with subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=True) as proc:
        try:
            stdout, _ = proc.communicate(timeout=timeout)
        except BaseException:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            raise
        if proc.returncode:
            raise Stop(f"{label} failed (exit {proc.returncode})")
        return stdout


def atomic(path, text):
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as tmp:
        try:
            tmp.write(text)
            tmp.flush()
            os.replace(tmp.name, path)
        finally:
            Path(tmp.name).unlink(missing_ok=True)


def safe_path(value):
    path = Path(value)
    if not value or path.is_absolute() or ".." in path.parts or path == Path("."):
        raise Stop("expected a repository-relative file")
    return path


def select_item(text, scan, attempts, limit):
    busy = set()
    found = False
    for line in scan.splitlines():
        if line.startswith("- #"):
            if "files:" not in line or not line.split("files:", 1)[1].strip():
                raise Stop("scan omitted files for an open PR")
            found = True
            busy.update(safe_path(v) for v in line.split("files:", 1)[1].split())
    if not found and scan.strip() != "no open PRs":
        raise Stop("scan did not confirm open PR coverage")
    items = []
    seen = set()
    for line in text.splitlines():
        if not re.match(r"^- L\d+\b", line):
            continue
        m = ITEM.fullmatch(line)
        if not m or m[1] in seen:
            raise Stop("malformed or duplicate launch item")
        seen.add(m[1])
        files = [safe_path(v.strip()) for v in m[4].split(",") if v.strip()]
        if m[2] == "open" and attempts.get(m[1], 0) < limit and files and not any(
            p == q or p in q.parents or q in p.parents for p in files for q in busy
        ):
            items.append((line, m[1], m[3], files, m[5].strip(), m[6].strip()))
    return next(iter(items), None)


def update_item(backlog, expected, replacement, note=None):
    text = backlog.read_text()
    lines = text.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines) if line.rstrip("\n") == expected]
    if len(matches) != 1:
        raise Stop("backlog claim changed; inspect the turn")
    i = matches[0]
    lines[i] = replacement + ("\n" if lines[i].endswith("\n") else "")
    if note:
        text = "".join(lines).rstrip("\n")
        lines = text.split("\n")
        pos = next((i for i, line in enumerate(lines) if line.startswith("## Turn log")), None)
        if pos is None:
            lines.extend(["", "## Turn log", note])
        else:
            end = next((i for i in range(pos + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
            lines.insert(end, note)
        lines = ["\n".join(lines) + "\n"]
    atomic(backlog, "".join(lines))


def turn(cfg, state_dir, backlog):
    repo = Path(cfg["repository"]).resolve(strict=True)
    timeout = int(cfg["timeoutSeconds"])
    if timeout <= 0 or state_dir == repo or repo in state_dir.parents:
        raise Stop("require a positive timeout and a state directory outside the checkout")

    def git(cwd, *args):
        return run("git " + args[0], ["git", *args], cwd, timeout).rstrip("\n")

    if git(repo, "status", "--porcelain"):
        raise Stop("dirty repository")
    run("sync", cfg["sync"], repo, timeout)
    upstream = git(repo, "rev-parse", "--verify", "--end-of-options", cfg["upstream"] + "^{commit}")
    scan = run("scan", cfg["scan"], repo, timeout)
    receipt = state_dir / "state.json"
    state = json.loads(receipt.read_text()) if receipt.exists() else {"turns": []}
    attempts = state.setdefault("attempts", {})
    limit = int(cfg.get("maxAttempts", 2))
    if limit < 1:
        raise Stop("maxAttempts must be positive")
    item = select_item(backlog.read_text(), scan, attempts, limit)
    if not item:
        return
    line, ident, issue, files, acceptance, title = item
    turn_id = uuid.uuid4().hex
    taken = line.replace(" open ", " taken:" + turn_id + " ", 1)
    work = state_dir / turn_id
    git(repo, "worktree", "add", "--detach", str(work), "HEAD")
    claimed = False
    candidate = None
    linked_dependencies = None
    try:
        git(work, "merge", "--no-edit", upstream)
        base = git(work, "rev-parse", "HEAD")
        if cfg.get("dependencyDir"):
            linked_dependencies = Path(cfg["dependencyDir"]).resolve(strict=True)
            (work / "node_modules").symlink_to(linked_dependencies, target_is_directory=True)
        run("build", cfg["build"], work, timeout)
        update_item(backlog, line, taken)
        claimed = True
        attempts[ident] = attempts.get(ident, 0) + 1
        atomic(receipt, json.dumps(state, indent=2) + "\n")
        battery = safe_path(cfg["battery"])
        git(work, "ls-files", "--error-unmatch", "--", str(battery))
        if (work / battery).resolve(strict=True) != work / battery:
            raise Stop("battery must be a tracked regular file inside the trial")
        pack = json.loads((work / battery).read_text())
        pack["tasks"] = [{"id": "launch-" + ident.lower(), "kind": "self-improve", "productCandidate": True,
                          "brief": f"{issue} {title}\nAcceptance test: {acceptance}\nFiles: {', '.join(map(str, files))}",
                          "successCriteria": ["verified-edit-landed", "build-or-typecheck-invoked",
                                              "rollback-available-on-failure"]}]
        (work / battery).write_text(json.dumps(pack) + "\n")
        out = state_dir / ("run-" + turn_id)
        out.mkdir()
        if "{out}" not in cfg["runner"]:
            raise Stop("runner requires a {out} receipt directory argument")
        args = [str(out) if a == "{out}" else a for a in cfg["runner"]]
        run("runner", args, work, timeout)
        try:
            summary = json.loads((out / "summary.json").read_text())
            tasks = summary["metrics"]["n"]
            if summary["mode"] != "live" or type(tasks) is not int or tasks <= 0:
                raise ValueError()
        except (OSError, KeyError, TypeError, ValueError):
            raise Stop("runner did not produce a completed live summary") from None
        git(work, "restore", "--source=" + base, "--staged", "--worktree", "--", str(battery))
        if cfg.get("verify"):
            run("verify", cfg["verify"], work, timeout)
        run("build", cfg["build"], work, timeout)
        if linked_dependencies is not None:
            link = work / "node_modules"
            if not link.is_symlink() or link.readlink() != linked_dependencies:
                raise Stop("runner changed the dependency link")
            link.unlink()
        paths = git(work, "diff", "--name-only", "--no-renames", "-z", base, "--")
        others = git(work, "ls-files", "--others", "--exclude-standard", "-z")
        changed = {Path(p) for p in (paths + others).split("\0") if p}
        if not changed:
            raise Stop("runner produced no candidate")
        for p in changed:
            if not any(p == f or f in p.parents for f in files):
                raise Stop(f"runner changed unrelated file {p}")
        git(work, "--literal-pathspecs", "add", "-A", "--", *map(str, sorted(changed)))
        tree = git(work, "write-tree")
        sha = git(work, "commit-tree", tree, "-p", base, "-m", f"fix: candidate for {ident} {issue}")
        ref = "refs/heads/crsi/turn-" + turn_id
        git(work, "update-ref", ref, sha, "")
        candidate = sha
        update_item(backlog, taken, line.replace(" open ", f" candidate:{sha[:12]} ", 1),
                    f"- {ident} {issue} | candidate {sha} | {ref}")
        record = {"item": ident, "issue": issue, "candidate": sha, "ref": ref, "base": base}
        state["turns"].append(record)
        atomic(receipt, json.dumps(state, indent=2) + "\n")
    finally:
        try:
            if claimed and candidate is None:
                update_item(backlog, taken, line)
        finally:
            git(repo, "worktree", "remove", "--force", str(work))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    try:
        cfg = json.loads(args.config.read_text())
        state_dir = Path(cfg["stateDir"]).resolve()
        backlog = Path(cfg["backlog"]).resolve(strict=True)
        state_dir.mkdir(parents=True, exist_ok=True)
        with backlog.with_name(backlog.name + ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                turn(cfg, state_dir, backlog)
            except (Stop, OSError, KeyError, ValueError, subprocess.TimeoutExpired) as exc:
                atomic(state_dir / "last-stop.json", json.dumps({"reason": str(exc)}) + "\n")
                raise
        return 0
    except (Stop, OSError, KeyError, ValueError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
