# Keeping a project tidy

`.etnpilot/state/` grows: one receipt file per run, and telemetry files that rotate at `observability.rotateBytes`.

```bash
etnpilot gc                       # shows what could go; deletes nothing
etnpilot gc --older-than 30 --keep 20
etnpilot gc --apply               # deletes exactly what was shown
```

A file is a candidate only when it is older than `--older-than` days (default 90), is not among the newest `--keep`
(default 50), and, for receipts, is **sealed** (the run finished). Receipts of runs that did not finish are kept:
they may be running, or worth looking at. Rotated telemetry files are candidates once old; they hold the cost
history that `etnpilot usage` reads, so deleting them shortens that history.

A receipt is the record of what an agent did. Once it is deleted, `etnpilot receipts verify` has nothing to
verify, so keep a copy of anything you may need as evidence.
