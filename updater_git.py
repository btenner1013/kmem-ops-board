#!/usr/bin/env python3
"""Safe Git and same-host locking primitives for the KMEM updater.

The maintained checkout is used only for validation, fetches, and strict
fast-forwards.  Commits which may lose a remote race are created in an
isolated scratch clone so a rejected push never rewrites or dirties local
``main``.
"""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
from urllib.parse import urlparse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional


DEFAULT_FETCH_ATTEMPTS = 3
DEFAULT_GIT_TIMEOUT_SECONDS = 120
SCRATCH_CLOSE_ATTEMPTS = 3
SCRATCH_CLOSE_RETRY_SECONDS = 0.1
STALE_SCRATCH_AGE_SECONDS = 60 * 60
REQUIRED_REPOSITORY_FILES = ("index.html", "update_weather_local.py")
CANONICAL_REPOSITORY = "github.com/btenner1013/kmem-ops-board"
LOGGER = logging.getLogger(__name__)


class GitSafetyError(RuntimeError):
    """Raised when a repository cannot be advanced without risking local work."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class LocalLockUnavailable(RuntimeError):
    """Raised when another updater process already owns the local lock."""


@dataclass(frozen=True)
class SyncOutcome:
    status: str
    local_sha: str
    origin_sha: str
    advanced: bool = False


def normalize_remote_identity(value: str, *, allow_bare_identity: bool = False) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if text.startswith("git@") and ":" in text:
        host_user, path = text.split(":", 1)
        host = host_user.split("@", 1)[-1]
        normalized = f"{host}/{path}"
    else:
        parsed = urlparse(text)
        if parsed.scheme and parsed.hostname:
            scheme = parsed.scheme.lower()
            if scheme not in {"https", "ssh"}:
                return ""
            if parsed.query or parsed.fragment:
                return ""
            if scheme == "ssh":
                if parsed.username != "git" or parsed.password or parsed.port not in {None, 22}:
                    return ""
            elif parsed.username or parsed.password or parsed.port not in {None, 443}:
                return ""
            normalized = f"{parsed.hostname}{parsed.path}"
        elif allow_bare_identity and "/" in text and "\\" not in text and ":" not in text:
            normalized = text
        else:
            return ""
    normalized = normalized.rstrip("/")
    if normalized.lower().endswith(".git"):
        normalized = normalized[:-4]
    return normalized.lower()


def _default_runner(
    command: list[str],
    *,
    cwd: Path,
    env: Optional[dict[str, str]] = None,
) -> subprocess.CompletedProcess:
    process_env = os.environ.copy()
    if env:
        process_env.update(env)
    process_env["GIT_TERMINAL_PROMPT"] = "0"
    process_env["GCM_INTERACTIVE"] = "Never"
    platform_options = {}
    if os.name == "nt":
        platform_options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(
        command,
        cwd=str(cwd),
        env=process_env,
        text=True,
        capture_output=True,
        check=False,
        timeout=DEFAULT_GIT_TIMEOUT_SECONDS,
        **platform_options,
    )


class GitRepository:
    """A narrowly scoped, fast-forward-only view of one ``main`` checkout."""

    def __init__(
        self,
        repo_dir: os.PathLike[str] | str,
        runner: Callable[..., subprocess.CompletedProcess] = _default_runner,
        fetch_attempts: int = DEFAULT_FETCH_ATTEMPTS,
        expected_remote: Optional[str] = None,
    ):
        self.repo_dir = Path(repo_dir).resolve()
        self.runner = runner
        self.fetch_attempts = max(1, int(fetch_attempts))
        self.expected_remote = (
            normalize_remote_identity(expected_remote, allow_bare_identity=True)
            if expected_remote
            else None
        )
        if expected_remote and not self.expected_remote:
            raise ValueError("Expected remote identity is invalid.")

    def run(
        self,
        args: Iterable[str],
        *,
        cwd: Optional[Path] = None,
        env: Optional[dict[str, str]] = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        command = ["git", *list(args)]
        try:
            result = self.runner(command, cwd=cwd or self.repo_dir, env=env)
        except subprocess.TimeoutExpired as error:
            detail = f"Git command timed out after {DEFAULT_GIT_TIMEOUT_SECONDS} seconds."
            if check:
                raise GitSafetyError("GIT_TIMEOUT", detail) from error
            return subprocess.CompletedProcess(command, 124, "", detail)
        if check and result.returncode != 0:
            detail = (result.stderr or result.stdout or "unknown Git error").strip()
            raise GitSafetyError("GIT_COMMAND_FAILED", f"{' '.join(command)}: {detail}")
        return result

    def validate(self) -> None:
        for filename in REQUIRED_REPOSITORY_FILES:
            if not (self.repo_dir / filename).is_file():
                raise GitSafetyError(
                    "WRONG_REPOSITORY",
                    f"Required repository marker is missing: {filename}",
                )

        top = self.run(["rev-parse", "--show-toplevel"]).stdout.strip()
        if os.path.normcase(str(Path(top).resolve())) != os.path.normcase(str(self.repo_dir)):
            raise GitSafetyError(
                "WRONG_REPOSITORY",
                "Updater path is not the root of the expected Git checkout.",
            )

        branch = self.run(["symbolic-ref", "--quiet", "--short", "HEAD"], check=False)
        if branch.returncode != 0 or branch.stdout.strip() != "main":
            raise GitSafetyError("WRONG_BRANCH", "Updater checkout must be on branch main.")

        remote = self.run(["remote", "get-url", "origin"], check=False)
        if remote.returncode != 0 or not remote.stdout.strip():
            raise GitSafetyError("MISSING_ORIGIN", "Git remote origin is not configured.")
        push_remote = self.run(["remote", "get-url", "--push", "origin"], check=False)
        if push_remote.returncode != 0 or not push_remote.stdout.strip():
            raise GitSafetyError("MISSING_ORIGIN", "Git remote origin push URL is not configured.")
        if self.expected_remote:
            fetch_identity = normalize_remote_identity(remote.stdout.strip())
            push_identity = normalize_remote_identity(push_remote.stdout.strip())
            if fetch_identity != self.expected_remote or push_identity != self.expected_remote:
                raise GitSafetyError(
                    "WRONG_REMOTE",
                    "Configured origin does not match the expected KMEM repository.",
                )

        git_dir_text = self.run(["rev-parse", "--absolute-git-dir"]).stdout.strip()
        git_dir = Path(git_dir_text).resolve()
        operation_markers = (
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "BISECT_LOG",
            "rebase-apply",
            "rebase-merge",
        )
        if any((git_dir / marker).exists() for marker in operation_markers):
            raise GitSafetyError(
                "GIT_OPERATION_IN_PROGRESS",
                "CODE SYNC BLOCKED - GIT OPERATION IN PROGRESS",
            )

    def status_lines(self) -> list[str]:
        output = self.run(
            ["status", "--porcelain=v1", "--untracked-files=all"],
        ).stdout
        return [line for line in output.splitlines() if line.strip()]

    def require_clean(self) -> None:
        dirty = self.status_lines()
        if dirty:
            preview = ", ".join(line[3:] if len(line) > 3 else line for line in dirty[:5])
            raise GitSafetyError(
                "DIRTY_WORKTREE",
                f"CODE SYNC BLOCKED - DIRTY WORKTREE ({preview})",
            )

    def fetch(self) -> None:
        last_detail = ""
        for attempt in range(1, self.fetch_attempts + 1):
            result = self.run(
                ["fetch", "--no-tags", "origin", "main"],
                check=False,
            )
            if result.returncode == 0:
                return
            last_detail = (result.stderr or result.stdout or "fetch failed").strip()
            if attempt < self.fetch_attempts:
                time.sleep(0.2 * attempt)
        raise GitSafetyError("FETCH_FAILED", f"GitHub fetch failed: {last_detail}")

    def sha(self, ref: str) -> str:
        result = self.run(["rev-parse", "--verify", ref], check=False)
        if result.returncode != 0 or not result.stdout.strip():
            raise GitSafetyError("MISSING_REF", f"Unable to resolve Git ref {ref}.")
        return result.stdout.strip()

    def is_ancestor(self, older: str, newer: str) -> bool:
        result = self.run(
            ["merge-base", "--is-ancestor", older, newer],
            check=False,
        )
        if result.returncode not in (0, 1):
            detail = (result.stderr or result.stdout or "ancestry check failed").strip()
            raise GitSafetyError("ANCESTRY_FAILED", detail)
        return result.returncode == 0

    def sync(self, *, already_fetched: bool = False) -> SyncOutcome:
        """Fetch and advance only when ``main`` is strictly behind origin/main."""
        self.validate()
        self.require_clean()
        if not already_fetched:
            self.fetch()

        local_sha = self.sha("HEAD")
        origin_sha = self.sha("origin/main")
        if local_sha == origin_sha:
            return SyncOutcome("CODE_CURRENT", local_sha, origin_sha, False)

        if self.is_ancestor(local_sha, origin_sha):
            result = self.run(["merge", "--ff-only", "origin/main"], check=False)
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "fast-forward failed").strip()
                raise GitSafetyError("FAST_FORWARD_FAILED", detail)
            advanced_sha = self.sha("HEAD")
            if advanced_sha != origin_sha:
                raise GitSafetyError(
                    "FAST_FORWARD_FAILED",
                    "Fast-forward completed at an unexpected revision.",
                )
            self.require_clean()
            return SyncOutcome("CODE_FAST_FORWARDED", local_sha, origin_sha, True)

        if self.is_ancestor(origin_sha, local_sha):
            raise GitSafetyError(
                "LOCAL_AHEAD",
                "CODE SYNC BLOCKED - LOCAL MAIN HAS UNIQUE COMMITS",
            )

        raise GitSafetyError(
            "DIVERGED_HISTORY",
            "CODE SYNC BLOCKED - DIVERGED HISTORY",
        )

    def read_json(self, ref: str, relative_path: str) -> Optional[dict]:
        result = self.run(["show", f"{ref}:{relative_path}"], check=False)
        if result.returncode != 0:
            return None
        try:
            value = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def changed_paths(self, older: str, newer: str) -> set[str]:
        result = self.run(["diff", "--name-only", older, newer])
        return {line.strip().replace("\\", "/") for line in result.stdout.splitlines() if line.strip()}

    @property
    def origin_url(self) -> str:
        return self.run(["remote", "get-url", "origin"]).stdout.strip()

    @property
    def origin_push_url(self) -> str:
        return self.run(["remote", "get-url", "--push", "origin"]).stdout.strip()

    def make_scratch_clone(
        self,
        ref: str,
        runtime_root: os.PathLike[str] | str,
    ) -> "ScratchClone":
        return ScratchClone.create(self, ref, runtime_root)


def _scratch_name_is_safe(name: str) -> bool:
    prefix = "scratch-"
    suffix = name[len(prefix):] if name.startswith(prefix) else ""
    return len(suffix) == 32 and all(character in "0123456789abcdef" for character in suffix)


def _scratch_marker_path(candidate: Path) -> Path:
    return candidate / ".git" / ScratchClone.MARKER


def _validated_scratch_path(
    path: os.PathLike[str] | str,
    runtime_root: os.PathLike[str] | str,
    *,
    require_marker: bool,
) -> Path:
    root = Path(runtime_root).resolve()
    raw_candidate = Path(path)
    if raw_candidate.parent.resolve() != root or not _scratch_name_is_safe(raw_candidate.name):
        raise GitSafetyError(
            "UNSAFE_SCRATCH_PATH",
            "Refusing scratch cleanup outside the declared updater runtime root.",
        )

    candidate = raw_candidate.resolve()
    if candidate.parent != root or candidate.name != raw_candidate.name or raw_candidate.is_symlink():
        raise GitSafetyError(
            "UNSAFE_SCRATCH_PATH",
            "Refusing scratch cleanup through a link or unexpected path.",
        )

    if require_marker and candidate.exists():
        marker = _scratch_marker_path(candidate)
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            payload = None
        if (
            not isinstance(payload, dict)
            or payload.get("schemaVersion") != 1
            or payload.get("scratchId") != candidate.name
        ):
            raise GitSafetyError(
                "UNSAFE_SCRATCH_PATH",
                "Refusing to remove an unmarked updater scratch directory.",
            )
    return candidate


def _write_scratch_marker(candidate: Path) -> None:
    marker = _scratch_marker_path(candidate)
    payload = {
        "schemaVersion": 1,
        "scratchId": candidate.name,
        "createdEpoch": int(time.time()),
    }
    marker.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def _cleanup_partial_scratch(path: Path, runtime_root: Path) -> None:
    """Best-effort cleanup which leaves a valid marker if Windows keeps the directory locked."""
    if not path.exists():
        return
    marked = False
    try:
        candidate = _validated_scratch_path(path, runtime_root, require_marker=False)
    except GitSafetyError:
        LOGGER.warning("Partial updater scratch cleanup refused for %s.", path.name)
        return
    if candidate.is_dir():
        try:
            (candidate / ".git").mkdir(exist_ok=True)
            _write_scratch_marker(candidate)
            marked = True
        except OSError:
            marked = False
    try:
        deleted = _remove_scratch_directory(
            candidate,
            runtime_root,
            require_marker=marked,
        )
    except GitSafetyError:
        deleted = False
    if not deleted:
        LOGGER.warning("Partial updater scratch cleanup remains pending for %s.", path.name)


def _scrub_scratch_auth(candidate: Path) -> None:
    """Remove copied Actions transport headers before scratch deletion is attempted."""
    if not (candidate / ".git").exists():
        return
    try:
        listed = _default_runner(
            ["git", "config", "--local", "--name-only", "--get-regexp", r"^http\..*\.extraheader$"],
            cwd=candidate,
        )
    except (OSError, subprocess.TimeoutExpired):
        return
    if listed.returncode not in (0, 1):
        return
    for key in listed.stdout.splitlines():
        key = key.strip()
        if not key:
            continue
        try:
            _default_runner(
                ["git", "config", "--local", "--unset-all", key],
                cwd=candidate,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue


def _rmtree_onerror(function, path, _exc_info) -> None:
    os.chmod(path, os.stat(path).st_mode | stat.S_IWUSR)
    function(path)


def _remove_scratch_directory(
    path: os.PathLike[str] | str,
    runtime_root: os.PathLike[str] | str,
    *,
    require_marker: bool,
) -> bool:
    candidate = _validated_scratch_path(path, runtime_root, require_marker=require_marker)
    if not candidate.exists():
        return True

    _scrub_scratch_auth(candidate)
    for attempt in range(1, SCRATCH_CLOSE_ATTEMPTS + 1):
        try:
            shutil.rmtree(candidate, onerror=_rmtree_onerror)
        except OSError:
            pass
        if not candidate.exists():
            return True
        if attempt < SCRATCH_CLOSE_ATTEMPTS:
            time.sleep(SCRATCH_CLOSE_RETRY_SECONDS * attempt)
    return False


def cleanup_stale_scratch_clones(
    runtime_root: os.PathLike[str] | str,
    *,
    max_age_seconds: int = STALE_SCRATCH_AGE_SECONDS,
    now_epoch: Optional[float] = None,
) -> list[Path]:
    """Remove only old, marked updater scratch clones from the exact runtime root."""
    root = Path(runtime_root).resolve()
    if not root.is_dir():
        return []
    now_value = time.time() if now_epoch is None else float(now_epoch)
    removed = []
    try:
        candidates = list(root.iterdir())
    except OSError:
        return removed
    for candidate in candidates:
        if not candidate.is_dir() or not _scratch_name_is_safe(candidate.name):
            continue
        marker = _scratch_marker_path(candidate)
        try:
            payload = json.loads(marker.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                continue
            created_epoch = float(payload.get("createdEpoch"))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            continue
        if (
            payload.get("schemaVersion") != 1
            or payload.get("scratchId") != candidate.name
            or not math.isfinite(created_epoch)
            or created_epoch > now_value
            or now_value - created_epoch < max(0, int(max_age_seconds))
        ):
            continue
        try:
            deleted = _remove_scratch_directory(candidate, root, require_marker=True)
        except GitSafetyError:
            deleted = False
        if deleted:
            removed.append(candidate)
        else:
            LOGGER.warning("Unable to remove stale updater scratch directory %s.", candidate.name)
    return removed


class ScratchClone:
    """Disposable local clone used for atomic compare-and-fast-forward pushes."""

    MARKER = ".kmem-updater-scratch"

    def __init__(self, source: GitRepository, path: Path, base_sha: str, runtime_root: Path):
        self.source = source
        self.path = path.resolve()
        self.base_sha = base_sha
        self.runtime_root = runtime_root.resolve()
        self.closed = False
        self.cleanup_complete = False

    @classmethod
    def create(
        cls,
        source: GitRepository,
        ref: str,
        runtime_root: os.PathLike[str] | str,
    ) -> "ScratchClone":
        base_sha = source.sha(ref)
        root = Path(runtime_root).resolve()
        root.mkdir(parents=True, exist_ok=True)
        cleanup_stale_scratch_clones(root)
        path = root / f"scratch-{uuid.uuid4().hex}"

        try:
            clone = source.run(
                ["clone", "--shared", "--no-checkout", str(source.repo_dir), str(path)],
                cwd=source.repo_dir,
                check=False,
            )
        except Exception:
            _cleanup_partial_scratch(path, root)
            raise
        if clone.returncode != 0:
            detail = (clone.stderr or clone.stdout or "scratch clone failed").strip()
            _cleanup_partial_scratch(path, root)
            raise GitSafetyError("SCRATCH_CLONE_FAILED", detail)

        try:
            _write_scratch_marker(path)
        except OSError as error:
            _cleanup_partial_scratch(path, root)
            raise GitSafetyError(
                "SCRATCH_MARKER_FAILED",
                "Unable to mark the updater scratch directory for safe cleanup.",
            ) from error

        scratch = cls(source, path, base_sha, root)
        try:
            scratch.run(["remote", "set-url", "origin", source.origin_url])
            scratch.run(["remote", "set-url", "--push", "origin", source.origin_push_url])
            transport = source.run(
                ["config", "--local", "--get-regexp", r"^http\..*\.extraheader$"],
                check=False,
            )
            for line in transport.stdout.splitlines():
                key, separator, value = line.partition(" ")
                if not separator or not key or not value:
                    continue
                copied = scratch.run(["config", "--local", key, value], check=False)
                if copied.returncode != 0:
                    raise GitSafetyError(
                        "SCRATCH_AUTH_CONFIG_FAILED",
                        "Unable to copy ephemeral Git transport authentication.",
                    )
            scratch.run(["checkout", "--detach", base_sha])
            return scratch
        except Exception:
            scratch.close()
            raise

    def run(
        self,
        args: Iterable[str],
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        if self.closed:
            raise GitSafetyError("SCRATCH_CLOSED", "Refusing to reuse a closed updater scratch clone.")
        return self.source.run(args, cwd=self.path, check=check)

    def write_json(self, relative_path: str, value: dict) -> None:
        if self.closed:
            raise GitSafetyError("SCRATCH_CLOSED", "Refusing to write to a closed updater scratch clone.")
        target = (self.path / relative_path).resolve()
        if target.parent != self.path:
            raise GitSafetyError("UNSAFE_PATH", f"Refusing scratch write outside root: {relative_path}")
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, target)

    def commit(self, paths: Iterable[str], message: str) -> Optional[str]:
        path_list = list(dict.fromkeys(paths))
        if not path_list:
            return None
        self.run(["add", "--", *path_list])
        changed = self.run(["diff", "--cached", "--quiet"], check=False)
        if changed.returncode == 0:
            return None
        if changed.returncode != 1:
            raise GitSafetyError("STAGE_CHECK_FAILED", "Unable to inspect staged updater files.")
        self.run(["commit", "-m", message])
        return self.run(["rev-parse", "HEAD"]).stdout.strip()

    def status_paths(self) -> set[str]:
        output = self.run(
            ["status", "--porcelain=v1", "--untracked-files=all"],
        ).stdout
        paths = set()
        for line in output.splitlines():
            if not line.strip():
                continue
            value = line[3:] if len(line) > 3 else line
            if " -> " in value:
                value = value.split(" -> ", 1)[1]
            paths.add(value.strip().strip('"').replace("\\", "/"))
        return paths

    def sha(self, ref: str = "HEAD") -> str:
        result = self.run(["rev-parse", "--verify", ref], check=False)
        if result.returncode != 0 or not result.stdout.strip():
            raise GitSafetyError("MISSING_REF", f"Unable to resolve scratch ref {ref}.")
        return result.stdout.strip()

    def read_json(self, ref: str, relative_path: str) -> Optional[dict]:
        result = self.run(["show", f"{ref}:{relative_path}"], check=False)
        if result.returncode != 0:
            return None
        try:
            value = json.loads(result.stdout)
        except (TypeError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def push_main(self) -> bool:
        result = self.run(
            ["push", "origin", "HEAD:refs/heads/main"],
            check=False,
        )
        return result.returncode == 0

    def close(self) -> bool:
        if self.cleanup_complete:
            return True
        # From the caller's perspective a close request makes this clone
        # permanently unusable even if Windows temporarily prevents deletion.
        self.closed = True
        try:
            deleted = _remove_scratch_directory(
                self.path,
                self.runtime_root,
                require_marker=True,
            )
        except GitSafetyError as error:
            LOGGER.error("Scratch cleanup refused code=%s.", error.code)
            return False
        if not deleted:
            LOGGER.warning("Scratch cleanup incomplete for %s; a later cycle will retry it.", self.path.name)
            return False
        self.cleanup_complete = True
        return True

    def __enter__(self) -> "ScratchClone":
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()


class LocalProcessLock:
    """Recoverable OS-level lock; the kernel releases it when a process exits."""

    def __init__(self, path: os.PathLike[str] | str, role: str = "UNKNOWN"):
        self.path = Path(path).resolve()
        self.role = role
        self.handle = None
        self.metadata: dict = {}
        self.lock_id: Optional[str] = None

    def _write_metadata(self, metadata: dict) -> None:
        if self.handle is None:
            raise RuntimeError("Local updater lock is not held.")
        payload = (json.dumps(metadata, separators=(",", ":")) + "\n").encode("utf-8")
        self.handle.seek(1)
        self.handle.truncate(1)
        self.handle.write(payload)
        self.handle.flush()
        self.metadata = dict(metadata)

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self.path, "a+b", buffering=0)
        try:
            handle.seek(0)
            if handle.read(1) == b"":
                handle.seek(0)
                handle.write(b" ")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError) as error:
            handle.close()
            raise LocalLockUnavailable("Another KMEM updater process is already running.") from error

        self.handle = handle
        try:
            metadata = {
                "schemaVersion": 1,
                "role": self.role,
                "processId": os.getpid(),
                "acquiredEpoch": int(time.time()),
                "lockId": uuid.uuid4().hex,
            }
            self._write_metadata(metadata)
            self.lock_id = metadata["lockId"]
        except Exception:
            try:
                self.release()
            except Exception:
                # Closing the file still releases the kernel lock if an explicit
                # unlock cannot complete after a metadata write failure.
                try:
                    handle.close()
                finally:
                    self.handle = None
            raise

    def release(self) -> None:
        if self.handle is None:
            return
        handle = self.handle
        self.handle = None
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
            self.metadata = {}
            self.lock_id = None

    def __enter__(self) -> "LocalProcessLock":
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.release()


def read_local_lock_metadata(path: os.PathLike[str] | str) -> dict:
    try:
        with open(path, "rb") as handle:
            # Byte zero carries the OS lock. Reading only the unlocked metadata
            # range works while the parent retains the exclusive kernel lock.
            handle.seek(1)
            payload = handle.read().decode("utf-8")
        value = json.loads(payload)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def default_runtime_root() -> Path:
    base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
    return Path(base).resolve() / "KMEMOpsBoard" / "updater-runtime"
