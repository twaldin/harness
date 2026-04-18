# hone — HarnessMutator

[hone](https://github.com/twaldin/hone) is a prompt-optimization tool wrapping GEPA. It uses `harness` as one of its mutator backends so any registered adapter (claude-code, gemini, …) can propose new prompt variants without hone owning per-CLI subprocess plumbing.

## How hone uses harness

```python
# src/hone/mutators/harness_mutator.py (excerpt)
from harness import HarnessError, RunSpec, run

class HarnessMutator(Mutator):
    def propose(self, mutator_prompt: str) -> MutatorResult:
        with tempfile.TemporaryDirectory() as wd:
            spec = RunSpec(
                harness=self.harness_name,
                prompt=mutator_prompt,
                workdir=Path(wd),
                model=self.model,
                timeout_seconds=self.timeout_seconds,
            )
            result = run(spec)
        if not result.ok:
            raise MutatorError(...)
        return MutatorResult(
            new_prompt=_extract_response(self.harness_name, result),
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            cost_usd=result.cost_usd,
            raw_response=result.stdout,
        )
```

## CLI use

```bash
hone run prompt.md \
    --grader ./grade.sh \
    --mutator harness:claude-code:sonnet \
    --budget 20
```

`--mutator harness:<adapter>:<model>` dispatches every mutation through `harness.run()`. `harness:gemini:gemini-2.5-pro` swaps to a different LLM with no other changes.

## What hone gets out of this

Token + cost accounting comes from the adapter's native parser (e.g. claude-code's `--output-format json` envelope, opencode's session DB). hone doesn't reimplement any of it. Adding gemini support to hone was a one-line registry addition once the `gemini` adapter shipped in harness.

See full [hone README](https://github.com/twaldin/hone) for the optimization loop details.
