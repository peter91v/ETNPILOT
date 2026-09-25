# The first real run

Everything in `test/` runs against stub providers and a stub GitLab. That is
what makes the suite fast and deterministic, and it is also its limit: a stub
answers the way this project expects, which is exactly the assumption an
end-to-end run is supposed to test.

This is the walkthrough for a run against a real provider and a real GitLab,
and the place to record what broke. **It is not a claim that this has been
done.** Where a step has been carried out, it says so and against what; where
it has not, it says that too. Filling this in is the point of the document.

## What is already proven, and where

| Claim | Evidence | Where |
| --- | --- | --- |
| Runs on Node 26 and Android/arm64 | 196 of 201 tests green, all five failures one cause (no CodeGraph bundle for Android) — since fixed | Termux, 2026-09-23 |
| `node:sqlite`, the queue and the inbox work there | `etnpilot doctor` reports `ready`, `sqlite: true` | Termux, 2026-09-23 |
| A real OpenAI call reaches a real model | a run failed at `plan` with the server's own 400 about `reasoning_effort`, which only a real endpoint produces | Termux, 2026-09-24 |
| The review page works on a phone | driven in Chromium at 412px, every control | this repository |
| A real GitLab instance accepts what a run publishes | **nothing** | — |
| A run completes end to end against a real provider | **nothing** | — |

The last two rows are the open ones, and the second-largest is the first: a
run that plans, writes, checks and publishes, with a person approving it.

## Before you start

Money and access. A real run spends provider tokens and can open a real merge
request. Do it on a branch and a project you are willing to have written to.

```bash
etnpilot doctor
```

It answers whether a run could start here at all: the Node version,
`node:sqlite`, git, and — the part that matters — the provider a run would
actually route to, whether the policy allows it, and whether its key resolves.
`ready: false` here means the run will fail; fix it before spending anything.

## 1. A provider that answers

```bash
export OPENAI_API_KEY=sk-...          # or ANTHROPIC_API_KEY
etnpilot config set defaultProvider openai   # stays local, never committed
etnpilot check doctor
```

Then the smallest possible run, with no workflow and no git:

```bash
etnpilot run --agent orchestrator "Write a one-line file called hello.txt"
```

What to look for, in order:

- It asks for approval before writing. If it does not, the policy is not doing
  its job — `etnpilot policy check --kind write --path hello.txt` says what it
  thinks.
- The file exists afterwards. A run that reports `succeeded` and wrote nothing
  is the failure mode this project has hit most often; `expect: tool-use` on a
  workflow step is the mechanical guard against it.
- `etnpilot receipt show` names the provider, the model, the tokens and the
  cost. `not priced` means `observability.pricing.models` has no rate for that
  model — the settings page fills the known ones in.

**Known to break here:** a reasoning model that applies its own
`reasoning_effort` refuses function tools on `/v1/chat/completions`. The error
says which setting fixes it; see `docs/trying-it-out.md`.

## 2. A workflow, in a worktree

```bash
etnpilot run "Add a CHANGELOG entry for the current version"
```

Now it runs the project's steps — plan, build, test, review — in a worktree of
its own rather than in the checkout. What to look for:

- `etnpilot worktree list` shows it, with what it holds.
- Each step's agent appears in the receipt, and `a` in the terminal interface
  (or a click on the page) opens what that agent actually produced.
- The `test` step runs the project's own command. A check that fails with
  `126` or `127` is usually the environment, not the code: the failure names
  the inherited variables.

## 3. A real GitLab

```bash
etnpilot config set git.baseUrl https://gitlab.example.com
etnpilot config set git.project group/project
export ETNPILOT_GITLAB_TOKEN=glpat-...
etnpilot merge list        # reads without writing: the safe first call
```

If that lists merge requests, the token, the URL and the project all resolve.
Only then let a run publish. What to look for:

- The merge rehearsal before publishing: `clean`, `conflicts`, or never
  attempted. Three states, and the surfaces say which.
- What the run opened is a draft, on a branch under `etnpilot/`.
- `etnpilot pipeline status` for what CI made of it.

## 4. Verify the evidence

```bash
etnpilot receipt verify .etnpilot/state/runs/<file>.jsonl
etnpilot attest .etnpilot/state/runs/<file>.jsonl
```

Or `v` on the open run in the terminal interface, or **Verify** on the page.
With no public key configured, this checks the hash chain and says plainly
that it did not check signatures.

## What broke

Record it here, with the date and the platform. A walkthrough nobody has
walked is a wish; this section is what turns it into a report.

### 2026-09-23 — Termux, Android/arm64, Node 26.3.1

Five test failures, one cause: no CodeGraph bundle exists for this platform,
and an optional index took the whole run down with it. Fixed — the index is
optional again. Node 26 and Android/arm64 are considered exercised.

### 2026-09-24 — Termux, Android/arm64, OpenAI

Six distinct failures, each now fixed and each with a test:

1. A configured-but-unused provider with a missing key failed *every* run at
   registration, not the run that used it.
2. A refused call reported only `Provider request failed (401)`. The server's
   own message was thrown away — and it was the useful half.
3. A named-but-unmapped `apiKeySecret` silently read the generic environment
   variable instead of refusing.
4. `doctor` reported `ready: true` while a run failed, because it never
   resolved the route the run would take.
5. A failed check reported an exit code and nothing else. `126` on Android was
   `env: 'node': Permission denied`, which needed `LD_PRELOAD` inherited.
6. A reasoning model refused function tools because of a `reasoning_effort`
   this adapter could not set at all.

Still open from that day: no step of a run reached GitLab, because the run
never got past `plan`.

### Not yet done

A complete run against a real provider, and anything at all against a real
GitLab instance. Until those two lines are filled in, this project's
end-to-end behaviour is an expectation rather than an observation, and the
table at the top of this file says so rather than implying otherwise.
