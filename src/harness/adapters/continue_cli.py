"""Continue headless adapter; see SPEC.md and ADAPTER-MATRIX.md.

`--model` selects a Hub slug, not a provider model ID; an empty default
delegates to upstream config. Projected instructions require `--rule`.
`--format json` contains model output, never trustworthy usage/cost.

Session artifacts (continuedev/continue@5522c6f, `extensions/cli/src/session.ts`
and `core/util/{history,paths}.ts`): `<CONTINUE_GLOBAL_DIR or ~/.continue>/sessions/
<uuid>.json` holding `{sessionId, title, workspaceDirectory, history, usage?}`
where `workspaceDirectory` is the `cn` process cwd and `usage` is the CLI's own
cumulative `{totalCost, promptTokens, completionTokens, ...}`. `sessions.json`
in the same directory is the upstream index, not a session. The CLI never
persists a model id (`chatModelTitle` is unset), so `model` stays null.
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
    HarnessError,
    InstallMeta,
    ParsedOutput,
    ReadyState,
    RunSpec,
    SessionTelemetry,
)
from harness.util import last_non_empty_join, strip_ansi

_MODEL_LOADING_RE = re.compile(r"Model:\s*Loading", re.IGNORECASE)
_ASK_ANYTHING_RE = re.compile(r"Ask anything", re.IGNORECASE)
_UPDATE_RE = re.compile(r"Update available", re.IGNORECASE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"thinking|working", re.IGNORECASE)


def _is_hub_slug(model: str) -> bool:
    """`cn --model` takes a Continue Hub slug: exactly `owner/package`."""
    owner, sep, package = model.partition("/")
    return bool(sep and owner and package and "/" not in package)


def _is_compaction_status_line(line: str) -> bool:
    """A standalone `{status, message, ...}` line `cn` prints to stdout while
    (auto-)compacting before the final response (commands/chat.ts)."""
    if not line.startswith("{"):
        return False
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return False
    return isinstance(obj, dict) and isinstance(obj.get("status"), str)


def _parse_headless_json(stdout: str) -> object | None:
    """The final JSON `cn --format json` prints: the model text verbatim when
    it parsed as JSON upstream, else the `{response, status, note}` wrapper.
    Leading compaction status lines are skipped; anything else is None."""
    text = stdout.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    lines = text.split("\n")
    start = 0
    while start < len(lines) - 1 and _is_compaction_status_line(lines[start].strip()):
        start += 1
    if start == 0:
        return None
    try:
        return json.loads("\n".join(lines[start:]))
    except json.JSONDecodeError:
        return None


def continue_sessions_dir() -> Path:
    """`<CONTINUE_GLOBAL_DIR or ~/.continue>/sessions`; a relative override resolves against the process cwd."""
    override = os.environ.get("CONTINUE_GLOBAL_DIR")
    home = os.path.abspath(override) if override else os.path.join(os.path.expanduser("~"), ".continue")
    return Path(home) / "sessions"


def _read_json_object(path: Path) -> dict | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _to_int(v: object) -> int | None:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _to_float(v: object) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None



class ContinueCliAdapter(Adapter):
    name = "continue-cli"
    instructions_filename = "CONTINUE.md"
    submit_keys = ("Enter",)
    config_file_flag = "--config"
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@continuedev/cli"),
        update_command=("npm", "install", "-g", "@continuedev/cli@latest"),
        version_command=("cn", "--version"),
    )

    #: Empty means "upstream selection": no `--model`, reported model None.
    DEFAULT_MODEL = ""
    permission_bypass_args = ("--auto",)

    def reported_model(self, spec: RunSpec) -> str | None:
        # The model comes from the caller config or Continue's own config
        # unless an explicit Hub slug was requested.
        if spec.config_file is not None or not (spec.model or "").strip():
            return None
        return spec.model

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        instructions_file = self.planned_instructions_file(spec)
        rule_args = () if instructions_file is None else ("--rule", str(instructions_file))

        if spec.config_file is not None:
            if spec.model:
                raise HarnessError(
                    "continue-cli cannot honor both config_file and an explicit model (cn --model expects a Continue Hub "
                    "slug); select the model inside the config file and leave model unset",
                    code="unsupported-capability",
                )
            args = ["-p", *resolved.config_args, *resolved.permission_args, *rule_args, "--format", "json", spec.prompt]
            return self.finalize_command(spec, cmd="cn", args=args)

        if "OPENAI_API_KEY" in spec.env or "OPENAI_BASE_URL" in spec.env:
            raise HarnessError(
                "continue-cli with OPENAI_API_KEY/OPENAI_BASE_URL in env requires a caller-selected config_file; harness "
                "does not generate Continue config",
                code="unsupported-capability",
            )

        model_args: tuple[str, ...] = ()
        if resolved.model:
            if not _is_hub_slug(resolved.model):
                raise HarnessError(
                    f"continue-cli --model takes a Continue Hub slug (owner/package), not the native model id "
                    f"{resolved.model!r}; pass a Hub slug, or leave model unset and select the model in a Continue "
                    "config (config_file -> --config)",
                    code="unsupported-capability",
                )
            model_args = ("--model", resolved.model)

        args = ["-p", spec.prompt, *resolved.permission_args, *model_args, *rule_args, "--format", "json"]
        return self.finalize_command(spec, cmd="cn", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        # Headless JSON is model-generated text; any usage/cost-looking fields
        # in it are not CLI telemetry.
        return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": _parse_headless_json(outcome.stdout)}

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        absolute = os.path.abspath(workdir)
        try:
            resolved = os.path.realpath(absolute, strict=True)
        except OSError:
            resolved = absolute
        # Distinct case-sensitive POSIX paths must not share telemetry.
        wanted = {absolute, resolved}

        try:
            entries = list(continue_sessions_dir().iterdir())
        except OSError:
            return None
        candidates: list[tuple[float, Path]] = []
        for p in entries:
            try:
                if p.suffix != ".json" or p.name == "sessions.json" or not p.is_file():
                    continue
                mtime = p.stat().st_mtime
            except OSError:
                continue
            if session_started_after is not None and mtime < session_started_after:
                continue
            candidates.append((mtime, p))
        for _, p in sorted(candidates, reverse=True):
            session = _read_json_object(p)
            workspace = session.get("workspaceDirectory") if session else None
            if isinstance(workspace, str) and workspace in wanted:
                return str(p)
        return None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        session = _read_json_object(Path(path))
        usage = session.get("usage") if session else None
        if not isinstance(usage, dict):
            return SessionTelemetry(path, None, None, None, None, None)
        return SessionTelemetry(
            path,
            _to_int(usage.get("promptTokens")),
            _to_int(usage.get("completionTokens")),
            _to_float(usage.get("totalCost")),
            None,
            usage,
        )

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last20 = last_non_empty_join(pane, 20)
        # cn shows "Ask anything" placeholder while the model is still loading.
        # Real ready = input visible AND model loaded (no "Model: Loading..." line).
        if _MODEL_LOADING_RE.search(last20):
            return "loading"
        if _ASK_ANYTHING_RE.search(last20):
            return "ready"
        if _UPDATE_RE.search(last20):
            return "dialog"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        if _UPDATE_RE.search(strip_ansi(pane)):
            return ["Escape"]
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        last10 = last_non_empty_join(pane, 10)
        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _SPINNER_RE.search(last10) or _WORKING_RE.search(last10):
            return "running"
        if _ASK_ANYTHING_RE.search(last10):
            return "idle"
        return "unknown"
