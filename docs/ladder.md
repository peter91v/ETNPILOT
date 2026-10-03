# Cheap first, verify, climb: the `ladder` step

A `ladder` step runs one agent on a **stack of tiers**. The cheapest tier tries the task, the result is verified, and a
failed verification moves the task up one tier, with the failure report as feedback. The strongest model is the last
rung, not the first.

```yaml
# .etnpilot/workflows/tiered.yaml
name: tiered
steps:
  - id: build
    type: ladder
    agent: builder
    tiers:
      - { model: claude-haiku-4-5-20251001, effort: low }
      - { model: claude-sonnet-5-5, effort: medium }
      - { model: claude-opus-5-5, effort: high }
    verify:                       # all must pass
      - { command: npm test }
      - { reviewer: reviewer }    # an agent that ends with "VERDICT: approve" or "VERDICT: reject"
    maxAttempts: 3                # optional; default: every tier
```

- A tier changes the agent's `model`, `provider` and/or `effort`; the rest of the agent (prompt, tools, skills) is the
  same. The receipt names each attempt `builder.build-t1`, `builder.build-t2`, …
- Verification is a **command** (run in the run's workspace, like a `check` step) and/or a **reviewer agent**. Silence
  from a reviewer is not approval.
- A failed tier leaves its changes in the workspace; the next tier sees them and the failure text, and fixes rather than
  starts over. A tier that stops with an error counts as failed.
- If no tier passes, the step fails (`ladder_exhausted`) and the run stops, with what every tier cost.
- Every attempt is written to the receipt (`ladder-attempt`: tier, model, effort, status, cost, tokens, what was verified).

## A router for the first rung and the depth of checking

```yaml
    router: { agent: triage }
    verify:      [{ command: npm test }, { reviewer: reviewer }]   # used for high risk or an unclear answer
    verifyLight: [{ command: npm run lint }]                       # used when the router says low risk
```

The `triage` agent is asked to classify the task (`difficulty`: simple, medium, complex; `risk`: low, high) and not to do
it. A simple task starts on the first rung, a medium one in the middle, a complex one on the last. Low risk uses
`verifyLight`; a high risk or an answer that cannot be read uses the full `verify`: **an unreadable answer never lowers
the checking**. The decision is in the receipt (`ladder-route`). Give `triage` a cheap model and no tools.

## On the review page

Agents → New workflow → step type **A ladder** builds it without YAML. The same picture is shown on the workflow's card, and
in a run's detail it shows the path that run took: the tiers it tried, which check failed, which tier passed, what each
attempt cost and what the router decided.

## What it costs, measured on your own tasks

```
etnpilot usage --tasks
```

Cost per **finished task**, from the receipts: all spend (including attempts that failed on the way) divided by the runs
that succeeded, in total, by the rung that passed, and by the router's difficulty. Compare a ladder with a plain agent
step on the same kind of work before trusting any rule of thumb, including the ones in videos.

## Checks before and between tiers

- **Baseline.** Before the first tier, the command checks run once on the untouched workspace. If one cannot run there (a missing tool, missing dependencies, no browser), the step stops with `ladder_environment` and no tier is tried. A check that fails for an honest reason (the task is to make it pass) is only noted in the feedback. Switch it off with `baseline: false`.
- **Same failure twice.** If the same command fails in the same way (numbers aside) on two tiers in a row, the step stops with `ladder_stuck`; a stronger model is not changing it.
- A failed command shows the end of its output from both streams, so the reason is visible and not only the build progress.
