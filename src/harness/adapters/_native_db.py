"""Shared plumbing for the sqlite-backed adapters (opencode, kilo, crush).

Telemetry is correlated through the native session ID the CLI itself reports
for the run; every query is keyed on that exact ID. Nothing here guesses a
session from the workdir, the newest row or the DB filename.
"""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import stat
import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import TypeVar
from urllib.parse import unquote

from harness.base import SessionTelemetry, absolute_workdir

T = TypeVar("T")

#: (tokens_in, tokens_out, cost_usd, model) — each None when unavailable.
SessionTotals = tuple[int | None, int | None, float | None, str | None]
NO_TOTALS: SessionTotals = (None, None, None, None)

#: Upper bound on any single sqlite wait and on a whole discovery pass.
DB_TIMEOUT_SECONDS = 5.0
#: `<cli> run --format json` event envelopes that carry a top-level `sessionID`
#: (packages/opencode/src/cli/cmd/run.ts `emit()`).
_RUN_EVENT_TYPES = frozenset({"step_start", "step_finish", "text", "reasoning", "tool_use", "error"})
_SELECTOR = "#session="
_BAD_PERCENT_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")


# ---- environment / paths -------------------------------------------------


def effective_env(extra_env: dict[str, str] | None) -> dict[str, str]:
    """The environment the CLI child saw: inherited, overridden by the caller's
    additions (including explicit empty values)."""
    return {**os.environ, **(extra_env or {})}


def xdg_data_dir(env: dict[str, str], app: str, workdir: Path, *, strip_newlines: bool = False) -> Path:
    """Upstream `Global.Path.data`: `xdg-basedir`'s data home plus the app name.

    `xdg-basedir` is `env.XDG_DATA_HOME || join(os.homedir(), '.local', 'share')`
    with no absoluteness check, so a relative value is honored and lands
    relative to the child's cwd, the workdir. Kilo additionally strips newlines
    from the resolved value (upstream `kilocode_change`).
    """
    data_home = env.get("XDG_DATA_HOME")
    if not data_home:
        home = env["HOME"] if "HOME" in env else str(Path.home())
        data_home = os.path.join(home, ".local", "share")
    if strip_newlines:
        data_home = re.sub(r"[\r\n]+", "", data_home)
    return absolute_workdir(workdir) / data_home / app


def resolve_native_db(override: str, data_dir: Path) -> Path | None:
    """Upstream `Database.path()` for a nonempty `OPENCODE_DB` / `KILO_DB`:
    `:memory:` has no readable artifact, absolute paths are verbatim and
    relative ones join the data dir. No `~` expansion, as upstream."""
    if override == ":memory:":
        return None
    if os.path.isabs(override):
        return Path(override)
    return data_dir / override


def channel_db_disabled(env: dict[str, str], flag: str) -> bool:
    return env.get(flag) in ("1", "true")


# ---- identity --------------------------------------------------------------


def native_session_id_from_events(stdout: str) -> str | None:
    """The one `sessionID` the `--format json` event stream reports.

    Only recognised run events count; ordinary text, malformed JSON and unknown
    event types are ignored. Conflicting IDs (across events, or between the
    envelope and its `part.sessionID`) invalidate the correlation.
    """
    ids: set[str] = set()
    for line in stdout.split("\n"):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if not isinstance(kind, str) or kind not in _RUN_EVENT_TYPES:
            continue
        session_id = event.get("sessionID")
        if not isinstance(session_id, str) or not session_id:
            continue
        part = event.get("part")
        if isinstance(part, dict) and "sessionID" in part and part["sessionID"] != session_id:
            return None
        ids.add(session_id)
    return next(iter(ids)) if len(ids) == 1 else None


def parse_session_selector(path: str) -> tuple[Path, str] | None:
    """Split an explicit `<db path>#session=<percent-encoded ID>` selector on
    its last `#session=` so DB filenames may contain `#`. None for a bare DB
    path, the retired `#session(basename)` hint, malformed percent encoding or
    an empty ID."""
    db_raw, sep, encoded = path.rpartition(_SELECTOR)
    if not sep or _BAD_PERCENT_RE.search(encoded):
        return None
    try:
        session_id = unquote(encoded, errors="strict")
    except UnicodeDecodeError:
        return None
    if not session_id:
        return None
    return Path(db_raw), session_id


# ---- sqlite access ---------------------------------------------------------


