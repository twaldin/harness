"""Workdir leases and owned instruction projection.

Every mutation harness makes inside a workdir happens under an exclusive
per-workdir lease: the directory `<workdir>/.harness-run.lock`, created with
`mkdir(mode=0o700)`. The TypeScript implementation and other processes use the
same protocol, so overlapping runs on one canonical workdir are rejected with
`instruction-conflict` instead of racing over each other's projected files.

A projection replaces `<workdir>/<filename>` with harness-owned bytes while
preserving the original by *renaming* it into the lease directory. Ownership
is tracked by inode/device, mode and SHA-256 so cleanup only ever removes
what harness created and only ever restores what harness moved; anything
edited, replaced or deleted underneath is left untouched (both the current
file and the backup) and reported as `instruction-conflict`.
"""
from __future__ import annotations

import hashlib
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path, PurePath

from harness.base import BuildCommand, HarnessError

LOCK_DIRNAME = ".harness-run.lock"
_MODES = ("replace", "prepend")


# ---- identity helpers -------------------------------------------------------


@dataclass(frozen=True)
class _Identity:
    dev: int
    ino: int


def _identity(st: os.stat_result) -> _Identity:
    return _Identity(st.st_dev, st.st_ino)


def _lstat(path: Path) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def _conflict(message: str) -> HarnessError:
    return HarnessError(message, code="instruction-conflict")


def _canonical_workdir(workdir: Path | str) -> Path:
    path = Path(workdir)
    if not path.is_dir():
        raise HarnessError(f"workdir does not exist or is not a directory: {path}", code="invalid-options")
    return Path(os.path.realpath(path))


def _relative_parts(filename: object, what: str = "filename") -> tuple[str, ...]:
    """Split a workdir-relative path into components, rejecting anything that
    could escape or alias the workdir: absolute paths, anchors, `..`, NUL."""
    if not isinstance(filename, str) or not filename or "\0" in filename:
        raise HarnessError(f"{what} must be a non-empty relative path without NUL bytes", code="invalid-options")
    pure = PurePath(filename)
    if pure.is_absolute() or pure.anchor:
        raise HarnessError(f"{what} must be relative to the workdir, got {filename!r}", code="invalid-options")
    normalized = filename.replace(os.altsep, os.sep) if os.altsep else filename
    parts = tuple(normalized.split(os.sep))
    if any(p in ("", ".", "..") for p in parts):
        raise HarnessError(f"{what} must not contain empty, dot or traversal components", code="invalid-options")
    if parts[0] == LOCK_DIRNAME:
        raise HarnessError(f"{what} must not point inside {LOCK_DIRNAME}", code="invalid-options")
    return parts


