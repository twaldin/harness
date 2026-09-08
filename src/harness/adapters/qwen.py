"""qwen adapter — invokes the `qwen` CLI in print mode.

`qwen -p PROMPT --output-format json` emits a JSON array on stdout where the
last item with `type='result'` carries usage: `{"input_tokens": N, "output_tokens": M}`.
Alibaba Cloud does not embed pricing in the response.

Interactive sessions are recorded by qwen-code's ChatRecordingService as
`<runtime>/projects/<sanitizeCwd(projectRoot)>/chats/<sessionId>.jsonl`, where
`<runtime>` is `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else `~/.qwen`, and
`sanitizeCwd` replaces every non-alphanumeric character with `-`. Sanitised
paths can collide, so every record carries the literal `cwd` and discovery
rejects sessions recorded for another project.
"""
from __future__ import annotations

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
from harness.util import last_non_empty_join

_AUTH_RE = re.compile(r"Qwen OAuth|API Key", re.IGNORECASE)
_AUTH_ACTION_RE = re.compile(r"Discontinued|switch", re.IGNORECASE)
_PROMPT_RE = re.compile(r"Type your message|>\s*$|❯\s*$", re.IGNORECASE | re.MULTILINE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit|quota", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"thinking|working", re.IGNORECASE)


class QwenAdapter(Adapter):
    name = "qwen"
    instructions_filename = "QWEN.md"
    permission_bypass_args = ("-y",)
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@qwen-code/qwen-code"),
        update_command=("npm", "install", "-g", "@qwen-code/qwen-code@latest"),
        version_command=("qwen", "--version"),
    )

    DEFAULT_MODEL = "qwen3-coder"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = ["-p", spec.prompt, *resolved.permission_args, "-m", resolved.model, "--output-format", "json"]
        return self.finalize_command(spec, cmd="qwen", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, raw = _parse_qwen_stats(outcome.stdout)
        return {
            "cost_usd": None,
            "tokens_in": tokens_in if raw is not None else None,
            "tokens_out": tokens_out if raw is not None else None,
            "raw": raw,
        }

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last30 = last_non_empty_join(pane, 30)
        # Auth dialog (OAuth discontinued / API key prompt)
        if _AUTH_RE.search(last30) and _AUTH_ACTION_RE.search(last30):
            return "dialog"
        if _PROMPT_RE.search(last30):
            return "ready"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        # Auth dialog needs the user — None so the consumer surfaces it.
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        last10 = last_non_empty_join(pane, 10)
        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _SPINNER_RE.search(last10) or _WORKING_RE.search(last10):
            return "running"
        if _PROMPT_RE.search(last10):
            return "idle"
        return "unknown"

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        roots = _project_roots(workdir)
        projects = _qwen_runtime_dir(workdir) / "projects"
        best: tuple[float, str, Path] | None = None
        for chats in dict.fromkeys(projects / _sanitize_cwd(root) / "chats" for root in roots):
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
                if _session_cwd(entry) not in roots:
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

        records = _qwen_records(raw_text)
        if records is not None:
            tokens_in, tokens_out, model = _records_usage(records)
            cost = derive_cost(model, tokens_in, tokens_out) if tokens_in is not None else None
            return SessionTelemetry(path, tokens_in, tokens_out, cost, model, records)

        stats = _parse_qwen_stats_blob(raw_text)
        if stats["tokens_in"] is not None and stats["tokens_out"] is not None:
            return SessionTelemetry(
                path,
                stats["tokens_in"],
                stats["tokens_out"],
                stats["cost_usd"],
                stats["model"],
                stats["raw"],
            )

        try:
            raw = json.loads(raw_text)
            return SessionTelemetry(path, None, None, None, None, raw)
        except json.JSONDecodeError:
            return SessionTelemetry(path, None, None, None, None, None)


# SessionService.SESSION_FILE_PATTERN: sidecars (.runtime.json, .ledger.jsonl, .pr.json) never match.
_SESSION_FILE_RE = re.compile(r"^[0-9a-fA-F-]{32,36}\.jsonl$")
_RUNTIME_SNAPSHOT_PREFIX = "$runtime|"
_MAX_SAFE_INTEGER = 9007199254740991


def _sanitize_cwd(cwd: str) -> str:
    # JavaScript's sanitizer replaces UTF-16 units, including both surrogate halves.
    return re.sub(r"[^a-zA-Z0-9]", lambda match: "--" if ord(match[0]) > 0xFFFF else "-", cwd)


def _resolve_qwen_path(value: str, cwd: Path) -> Path:
    """`Storage.resolvePath`: leading `~` expands to the home dir; relative paths resolve against the CLI cwd."""
    if value == "~" or value.startswith(("~/", "~\\")):
        return Path.home().joinpath(*[part for part in re.split(r"[/\\]+", value[2:]) if part])
    path = Path(value)
    return path if path.is_absolute() else Path(os.path.abspath(cwd / path))


def _qwen_runtime_dir(workdir: Path) -> Path:
    """`Storage.getRuntimeBaseDir()`: `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else `~/.qwen`.

    The settings-file `runtimeOutputDir` override is not consulted.
    """
    runtime = os.environ.get("QWEN_RUNTIME_DIR")
    if runtime:
        return _resolve_qwen_path(runtime, workdir)
    home = os.environ.get("QWEN_HOME")
    if home:
        return _resolve_qwen_path(home, workdir)
    return Path.home() / ".qwen"


def _project_roots(workdir: Path) -> list[str]:
    """Spellings qwen-code may have used as the project root (`path.resolve(process.cwd())`, physical path first)."""
    absolute = os.path.abspath(workdir)
    try:
        real = os.path.realpath(workdir)
    except OSError:
        real = absolute
    return [real] if real == absolute else [real, absolute]


def _session_cwd(path: Path) -> str | None:
    """`cwd` of the first record; qwen-code's own project-membership check reads the same field."""
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    record = json.loads(line)
                    break
            else:
                return None
    except (OSError, ValueError):
        return None
    cwd = record.get("cwd") if isinstance(record, dict) else None
    return cwd if isinstance(cwd, str) else None


def _qwen_records(text: str) -> list[dict] | None:
    """Parse a chats/ JSONL transcript; None when no line is a ChatRecord.

    Records are keyed by `uuid` (last write wins) so a re-emitted record is
    never counted twice.
    """
    records: dict[str, dict] = {}
    for index, line in enumerate(text.splitlines()):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or not isinstance(record.get("type"), str) or not isinstance(record.get("sessionId"), str):
            continue
        uuid = record.get("uuid")
        records[uuid if isinstance(uuid, str) else f"line:{index}"] = record
    return list(records.values()) if records else None


def _usage_count(value: object) -> int | None:
    """Nonnegative safe integer; an absent field counts as 0 (upstream `?? 0`)."""
    if value is None:
        return 0
    if type(value) in (int, float) and 0 <= value <= _MAX_SAFE_INTEGER and int(value) == value:
        return int(value)
    return None


def _records_usage(records: list[dict]) -> tuple[int | None, int | None, str | None]:
    """Sum `usageMetadata.{promptTokenCount,candidatesTokenCount}` over assistant records.

    Only per-turn `usageMetadata` is counted; `ui_telemetry` and other system
    snapshots are cumulative views of the same usage and are ignored. None until
    any assistant record reports usage.
    """
    tokens_in: int | None = None
    tokens_out: int | None = None
    model: str | None = None
    usage_models: set[str | None] = set()
    for record in records:
        if record.get("type") != "assistant":
            continue
        record_model: str | None = None
        name = record.get("model")
        if isinstance(name, str) and name:
            while name.startswith(_RUNTIME_SNAPSHOT_PREFIX):
                stripped = "|".join(name.split("|")[2:])
                if not stripped:
                    break
                name = stripped
            model = name
            record_model = name
        usage = record.get("usageMetadata")
        if usage is None:
            continue
        if not isinstance(usage, dict):
            return None, None, model
        count_in = _usage_count(usage.get("promptTokenCount"))
        count_out = _usage_count(usage.get("candidatesTokenCount"))
        if count_in is None or count_out is None:
            return None, None, model
        usage_models.add(record_model)
        tokens_in = (tokens_in or 0) + count_in
        tokens_out = (tokens_out or 0) + count_out
        if tokens_in > _MAX_SAFE_INTEGER or tokens_out > _MAX_SAFE_INTEGER:
            return None, None, model
    if usage_models:
        model = next(iter(usage_models)) if len(usage_models) == 1 else None
    return tokens_in, tokens_out, model


def _parse_qwen_stats_blob(blob: str) -> dict:
    """Extract token/cost/model from a qwen stats envelope (`stats.models[*]`).

    Mirrors the TS `parseQwenStatsBlob`. Returns a dict with keys
    `tokens_in`, `tokens_out`, `cost_usd`, `model`, `raw`. Token fields are
    None when the blob can't be interpreted as a stats envelope.
    """
    try:
        parsed = json.loads(blob)
    except json.JSONDecodeError:
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": None}
    return _stats_from_parsed(parsed)


def _stats_from_parsed(parsed: object) -> dict:
    if not isinstance(parsed, dict):
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    stats = parsed.get("stats")
    models = stats.get("models") if isinstance(stats, dict) else None
    if not isinstance(models, dict):
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    tokens_in = 0
    tokens_out = 0
    model: str | None = None
    for name, model_stats in models.items():
        if not isinstance(model_stats, dict):
            continue
        if model is None:
            model = name
        tokens = model_stats.get("tokens") or {}
        tokens_in += int(tokens.get("input") or 0)
        tokens_out += int(tokens.get("candidates") or 0)

    return {
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": derive_cost(model, tokens_in, tokens_out),
        "model": model,
        "raw": parsed,
    }


def _parse_qwen_stats(stdout: str) -> tuple[int, int, list | dict | None]:
    """Parse qwen's --output-format json output.

    Current qwen emits a JSON array where the last item with `type="result"`
    carries `usage.{input_tokens, output_tokens}`. Older qwen versions emit a
    JSON envelope object with `stats.models[*].tokens.{input, candidates}`;
    we keep a fallback for that for backwards compatibility.
    """
    candidates: list[str] = [stdout.strip()]
    for ln in stdout.splitlines():
        s = ln.strip()
        if s.startswith("[") or s.startswith("{"):
            candidates.append(s)

    for blob in candidates:
        if not blob:
            continue
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            continue

        if isinstance(parsed, list):
            for item in reversed(parsed):
                if not isinstance(item, dict) or item.get("type") != "result":
                    continue
                usage = item.get("usage") or {}
                tokens_in = int(usage.get("input_tokens") or 0)
                tokens_out = int(usage.get("output_tokens") or 0)
                return tokens_in, tokens_out, parsed
            continue

        if isinstance(parsed, dict):
            stats = _stats_from_parsed(parsed)
            if stats["tokens_in"] is None:
                continue
            return stats["tokens_in"], stats["tokens_out"], parsed

    return 0, 0, None
