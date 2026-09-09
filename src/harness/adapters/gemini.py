"""gemini adapter — invokes the `gemini` CLI in print mode.

`gemini -p PROMPT --output-format json` emits a JSON envelope where token
usage lives at `stats.models[*].tokens.{input,candidates}`.

Interactive sessions are recorded by gemini-cli's ChatRecordingService under
`<home>/.gemini/tmp/<project-id>/chats/session-<stamp>-<id8>.jsonl` (legacy
`.json`), where `<home>` is `GEMINI_CLI_HOME` or the user's home and
`<project-id>` is the slug registered in `<home>/.gemini/projects.json`
(older installs: the sha256 hex of the project root). Every record carries
`projectHash = sha256(projectRoot)`, which lets discovery reject sessions that
belong to another project.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from harness._subproc import SubprocOutcome
from harness.base import (
    Adapter,
    AgentStatus,
    BuildCommand,
    InstallMeta,
    ParsedOutput,
    ReadyState,
    RunSpec,
    SessionTelemetry,
)
from harness.pricing import derive_cost
from harness.util import last_non_empty_join, strip_ansi

_APPLY_RE = re.compile(r"Apply this change\?", re.IGNORECASE)
_ALLOW_EXEC_RE = re.compile(r"Allow execution of", re.IGNORECASE)
_ACTION_REQUIRED_RE = re.compile(r"Action Required", re.IGNORECASE)
_ALLOW_RE = re.compile(r"Allow", re.IGNORECASE)
_TRUST_FILES_RE = re.compile(r"Do you trust the files", re.IGNORECASE)
_TRUST_FOLDER_RE = re.compile(r"Trust folder", re.IGNORECASE)
_TYPE_MESSAGE_RE = re.compile(r"Type your message", re.IGNORECASE)
_PROMPT_TAIL_RE = re.compile(r"[>❯]\s*$")
_RATE_LIMIT_RE = re.compile(r"rate.?limit|quota.?exceeded|resource.?exhausted", re.IGNORECASE)
_ERROR_RE = re.compile(r"error", re.IGNORECASE)
_FATAL_RE = re.compile(r"fatal|crash", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⊶⊷]")
_THINKING_RE = re.compile(r"Thinking\.\.\.", re.IGNORECASE)
_READY_RE = re.compile(r"Ready", re.IGNORECASE)
_CHECK_RE = re.compile(r"[✓✔]")


class GeminiAdapter(Adapter):
    name = "gemini"
    instructions_filename = "GEMINI.md"
    permission_bypass_args = ("-y",)
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@google/gemini-cli"),
        update_command=("npm", "install", "-g", "@google/gemini-cli@latest"),
        version_command=("gemini", "--version"),
        platforms=("darwin", "linux"),
    )

    DEFAULT_MODEL = "gemini-2.5-pro"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = ["-p", spec.prompt, *resolved.permission_args, "-m", resolved.model, "--output-format", "json"]
        return self.finalize_command(spec, cmd="gemini", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        for blob in _json_candidates(outcome.stdout):
            stats = _parse_gemini_stats_blob(blob)
            if stats["tokens_in"] is None or stats["tokens_out"] is None:
                continue
            return {
                "cost_usd": stats["cost_usd"],
                "tokens_in": stats["tokens_in"],
                "tokens_out": stats["tokens_out"],
                "raw": stats["raw"],
            }
        return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last20 = last_non_empty_join(pane, 20)
        if _APPLY_RE.search(last20) or _ALLOW_EXEC_RE.search(last20):
            return "dialog"
        if _TYPE_MESSAGE_RE.search(last20):
            return "ready"
        if _PROMPT_TAIL_RE.search(last20):
            return "ready"
        return "loading"

    def detect_status(self, pane: str) -> AgentStatus:
        last20 = last_non_empty_join(pane, 20)
        last10 = last_non_empty_join(pane, 10)

        # Mid-run dialogs (need auto-approve)
        if _APPLY_RE.search(last20) or _ALLOW_EXEC_RE.search(last20):
            return "dialog"
        if _ACTION_REQUIRED_RE.search(last20) and _ALLOW_RE.search(last20):
            return "dialog"
        if _TRUST_FILES_RE.search(last20):
            return "dialog"

        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _ERROR_RE.search(last10) and _FATAL_RE.search(last10):
            return "error"

        # Spinners
        if _SPINNER_RE.search(last10) or _THINKING_RE.search(last10):
            return "running"

        # Idle
        if _TYPE_MESSAGE_RE.search(last10):
            return "idle"
        if _READY_RE.search(last10) and not _SPINNER_RE.search(last10):
            return "idle"
        if _CHECK_RE.search(last10) and not _SPINNER_RE.search(last10):
            return "idle"

        return "unknown"

    def handle_dialog(self, pane: str) -> list[str] | None:
        text = strip_ansi(pane)
        # "Apply this change?" / "Allow execution of X?" / "Action Required" —
        # option 1 (Allow once) is selected by default; Enter accepts.
        if _APPLY_RE.search(text) or _ALLOW_EXEC_RE.search(text):
            return ["Enter"]
        if _ACTION_REQUIRED_RE.search(text) and _ALLOW_RE.search(text):
            return ["Enter"]
        if _TRUST_FILES_RE.search(text) or _TRUST_FOLDER_RE.search(text):
            return ["Enter"]
        return None

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        gemini_dir = _gemini_dir()
        roots = _project_roots(workdir)
        hashes = {_sha256(root) for root in roots}
        best: tuple[float, str, Path] | None = None
        for identifier in _project_identifiers(gemini_dir, roots):
            chats = gemini_dir / "tmp" / identifier / "chats"
            try:
                entries = list(chats.iterdir())
            except OSError:
                continue
            for entry in entries:
                if _SESSION_FILE_RE.match(entry.name) is None:
                    continue
                try:
                    if not entry.is_file():
                        continue
                    mtime = entry.stat().st_mtime
                except OSError:
                    continue
                if session_started_after is not None and mtime < session_started_after:
                    continue
                if best is not None and (mtime, entry.name) <= best[:2]:
                    continue
                if _session_project_hash(entry) not in hashes:
                    continue
                best = (mtime, entry.name, entry)
        return str(best[2]) if best is not None else None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)
        try:
            raw_text = p.read_text(encoding="utf-8")
        except OSError:
            return SessionTelemetry(path, None, None, None, None, None)

        conversation = _gemini_conversation(raw_text)
        if conversation is not None:
            tokens_in, tokens_out, model = _conversation_usage(conversation["messages"])
            cost = derive_cost(model, tokens_in, tokens_out) if tokens_in is not None else None
            return SessionTelemetry(path, tokens_in, tokens_out, cost, model, conversation)

        # Not a chats/ record: accept a headless stats envelope written to a file,
        # otherwise surface whatever JSON is there without inventing usage.
        stats = _parse_gemini_stats_blob(raw_text)
        if stats["tokens_in"] is not None and stats["tokens_out"] is not None:
            return SessionTelemetry(path, stats["tokens_in"], stats["tokens_out"], stats["cost_usd"], stats["model"], stats["raw"])
        try:
            return SessionTelemetry(path, None, None, None, None, json.loads(raw_text))
        except json.JSONDecodeError:
            return SessionTelemetry(path, None, None, None, None, None)


_SESSION_FILE_RE = re.compile(r"^session-.*\.jsonl?$")
_MAX_SAFE_INTEGER = 9007199254740991


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _gemini_dir() -> Path:
    """`Storage.getGlobalGeminiDir()`: `GEMINI_CLI_HOME` (verbatim) or the home dir, plus `.gemini`."""
    override = os.environ.get("GEMINI_CLI_HOME")
    return (Path(override) if override else Path.home()) / ".gemini"


def _project_roots(workdir: Path) -> list[str]:
    """Spellings gemini-cli may have used as the project root for `workdir`.

    The CLI keys everything on `path.resolve(process.cwd())`; `process.cwd()`
    is the physical path, so the realpath comes first and the literal absolute
    path is kept as a fallback.
    """
    absolute = os.path.abspath(workdir)
    try:
        real = os.path.realpath(workdir)
    except OSError:
        real = absolute
    return [real] if real == absolute else [real, absolute]


def _project_identifiers(gemini_dir: Path, roots: list[str]) -> list[str]:
    """Candidate `tmp/<id>` directory names for a project, most authoritative first.

    Registry slug from `projects.json`, then `tmp/*/.project_root` ownership
    markers, then the pre-registry sha256 hash directory.
    """
    identifiers: list[str] = []
    try:
        registry = json.loads((gemini_dir / "projects.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        registry = None
    projects = registry.get("projects") if isinstance(registry, dict) else None
    if isinstance(projects, dict):
        for root in roots:
            slug = projects.get(root)
            if isinstance(slug, str) and re.fullmatch(r"[a-z0-9-]+", slug) and slug not in identifiers:
                identifiers.append(slug)
    try:
        entries = list((gemini_dir / "tmp").iterdir())
    except OSError:
        entries = []
    for entry in entries:
        try:
            owner = (entry / ".project_root").read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if owner in roots and entry.name not in identifiers:
            identifiers.append(entry.name)
    for root in roots:
        digest = _sha256(root)
        if digest not in identifiers:
            identifiers.append(digest)
    return identifiers


def _session_project_hash(path: Path) -> str | None:
    """`projectHash` from the leading metadata record (JSONL) or the legacy whole-file record."""
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    first = line
                    break
            else:
                return None
        try:
            record = json.loads(first)
        except ValueError:
            record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    project_hash = record.get("projectHash") if isinstance(record, dict) else None
    return project_hash if isinstance(project_hash, str) else None


def _gemini_conversation(text: str) -> dict | None:
    """Replay a chats/ record into its final state, mirroring `loadConversationRecord`.

    Message records are keyed by `id` (a re-appended message replaces its
    earlier snapshot in place), `$rewindTo` drops that message and everything
    after it, and a `$set.messages` checkpoint rebuilds the list. Returns None
    when no record shape is recognised.
    """
    records: list[object] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    if not records:
        try:
            records = [json.loads(text)]
        except ValueError:
            return None

    metadata: dict = {}
    messages: dict[str, dict] = {}
    recognised = False

    def put(message: object) -> None:
        if isinstance(message, dict) and isinstance(message.get("id"), str):
            messages[message["id"]] = message

    for record in records:
        if not isinstance(record, dict):
            continue
        if isinstance(record.get("$rewindTo"), str):
            recognised = True
            ids = list(messages)
            cut = ids.index(record["$rewindTo"]) if record["$rewindTo"] in messages else 0
            for message_id in ids[cut:]:
                del messages[message_id]
        elif isinstance(record.get("id"), str):
            recognised = True
            put(record)
        elif isinstance(record.get("$set"), dict):
            recognised = True
            updates = record["$set"]
            if isinstance(updates.get("messages"), list):
                messages.clear()
                for message in updates["messages"]:
                    put(message)
            metadata.update({key: value for key, value in updates.items() if key != "messages"})
        elif isinstance(record.get("sessionId"), str) and isinstance(record.get("projectHash"), str):
            recognised = True
            metadata.update({key: value for key, value in record.items() if key != "messages"})
            if isinstance(record.get("messages"), list):
                for message in record["messages"]:
                    put(message)
    if not recognised:
        return None
    return {**metadata, "messages": list(messages.values())}


def _conversation_usage(messages: list[dict]) -> tuple[int | None, int | None, str | None]:
    """Sum `tokens.{input,output}` over gemini messages; None until any message reports usage."""
    tokens_in: int | None = None
    tokens_out: int | None = None
    model: str | None = None
    usage_models: set[str | None] = set()
    for message in messages:
        if message.get("type") != "gemini":
            continue
        if isinstance(message.get("model"), str) and message["model"]:
            model = message["model"]
        tokens = message.get("tokens")
        if tokens is None:
            continue
        if not isinstance(tokens, dict):
            return None, None, model
        count_in = _gemini_token_count(tokens.get("input"))
        count_out = _gemini_token_count(tokens.get("output"))
        if count_in is None or count_out is None:
            return None, None, model
        usage_models.add(message.get("model") if isinstance(message.get("model"), str) and message["model"] else None)
        tokens_in = (tokens_in or 0) + count_in
        tokens_out = (tokens_out or 0) + count_out
        if tokens_in > _MAX_SAFE_INTEGER or tokens_out > _MAX_SAFE_INTEGER:
            return None, None, model
    if usage_models:
        model = next(iter(usage_models)) if len(usage_models) == 1 else None
    return tokens_in, tokens_out, model


def _json_candidates(stdout: str) -> list[str]:
    """Whole stdout first, then any line that looks like a JSON object."""
    candidates = [stdout.strip()]
    candidates += [ln.strip() for ln in stdout.splitlines() if ln.strip().startswith("{")]
    return [c for c in candidates if c]


def _gemini_token_count(value: object) -> int | None:
    """Accept nonnegative safe integers; preserve decimal-string compatibility."""
    if value is None:
        return 0
    if isinstance(value, str):
        if re.fullmatch(r"\s*\+?[0-9]+\s*", value) is None:
            return None
        try:
            value = int(value)
        except ValueError:
            return None
    if type(value) in (int, float) and 0 <= value <= 9007199254740991 and int(value) == value:
        return int(value)
    return None


def _parse_gemini_stats_blob(blob: str) -> dict:
    """Extract token/cost/model from a gemini stats envelope (`stats.models[*]`).

    Mirrors the TS `parseGeminiStatsBlob`. Token fields are None when the blob
    is not a stats envelope; a stats block that is present but empty reports
    0/0 ("ran but upstream didn't expose usage").
    """
    try:
        parsed = json.loads(blob)
    except json.JSONDecodeError:
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": None}
    if not isinstance(parsed, dict):
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    stats = parsed.get("stats")
    models = stats.get("models") if isinstance(stats, dict) else None
    if not isinstance(models, dict):
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    tokens_in = tokens_out = 0
    model: str | None = None
    for name, model_stats in models.items():
        if not isinstance(model_stats, dict):
            continue
        if model is None:
            model = name
        tokens = model_stats.get("tokens")
        if tokens is None:
            tokens = {}
        if not isinstance(tokens, dict):
            return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}
        count_in = _gemini_token_count(tokens.get("input"))
        count_out = _gemini_token_count(tokens.get("candidates"))
        if count_in is None or count_out is None:
            return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}
        tokens_in += count_in
        tokens_out += count_out
        if tokens_in > 9007199254740991 or tokens_out > 9007199254740991:
            return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    return {
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": derive_cost(model, tokens_in, tokens_out),
        "model": model,
        "raw": parsed,
    }
