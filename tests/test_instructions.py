"""Instruction projection, workdir leases and prepare/cleanup ownership."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from harness import (
    BuildCommand,
    HarnessError,
    PreparedCommand,
    cleanup_command,
    prepare_command,
    project_instructions,
    restore_projected_instructions,
    write_instructions,
)

LOCK = ".harness-run.lock"


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    d = tmp_path / "repo"
    d.mkdir()
    return d


def _bc(workdir: Path, content: str | None, filename: str = "AGENTS.md", directories: tuple[Path, ...] = ()) -> BuildCommand:
    return BuildCommand(
        cmd="true",
        args=[],
        cwd=workdir,
        env={},
        instructions_file=workdir / filename if content is not None else None,
        instruction_content=content,
        directories=directories,
    )


def _mode(path: Path) -> int:
    return path.lstat().st_mode & 0o777


# ── prepare + cleanup ───────────────────────────────────────────────────────


def test_prepare_projects_exact_content_and_cleanup_restores_original_identity(workdir: Path):
    target = workdir / "AGENTS.md"
    target.write_bytes(b"\xff\xfe binary original")
    os.chmod(target, 0o640)
    before = target.lstat()

    prepared = prepare_command(_bc(workdir, "projected"))
    assert target.read_bytes() == b"projected"  # exact bytes, no trailing newline
    assert _mode(target) == 0o600
    assert (workdir / LOCK).is_dir()
    assert not any(p.name.startswith(".harness-backup-") for p in workdir.iterdir())

    cleanup_command(prepared)
    after = target.lstat()
    assert target.read_bytes() == b"\xff\xfe binary original"
    assert (after.st_ino, after.st_dev) == (before.st_ino, before.st_dev)
    assert _mode(target) == 0o640
    assert sorted(p.name for p in workdir.iterdir()) == ["AGENTS.md"]


def test_prepare_creates_empty_file_and_cleanup_removes_it(workdir: Path):
    prepared = prepare_command(_bc(workdir, ""))
    assert (workdir / "AGENTS.md").read_bytes() == b""
    cleanup_command(prepared)
    assert list(workdir.iterdir()) == []


def test_prepare_creates_nested_parents_and_cleanup_prunes_only_its_own(workdir: Path):
    (workdir / ".opencode").mkdir()
    (workdir / ".opencode" / "keep.txt").write_text("keep")
    prepared = prepare_command(_bc(workdir, "x", filename=".opencode/agents/flt.md"))
    assert (workdir / ".opencode/agents/flt.md").read_text() == "x"
    cleanup_command(prepared)
    assert not (workdir / ".opencode/agents").exists()
    assert (workdir / ".opencode" / "keep.txt").read_text() == "keep"


def test_prepare_creates_planned_directories_but_cleanup_keeps_cli_outputs(workdir: Path):
    data = workdir / ".harness" / "crush-data"
    prepared = prepare_command(_bc(workdir, None, directories=(data,)))
    assert data.is_dir()
    (data / "crush.db").write_text("db")
    cleanup_command(prepared)
    assert (data / "crush.db").read_text() == "db"
    assert not (workdir / LOCK).exists()


def test_planned_directory_pruned_when_left_empty(workdir: Path):
    prepared = prepare_command(_bc(workdir, None, directories=(workdir / ".harness",)))
    cleanup_command(prepared)
    assert list(workdir.iterdir()) == []


def test_preexisting_planned_directory_survives_cleanup(workdir: Path):
    (workdir / ".harness").mkdir()
    prepared = prepare_command(_bc(workdir, None, directories=(workdir / ".harness",)))
    cleanup_command(prepared)
    assert (workdir / ".harness").is_dir()


def test_stale_legacy_backup_is_not_consumed(workdir: Path):
    stale = workdir / ".harness-backup-AGENTS.md"
    stale.write_text("stale")
    prepared = prepare_command(_bc(workdir, "new"))
    cleanup_command(prepared)
    assert stale.read_text() == "stale"
    assert not (workdir / "AGENTS.md").exists()


def test_cleanup_is_idempotent_and_context_manager_cleans(workdir: Path):
    prepared = prepare_command(_bc(workdir, "x"))
    cleanup_command(prepared)
    cleanup_command(prepared)
    assert list(workdir.iterdir()) == []

    with prepare_command(_bc(workdir, "y")) as p:
        assert isinstance(p, PreparedCommand)
        assert p.command.instruction_content == "y"
        assert (workdir / "AGENTS.md").read_text() == "y"
    assert list(workdir.iterdir()) == []


def test_prepare_requires_existing_workdir(tmp_path: Path):
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(tmp_path / "missing", "x"))
    assert exc.value.code == "invalid-options"
    assert not (tmp_path / "missing").exists()


def test_prepare_rejects_instructions_outside_workdir(workdir: Path, tmp_path: Path):
    bc = _bc(workdir, "x")
    bc.instructions_file = tmp_path / "elsewhere.md"
    with pytest.raises(HarnessError) as exc:
        prepare_command(bc)
    assert exc.value.code == "invalid-options"
    assert list(workdir.iterdir()) == []


# ── leases ──────────────────────────────────────────────────────────────────


def test_overlapping_runs_on_same_workdir_reject_even_without_instructions(workdir: Path):
    first = prepare_command(_bc(workdir, None))
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, "x"))
    assert exc.value.code == "instruction-conflict"
    assert not (workdir / "AGENTS.md").exists()
    cleanup_command(first)
    cleanup_command(prepare_command(_bc(workdir, "x")))


def test_workdir_alias_shares_the_lease(workdir: Path, tmp_path: Path):
    alias = tmp_path / "alias"
    alias.symlink_to(workdir, target_is_directory=True)
    first = prepare_command(_bc(alias, None))
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, None))
    assert exc.value.code == "instruction-conflict"
    cleanup_command(first)
    assert list(workdir.iterdir()) == []


def test_distinct_workdirs_run_concurrently(tmp_path: Path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    pa = prepare_command(_bc(a, "a"))
    pb = prepare_command(_bc(b, "b"))
    assert (a / "AGENTS.md").read_text() == "a" and (b / "AGENTS.md").read_text() == "b"
    cleanup_command(pa)
    cleanup_command(pb)


def test_foreign_process_lock_is_never_stolen(workdir: Path):
    # Same protocol another process (or the TypeScript implementation) uses.
    subprocess.run([sys.executable, "-c", f"import os; os.mkdir({str(workdir / LOCK)!r}, 0o700)"], check=True)
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, "x"))
    assert exc.value.code == "instruction-conflict"
    assert (workdir / LOCK).is_dir()
    assert not (workdir / "AGENTS.md").exists()


def test_symlinked_lock_rejects(workdir: Path, tmp_path: Path):
    (workdir / LOCK).symlink_to(tmp_path)
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, None))
    assert exc.value.code == "instruction-conflict"
    assert (workdir / LOCK).is_symlink()


def test_tampered_lock_keeps_lease_and_reports_conflict(workdir: Path):
    prepared = prepare_command(_bc(workdir, None))
    (workdir / LOCK / "stray").write_text("x")
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert (workdir / LOCK / "stray").exists()


# ── ownership conflicts ─────────────────────────────────────────────────────


def test_edited_target_keeps_user_edit_and_backup(workdir: Path):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    prepared = prepare_command(_bc(workdir, "projected"))
    target.write_text("user edit")
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert target.read_text() == "user edit"
    assert (workdir / LOCK / "original-AGENTS.md").read_text() == "original"
    assert (workdir / LOCK).is_dir()


def test_replaced_target_symlink_is_not_removed(workdir: Path, tmp_path: Path):
    target = workdir / "AGENTS.md"
    prepared = prepare_command(_bc(workdir, "projected"))
    target.unlink()
    elsewhere = tmp_path / "elsewhere.md"
    elsewhere.write_text("theirs")
    target.symlink_to(elsewhere)
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert target.is_symlink() and elsewhere.read_text() == "theirs"


def test_deleted_target_preserves_backup(workdir: Path):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    prepared = prepare_command(_bc(workdir, "projected"))
    target.unlink()
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert not target.exists()
    assert (workdir / LOCK / "original-AGENTS.md").read_text() == "original"


def test_mode_change_on_target_is_a_conflict(workdir: Path):
    target = workdir / "AGENTS.md"
    prepared = prepare_command(_bc(workdir, "projected"))
    os.chmod(target, 0o644)
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert target.read_text() == "projected"


def test_tampered_backup_is_not_restored(workdir: Path):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    prepared = prepare_command(_bc(workdir, "projected"))
    (workdir / LOCK / "original-AGENTS.md").write_text("tampered")
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert target.read_text() == "projected"
    assert (workdir / LOCK / "original-AGENTS.md").read_text() == "tampered"


def test_replaced_parent_directory_is_a_conflict(workdir: Path):
    prepared = prepare_command(_bc(workdir, "x", filename="sub/AGENTS.md"))
    sub = workdir / "sub"
    replacement = workdir / "sub.new"
    replacement.mkdir()
    (replacement / "AGENTS.md").write_text("theirs")
    sub.rename(workdir / "sub.old")
    replacement.rename(sub)
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert (sub / "AGENTS.md").read_text() == "theirs"
    assert (workdir / "sub.old" / "AGENTS.md").read_text() == "x"


def test_replaced_preexisting_parent_with_same_target_inode_conflicts(workdir: Path):
    parent = workdir / "sub"
    parent.mkdir()
    target = parent / "AGENTS.md"
    target.write_text("original")
    prepared = prepare_command(_bc(workdir, "projected", filename="sub/AGENTS.md"))
    displaced = workdir / "displaced"
    parent.rename(displaced)
    parent.mkdir()
    (displaced / "AGENTS.md").rename(target)
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert target.read_text() == "projected"
    assert (workdir / LOCK / "original-AGENTS.md").read_text() == "original"


def test_replaced_lock_prevents_any_projection_cleanup(workdir: Path):
    prepared = prepare_command(_bc(workdir, "projected"))
    (workdir / LOCK).rename(workdir / "displaced-lock")
    (workdir / LOCK).mkdir()
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert (workdir / "AGENTS.md").read_text() == "projected"


def test_deleted_and_recreated_lock_is_not_released(workdir: Path):
    prepared = prepare_command(_bc(workdir, None))
    shutil.rmtree(workdir / LOCK)
    (workdir / LOCK).mkdir()
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert (workdir / LOCK).is_dir()


def test_new_hard_link_prevents_projection_cleanup(workdir: Path):
    prepared = prepare_command(_bc(workdir, "projected"))
    os.link(workdir / "AGENTS.md", workdir / "other.md")
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert (workdir / "AGENTS.md").read_text() == "projected"
    assert (workdir / "other.md").read_text() == "projected"


@pytest.mark.parametrize("make", ["symlink", "dangling", "fifo"])
def test_nonregular_targets_are_rejected_untouched(workdir: Path, tmp_path: Path, make: str):
    target = workdir / "AGENTS.md"
    if make == "symlink":
        real = tmp_path / "real.md"
        real.write_text("real")
        target.symlink_to(real)
    elif make == "dangling":
        target.symlink_to(tmp_path / "nope")
    else:
        os.mkfifo(target)
    before = target.lstat()
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, "x"))
    assert exc.value.code == "instruction-conflict"
    assert target.lstat().st_ino == before.st_ino
    assert not (workdir / LOCK).exists()


def test_symlinked_ancestor_is_rejected(workdir: Path, tmp_path: Path):
    real = tmp_path / "real-dir"
    real.mkdir()
    (workdir / "sub").symlink_to(real, target_is_directory=True)
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, "x", filename="sub/AGENTS.md"))
    assert exc.value.code == "instruction-conflict"
    assert list(real.iterdir()) == []
    assert not (workdir / LOCK).exists()


def test_hard_linked_target_is_rejected(workdir: Path):
    target = workdir / "AGENTS.md"
    target.write_text("shared")
    os.link(target, workdir / "twin.md")
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, "x"))
    assert exc.value.code == "instruction-conflict"
    assert target.read_text() == "shared" and (workdir / "twin.md").read_text() == "shared"
    assert not (workdir / LOCK).exists()


@pytest.mark.parametrize("filename", ["/etc/AGENTS.md", "../AGENTS.md", "a/../../x.md", "", "a//b", "./AGENTS.md", f"{LOCK}/file"])
def test_unsafe_filenames_are_rejected_before_any_write(workdir: Path, filename: str):
    with pytest.raises(HarnessError) as exc:
        project_instructions(workdir, filename, "x")
    assert exc.value.code == "invalid-options"
    assert list(workdir.iterdir()) == []


def test_failed_prepare_rolls_back_owned_changes_and_releases_lease(workdir: Path):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    before = target.lstat()
    (workdir / ".harness").symlink_to(workdir / "nope")  # planned directory through a symlink -> conflict
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, "x", directories=(workdir / ".harness" / "kilo",)))
    assert exc.value.code == "instruction-conflict"
    assert target.read_text() == "original" and target.lstat().st_ino == before.st_ino
    assert not (workdir / LOCK).exists()


@pytest.mark.parametrize("foreign_replacement", [False, True])
def test_partial_projection_write_restores_only_owned_content(workdir: Path, monkeypatch, foreign_replacement: bool):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    identity = target.stat().st_ino
    write = os.write
    calls = 0

    def fail_after_partial_write(fd, data):
        nonlocal calls
        calls += 1
        if calls == 1:
            return write(fd, data[:2])
        if foreign_replacement:
            target.unlink()
            target.write_text("user replacement")
        raise OSError("synthetic disk failure")

    with monkeypatch.context() as patch:
        patch.setattr(os, "write", fail_after_partial_write)
        with pytest.raises((OSError, HarnessError)):
            prepare_command(_bc(workdir, "projected"))
    if foreign_replacement:
        assert target.read_text() == "user replacement"
        assert (workdir / LOCK / "original-AGENTS.md").read_text() == "original"
        assert (workdir / LOCK).exists()
    else:
        assert target.read_text() == "original"
        assert target.stat().st_ino == identity
        assert not (workdir / LOCK).exists()


def test_unexpected_lock_entry_prevents_restoration(workdir: Path):
    prepared = prepare_command(_bc(workdir, "projected"))
    (workdir / LOCK / "user-file").write_text("mine")
    with pytest.raises(HarnessError) as exc:
        cleanup_command(prepared)
    assert exc.value.code == "instruction-conflict"
    assert (workdir / "AGENTS.md").read_text() == "projected"
    assert (workdir / LOCK / "user-file").read_text() == "mine"


def test_failed_restore_preserves_projection_and_backup_for_retry(workdir: Path, monkeypatch):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    identity = target.stat().st_ino
    projection = project_instructions(workdir, "AGENTS.md", "projected")

    def fail_rename(*args, **kwargs):
        raise OSError("synthetic rename failure")

    with monkeypatch.context() as patch:
        patch.setattr(os, "rename", fail_rename)
        patch.setattr(os, "replace", fail_rename)
        with pytest.raises(OSError):
            restore_projected_instructions(projection)
    assert target.read_text() == "projected\n"
    assert projection.backup_path.read_text() == "original"
    restore_projected_instructions(projection)
    assert target.read_text() == "original"
    assert target.stat().st_ino == identity
    assert not (workdir / LOCK).exists()


# ── project_instructions / restore ──────────────────────────────────────────


def test_project_replace_and_prepend_conventions(workdir: Path):
    target = workdir / "AGENTS.md"
    projection = project_instructions(workdir, "AGENTS.md", "injected")
    assert target.read_text() == "injected\n"
    assert not projection.existed_before and not projection.wrote_backup
    restore_projected_instructions(projection)
    assert not target.exists()

    target.write_text("original\n")
    projection = project_instructions(workdir, "AGENTS.md", "injected", mode="prepend")
    assert target.read_text() == "injected\n\noriginal\n"
    assert projection.existed_before and projection.wrote_backup
    assert projection.backup_path.read_text() == "original\n"
    assert projection.file_path == workdir / "AGENTS.md"
    restore_projected_instructions(projection)
    restore_projected_instructions(projection)
    assert target.read_text() == "original\n"
    assert sorted(p.name for p in workdir.iterdir()) == ["AGENTS.md"]


def test_replace_between_markers_replaces_first_well_ordered_pair(workdir: Path):
    target = workdir / "AGENTS.md"
    original = "head\n<!-- s -->\nold\n<!-- e -->\ntail\n<!-- s -->\nkeep\n<!-- e -->\n"
    target.write_text(original)
    projection = project_instructions(workdir, "AGENTS.md", "new", replace_between_markers=("<!-- s -->", "<!-- e -->"))
    assert target.read_text() == "head\nnew\ntail\n<!-- s -->\nkeep\n<!-- e -->\n"
    restore_projected_instructions(projection)
    assert target.read_text() == original


def test_replace_between_markers_falls_back_to_mode_without_ordered_pair(workdir: Path):
    target = workdir / "AGENTS.md"
    target.write_text("<!-- e -->\nbody\n<!-- s -->\n")
    projection = project_instructions(workdir, "AGENTS.md", "new", mode="prepend", replace_between_markers=("<!-- s -->", "<!-- e -->"))
    assert target.read_text() == "new\n\n<!-- e -->\nbody\n<!-- s -->\n"
    restore_projected_instructions(projection)


@pytest.mark.parametrize(
    "kwargs",
    [{"mode": "append"}, {"backup": False}, {"replace_between_markers": ("only",)}, {"replace_between_markers": ("", "x")}],
)
def test_invalid_options_rejected_before_writes(workdir: Path, kwargs: dict):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    with pytest.raises(HarnessError) as exc:
        project_instructions(workdir, "AGENTS.md", "x", **kwargs)
    assert exc.value.code == "invalid-options"
    assert target.read_text() == "original"
    assert sorted(p.name for p in workdir.iterdir()) == ["AGENTS.md"]


def test_prepend_requires_utf8_original(workdir: Path):
    target = workdir / "AGENTS.md"
    target.write_bytes(b"\xff\xfe")
    with pytest.raises(HarnessError) as exc:
        project_instructions(workdir, "AGENTS.md", "x", mode="prepend")
    assert exc.value.code == "instruction-conflict"
    assert target.read_bytes() == b"\xff\xfe"
    assert not (workdir / LOCK).exists()


def test_projection_blocks_prepare_until_restored(workdir: Path):
    projection = project_instructions(workdir, "AGENTS.md", "x")
    with pytest.raises(HarnessError) as exc:
        prepare_command(_bc(workdir, None))
    assert exc.value.code == "instruction-conflict"
    restore_projected_instructions(projection)
    cleanup_command(prepare_command(_bc(workdir, None)))


# ── write_instructions ──────────────────────────────────────────────────────


def test_write_instructions_creates_exclusively_and_persists(workdir: Path):
    assert write_instructions(workdir, "AGENTS.md", None) is None
    path = write_instructions(workdir, "docs/AGENTS.md", "")
    assert path == workdir / "docs/AGENTS.md" and path.read_bytes() == b""
    assert not (workdir / LOCK).exists()
    with pytest.raises(HarnessError) as exc:
        write_instructions(workdir, "docs/AGENTS.md", "again")
    assert exc.value.code == "instruction-conflict"
    assert path.read_bytes() == b""


def test_write_instructions_rejects_symlinks_and_running_lease(workdir: Path, tmp_path: Path):
    real = tmp_path / "real.md"
    real.write_text("real")
    (workdir / "link.md").symlink_to(real)
    with pytest.raises(HarnessError) as exc:
        write_instructions(workdir, "link.md", "x")
    assert exc.value.code == "instruction-conflict"
    assert real.read_text() == "real"

    running = prepare_command(_bc(workdir, None))
    with pytest.raises(HarnessError) as exc:
        write_instructions(workdir, "AGENTS.md", "x")
    assert exc.value.code == "instruction-conflict"
    assert not (workdir / "AGENTS.md").exists()
    cleanup_command(running)
    assert (workdir / LOCK).exists() is False