def read_only(db_path: Path, read: Callable[[sqlite3.Connection], T], *, timeout: float = DB_TIMEOUT_SECONDS) -> T | None:
    """Run `read` against `db_path` opened read-only with a bounded busy
    timeout; None when the file is missing or sqlite refuses/fails."""
    if not db_path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"{db_path.absolute().as_uri()}?mode=ro", uri=True, timeout=timeout)
    except (sqlite3.Error, ValueError):
        return None
    try:
        return read(conn)
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def discover_session_db(data_dir: Path, session_id: str, *, channel_db: str, channel_disabled: bool) -> Path | None:
    """Locate the DB holding `session_id` when no explicit override names one.

    Upstream picks its filename from a build-time release channel that the run
    output never exposes, so the direct `*.db` files under the data dir are
    checked for the exact session row. Exactly one hit wins; none, several, or
    any candidate that cannot be inspected within the shared time budget
    leaves the run unattributed rather than guessed.
    """
    if channel_disabled:
        return data_dir / channel_db
    try:
        entries = sorted(data_dir.iterdir())
    except OSError:
        return None
    deadline = time.monotonic() + DB_TIMEOUT_SECONDS
    matches: list[Path] = []
    for entry in entries:
        if entry.suffix != ".db":
            continue
        try:
            if not stat.S_ISREG(entry.stat().st_mode):
                continue
        except OSError:
            return None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        found = read_only(entry, lambda conn: _session_exists(conn, session_id), timeout=remaining)
        if found is None:
            return None
        if found:
            matches.append(entry)
    return matches[0] if len(matches) == 1 else None


def _session_exists(conn: sqlite3.Connection, session_id: str) -> bool:
    return conn.execute("SELECT 1 FROM session WHERE id = ?", (session_id,)).fetchone() is not None


# ---- accounting ------------------------------------------------------------


def token_count(value: object) -> int | None:
    """A reported token counter: a finite, nonnegative, integer-valued number."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, float) and math.isfinite(value) and value >= 0 and value.is_integer():
        return int(value)
    return None


def cost_value(value: object) -> float | None:
    """A reported cost: a finite, nonnegative number. Zero is preserved as reported."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    cost = float(value)
    return cost if math.isfinite(cost) and cost >= 0 else None


def unanimous_model(rows: Iterable[tuple[object, object]]) -> str | None:
    """The model ID when every assistant row names the same nonempty model and
    provider; None for no rows, gaps, or a mix."""
    seen: set[tuple[object, object]] = set()
    for model, provider in rows:
        if not (isinstance(model, str) and model and isinstance(provider, str) and provider):
            return None
        seen.add((model, provider))
    if len(seen) != 1:
        return None
    return next(iter(seen))[0]


def read_message_totals(db_path: Path | None, session_id: str) -> SessionTotals:
    """opencode/kilo accounting: sum the assistant `message.data` rows of the
    exact session. A field is available only when every assistant row reports
    a valid value for it; no assistant rows or no session row means all None."""
    if db_path is None:
        return NO_TOTALS

    def read(conn: sqlite3.Connection) -> SessionTotals:
        if not _session_exists(conn, session_id):
            return NO_TOTALS
        rows = conn.execute(
            """
            SELECT CASE WHEN json_type(data, '$.tokens.input') IN ('integer', 'real')
                        THEN json_extract(data, '$.tokens.input') END,
                   CASE WHEN json_type(data, '$.tokens.output') IN ('integer', 'real')
                        THEN json_extract(data, '$.tokens.output') END,
                   CASE WHEN json_type(data, '$.cost') IN ('integer', 'real')
                        THEN json_extract(data, '$.cost') END,
                   CASE WHEN json_type(data, '$.modelID') = 'text'
                        THEN json_extract(data, '$.modelID') END,
                   CASE WHEN json_type(data, '$.providerID') = 'text'
                        THEN json_extract(data, '$.providerID') END
            FROM message
            WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
            """,
            (session_id,),
        ).fetchall()
        if not rows:
            return NO_TOTALS
        tokens_in: int | None = 0
        tokens_out: int | None = 0
        cost: float | None = 0.0
        for raw_in, raw_out, raw_cost, _model, _provider in rows:
            if tokens_in is not None:
                value = token_count(raw_in)
                tokens_in = None if value is None else tokens_in + value
            if tokens_out is not None:
                value = token_count(raw_out)
                tokens_out = None if value is None else tokens_out + value
            if cost is not None:
                value = cost_value(raw_cost)
                cost = None if value is None else cost + value
        return tokens_in, tokens_out, cost, unanimous_model((model, provider) for _, _, _, model, provider in rows)

    return read_only(db_path, read) or NO_TOTALS


# ---- reporting -------------------------------------------------------------


def identity_raw(session_id: str, cost: float | None) -> dict[str, str]:
    """Headless/session `raw`: the native ID plus whether cost is upstream's
    reported figure (a literal 0 included) or unavailable. Never an estimate."""
    return {"sessionID": session_id, "costSource": "reported" if cost is not None else "unavailable"}


def session_telemetry(path: str, session_id: str | None, totals: SessionTotals) -> SessionTelemetry:
    tokens_in, tokens_out, cost, model = totals
    raw = identity_raw(session_id, cost) if session_id is not None else None
    return SessionTelemetry(path, tokens_in, tokens_out, cost, model, raw)