def _digest(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def _read_regular(path: Path, expected: _Identity) -> bytes:
    """Read `path` without following symlinks, verifying it is still `expected`."""
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or _identity(st) != expected:
            raise _conflict(f"{path} changed identity while harness owned it")
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


# ---- directories ------------------------------------------------------------


@dataclass(frozen=True)
class _Dir:
    path: Path
    id: _Identity
    created: bool


def _check_ancestors(root: Path, parts: tuple[str, ...]) -> Path | None:
    """Verify the directory chain `root/parts[:-1]` contains no symlinks or
    non-directories. Returns the first missing directory (or None if all exist).
    Touches nothing."""
    current = root
    for part in parts[:-1]:
        current = current / part
        st = _lstat(current)
        if st is None:
            return current
        if stat.S_ISLNK(st.st_mode):
            raise _conflict(f"{current} is a symlink; refusing to project through it")
        if not stat.S_ISDIR(st.st_mode):
            raise _conflict(f"{current} is not a directory")
    return None


def _ensure_dirs(root: Path, parts: tuple[str, ...], record: list[_Dir]) -> Path:
    """Create missing directories along `root/parts`, recording every component
    (created or preexisting) with its identity. Returns the final directory."""
    current = root
    for part in parts:
        current = current / part
        st = _lstat(current)
        if st is None:
            os.mkdir(current)
            st = os.lstat(current)
            record.append(_Dir(current, _identity(st), created=True))
            continue
        if stat.S_ISLNK(st.st_mode):
            raise _conflict(f"{current} is a symlink; refusing to project through it")
        if not stat.S_ISDIR(st.st_mode):
            raise _conflict(f"{current} is not a directory")
        record.append(_Dir(current, _identity(st), created=False))
    return current


def _verify_dirs(dirs: list[_Dir]) -> None:
    for d in dirs:
        st = _lstat(d.path)
        if st is None or stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or _identity(st) != d.id:
            raise _conflict(f"directory {d.path} was replaced or removed while harness owned a projection in it")


def _prune_created(dirs: list[_Dir]) -> None:
    """Remove directories harness created, deepest first, only while still
    empty and still the same directory. Preexisting or non-empty ones stay."""
    for d in reversed(dirs):
        if not d.created:
            continue
        st = _lstat(d.path)
        if st is None or stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or _identity(st) != d.id:
            continue
        try:
            os.rmdir(d.path)
        except OSError:
            continue


# ---- lease ------------------------------------------------------------------


@dataclass
class _Owned:
    """One projected file and the original it displaced."""

    target: Path
    backup: Path
    existed: bool
    dirs: list[_Dir]
    orig_id: _Identity | None = None
    orig_mode: int | None = None
    orig_digest: bytes | None = None
    renamed: bool = False
    new_id: _Identity | None = None
    new_mode: int | None = None
    new_digest: bytes | None = None
    #: Bytes being written; set only while the write is in flight so a
    #: partially written target can still be recognized as harness-owned.
    pending: bytes | None = None
    restored: bool = False


@dataclass
class _Lease:
    workdir: Path
    lock_dir: Path
    lock_id: _Identity
    dirs: list[_Dir] = field(default_factory=list)
    projection: _Owned | None = None
    released: bool = False


def _acquire_lease(workdir: Path | str) -> _Lease:
    canonical = _canonical_workdir(workdir)
    lock_dir = canonical / LOCK_DIRNAME
    if _lstat(lock_dir) is not None:
        raise _conflict(
            f"another harness run owns {canonical} ({LOCK_DIRNAME} exists); wait for it to finish or use a different workdir"
        )
    try:
        os.mkdir(lock_dir, 0o700)
    except FileExistsError:
        raise _conflict(
            f"another harness run owns {canonical} ({LOCK_DIRNAME} exists); wait for it to finish or use a different workdir"
        ) from None
    return _Lease(workdir=canonical, lock_dir=lock_dir, lock_id=_identity(os.lstat(lock_dir)))


def _verify_lock(lease: _Lease) -> None:
    st = _lstat(lease.lock_dir)
    if st is None or stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or _identity(st) != lease.lock_id:
        raise _conflict(f"{lease.lock_dir} was replaced or removed while harness held the workdir lease")
    expected = set()
    if lease.projection is not None and lease.projection.renamed:
        expected.add(lease.projection.backup.name)
    if any(entry.name not in expected for entry in lease.lock_dir.iterdir()):
        raise _conflict(f"{lease.lock_dir} contains unexpected entries; preserving the projection for manual recovery")


def _release_lock(lease: _Lease) -> None:
    _verify_lock(lease)
    try:
        os.rmdir(lease.lock_dir)
    except OSError as exc:
        raise _conflict(f"cannot release {lease.lock_dir}: {exc.strerror or exc}; inspect and remove it manually") from None
    lease.released = True


def _cleanup_lease(lease: _Lease) -> None:
    """Restore the projection, prune owned directories, release the lease.
    Idempotent once successful; any conflict keeps the lease in place."""
    if lease.released:
        return
    _verify_lock(lease)
    owned = lease.projection
    if owned is not None and not owned.restored:
        _restore(owned)
    _prune_created(lease.dirs)
    _release_lock(lease)




def _ensure_directory(lease: _Lease, cwd: Path, directory: Path) -> None:
    try:
        relative = Path(directory).relative_to(cwd)
    except ValueError:
        raise HarnessError(f"planned directory {directory} is outside workdir {cwd}", code="invalid-options") from None
    _ensure_dirs(lease.workdir, _relative_parts(str(relative), "directory"), lease.dirs)


# ---- projection -------------------------------------------------------------


def _compose(existing: bytes | None, content: str, mode: str, markers: tuple[str, str] | None, exact: bool) -> bytes:
    if exact:
        return content.encode("utf-8")
    if existing is None:
        return f"{content}\n".encode("utf-8")
    if markers is None and mode == "replace":
        return f"{content}\n".encode("utf-8")
    try:
        text = existing.decode("utf-8")
    except UnicodeDecodeError:
        raise _conflict("existing instructions file is not UTF-8; prepend and marker modes require text") from None
    if markers is not None:
        start, end = markers
        s = text.find(start)
        e = text.find(end, s + len(start)) if s >= 0 else -1
        if e >= 0:
            return (text[:s] + content + text[e + len(end):]).encode("utf-8")
    if mode == "prepend":
        return f"{content}\n\n{text}".encode("utf-8")
    return f"{content}\n".encode("utf-8")


def _project(
    lease: _Lease,
    filename: str,
    content: str,
    *,
    mode: str = "replace",
    markers: tuple[str, str] | None = None,
    exact: bool = False,
    create_only: bool = False,
) -> _Owned:
    """Project `content` onto `lease.workdir/filename` under an acquired lease.
    Inspects everything before mutating anything; on failure after mutation
    began, the caller abandons the lease which rolls the owned steps back."""
    if lease.projection is not None:
        raise HarnessError("lease already holds a projection", code="invalid-options")
    parts = _relative_parts(filename)
    target = lease.workdir.joinpath(*parts)
    owned = _Owned(target=target, backup=lease.lock_dir / f"original-{parts[-1]}", existed=False, dirs=[])

    existing: bytes | None = None
    if _check_ancestors(lease.workdir, parts) is None:
        st = _lstat(target)
        if st is not None:
            if create_only:
                raise _conflict(f"{target} already exists; write_instructions never overwrites")
            if stat.S_ISLNK(st.st_mode):
                raise _conflict(f"{target} is a symlink; refusing to replace it")
            if not stat.S_ISREG(st.st_mode):
                raise _conflict(f"{target} is not a regular file; refusing to replace it")
            if st.st_nlink > 1:
                raise _conflict(f"{target} has {st.st_nlink} hard links; refusing to replace it")
            owned.existed = True
            owned.orig_id = _identity(st)
            owned.orig_mode = stat.S_IMODE(st.st_mode)
            existing = _read_regular(target, owned.orig_id)
            owned.orig_digest = _digest(existing)

    data = _compose(existing, content, mode, markers, exact)

    # Mutation begins: from here on every step is recorded on `owned`/`lease`
    # so `_cleanup_lease` can undo exactly what happened.
    lease.projection = owned
    _ensure_dirs(lease.workdir, parts[:-1], owned.dirs)
    if owned.existed:
        os.rename(target, owned.backup)
        owned.renamed = True
        bst = _lstat(owned.backup)
        if bst is None or _identity(bst) != owned.orig_id:
            raise _conflict(f"{target} changed while harness was preserving it")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        st = os.fstat(fd)
        owned.new_id = _identity(st)
        owned.new_mode = stat.S_IMODE(st.st_mode)
        owned.pending = data
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
    finally:
        os.close(fd)
    owned.new_digest = _digest(data)
    owned.pending = None
    return owned


def _verify_owned_file(path: Path, expected: _Identity | None, mode: int | None, digest: bytes | None, what: str) -> bytes:
    """Ownership check without following symlinks; returns the current bytes."""
    st = _lstat(path)
    if st is None:
        raise _conflict(f"{what} {path} was removed while harness owned it; nothing was restored")
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or _identity(st) != expected:
        raise _conflict(f"{what} {path} was replaced while harness owned it; leaving it in place")
    if st.st_nlink != 1:
        raise _conflict(f"{what} {path} gained hard links while harness owned it; leaving it in place")
    if stat.S_IMODE(st.st_mode) != mode:
        raise _conflict(f"{what} {path} changed mode while harness owned it; leaving it in place")
    current = _read_regular(path, expected)
    if digest is not None and _digest(current) != digest:
        raise _conflict(f"{what} {path} was edited while harness owned it; leaving it in place")
    return current


def _restore(owned: _Owned) -> None:
    """Undo one projection. Verifies ownership of the projected file, its
    parents and the backup before touching anything."""
    _verify_dirs(owned.dirs)
    if owned.new_id is not None:
        current = _verify_owned_file(owned.target, owned.new_id, owned.new_mode, owned.new_digest, "projected file")
        # A write that failed midway left a prefix of the intended bytes on the
        # inode harness created; anything else is a foreign replacement.
        if owned.new_digest is None and not (owned.pending or b"").startswith(current):
            raise _conflict(f"projected file {owned.target} was edited while harness owned it; leaving it in place")
    if owned.renamed:
        _verify_owned_file(owned.backup, owned.orig_id, owned.orig_mode, owned.orig_digest, "backup")
        if owned.new_id is None and _lstat(owned.target) is not None:
            raise _conflict(f"{owned.target} appeared during preparation; preserving it and the original backup")
    if owned.new_id is not None:
        os.unlink(owned.target)
        owned.new_id = None
    if owned.renamed:
        os.rename(owned.backup, owned.target)
        owned.renamed = False
    _prune_created(owned.dirs)
    owned.restored = True


# ---- public API -------------------------------------------------------------


@dataclass
class InstructionProjection:
    """Handle returned by `project_instructions`; pass it to
    `restore_projected_instructions`. Holds the workdir lease until restored.
    Ownership metadata is private and the handle is not serializable."""

    workdir: Path
    filename: str
    file_path: Path
    existed_before: bool
    backup_path: Path
    wrote_backup: bool
    _lease: _Lease = field(repr=False, compare=False)


@dataclass
class PreparedCommand:
    """A `BuildCommand` whose planned filesystem work has been applied under
    the workdir lease. Pass to `cleanup_command` (or use as a context manager)
    to restore the workdir and release the lease."""

    command: BuildCommand
    _lease: _Lease = field(repr=False, compare=False)

    def __enter__(self) -> PreparedCommand:
        return self

    def __exit__(self, *_exc: object) -> None:
        cleanup_command(self)


def prepare_command(command: BuildCommand) -> PreparedCommand:
    """Acquire the workdir lease, create `command.directories` and project
    `command.instruction_content` to `command.instructions_file` exactly.
    On failure every owned change is rolled back and the lease released."""
    cwd = Path(command.cwd)
    lease = _acquire_lease(cwd)
    try:
        for directory in command.directories:
            _ensure_directory(lease, cwd, directory)
        if command.instruction_content is not None:
            if command.instructions_file is None:
                raise HarnessError("instruction_content planned without instructions_file", code="invalid-options")
            try:
                relative = Path(command.instructions_file).relative_to(cwd)
            except ValueError:
                raise HarnessError(
                    f"instructions_file {command.instructions_file} is outside workdir {cwd}", code="invalid-options"
                ) from None
            _project(lease, str(relative), command.instruction_content, exact=True)
    except BaseException:
        _cleanup_lease(lease)
        raise
    return PreparedCommand(command=command, _lease=lease)


def cleanup_command(prepared: PreparedCommand) -> None:
    """Restore the projected instructions, prune directories harness created
    and release the lease. Idempotent after success. Raises
    `instruction-conflict` (keeping the lease, the current file and the backup)
    when the projected file, its parents, the backup or the lease changed."""
    _cleanup_lease(prepared._lease)


def project_instructions(
    workdir: Path | str,
    filename: str,
    content: str,
    *,
    mode: str = "replace",
    backup: bool = True,
    replace_between_markers: tuple[str, str] | None = None,
) -> InstructionProjection:
    """Project `content` into `workdir/filename` under the workdir lease.

    mode:
      - "replace": file becomes `content + "\\n"`
      - "prepend": file becomes `content + "\\n\\n" + existing`
    `replace_between_markers=(start, end)`: when the existing file contains
    `start` followed by `end`, the whole first `start..end` block (markers
    included) is replaced by `content` literally; otherwise `mode` applies.
    Originals are always preserved (`backup=False` is rejected).
    """
    if mode not in _MODES:
        raise HarnessError(f"unknown mode {mode!r}; expected one of {', '.join(_MODES)}", code="invalid-options")
    if backup is not True:
        raise HarnessError("backup=False is not supported; originals are always preserved", code="invalid-options")
    markers: tuple[str, str] | None = None
    if replace_between_markers is not None:
        pair = tuple(replace_between_markers) if isinstance(replace_between_markers, (tuple, list)) else ()
        if len(pair) != 2 or not all(isinstance(m, str) and m for m in pair):
            raise HarnessError("replace_between_markers must be a (start, end) pair of non-empty strings", code="invalid-options")
        markers = (pair[0], pair[1])
    if not isinstance(content, str):
        raise HarnessError(f"content must be a string, got {type(content).__name__}", code="invalid-options")
    _relative_parts(filename)

    lease = _acquire_lease(workdir)
    try:
        owned = _project(lease, filename, content, mode=mode, markers=markers)
    except BaseException:
        _cleanup_lease(lease)
        raise
    return InstructionProjection(
        workdir=lease.workdir,
        filename=filename,
        file_path=owned.target,
        existed_before=owned.existed,
        backup_path=owned.backup,
        wrote_backup=owned.existed,
        _lease=lease,
    )


def restore_projected_instructions(projection: InstructionProjection) -> None:
    """Undo `project_instructions` and release the lease. See `cleanup_command`
    for the conflict rules."""
    _cleanup_lease(projection._lease)


def write_instructions(workdir: Path | str, filename: str, content: str | None) -> Path | None:
    """Create `workdir/filename` with `content` exclusively. Returns the path,
    or None when `content` is None (an empty string writes an empty file).

    Caller-owned, persistent creation: the file stays after the call and is
    never cleaned up by harness. The workdir lease is held only for the
    duration of the write, so this cannot inject a file under a running
    command; an active run rejects with `instruction-conflict`. Refuses to
    touch an existing path, a symlink, or anything reached through a
    symlinked ancestor; never truncates. For temporary ownership use
    `project_instructions`.
    """
    if content is None:
        return None
    _relative_parts(filename)
    lease = _acquire_lease(workdir)
    try:
        owned = _project(lease, filename, content, exact=True, create_only=True)
    except BaseException:
        _cleanup_lease(lease)
        raise
    # Successful exclusive creation transfers the file and its parent directories
    # to the caller. Only the temporary lease remains ours to release.
    lease.projection = None
    _release_lock(lease)
    return owned.target
