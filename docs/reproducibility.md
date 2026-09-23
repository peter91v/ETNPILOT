# Dry runs, fixtures, and replay

Three related modes answer three different questions.

## Dry run — "what would this do?"

```bash
etnpilot run "Upgrade the database driver" --dry-run
```

A dry run executes the workflow and evaluates policy exactly as a real run
does, but every operation that is not a plain read is refused:

```json
{ "kind": "reject", "reason": "Dry run: 'write' operations are not executed.", "dryRun": true, "wouldBe": "human-required" }
```

`wouldBe` records the decision the policy would have reached, so the receipt
shows what the run intended without anything happening. Checks are recorded as
skipped rather than executed, the terminal receipt carries `"mode": "dry-run"`,
and publishing is refused outright.

## Fixtures — "run this again without the provider"

```bash
etnpilot run "Add a changelog entry" --record-fixtures .etnpilot/state/fixtures/run.json
etnpilot run "Add a changelog entry" --fixtures .etnpilot/state/fixtures/run.json
```

Recording captures each provider answer. Replay serves those answers instead of
calling any provider, which makes the run offline and deterministic — useful
for reproducing a failure, for testing a workflow change against a known set of
answers, and for demonstrating a run without spending tokens.

Fixtures are redacted before they are written: credential-looking text is
masked and the raw provider payload is dropped, because a fixture file is meant
to be shareable evidence rather than a second copy of the project's secrets.
Set `fixtures.redact: false` to keep the unmasked text, and understand what
that means for the file.

Each exchange stores a hash of the input it answered. Replaying with a
different task fails:

```
Recorded input for agent 'worker' does not match this run.
The fixture is stale; re-record it or replay with strict matching disabled.
```

Set `fixtures.strict: false` to replay anyway. A stale fixture that replays
silently would be a lie about what happened.

## Replay — "does the record still hold?"

```bash
etnpilot replay .etnpilot/state/runs/<run-id>.jsonl --root .
```

A model's answer cannot be replayed, and pretending otherwise would be
dishonest. What a receipt does capture exactly is the deterministic half of a
run: which checks ran and what they returned. `etnpilot replay` verifies the
receipt chain, re-runs those checks against a workspace, and reports drift:

```json
{ "checks": [{ "id": "verify", "verdict": "drifted", "recorded": { "exitCode": 0 }, "replayed": { "exitCode": 4 } }], "drifted": ["verify"] }
```

It exits non-zero when the receipt does not verify or any check has drifted.
