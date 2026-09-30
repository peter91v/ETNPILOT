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

## 1b. A conversation

The same provider, through the chat instead of a run. Nothing here has been
done against a live API yet; every feature below has only been seen against
stub providers, so this section is a list of things to *watch*, not things known
to work.

```bash
etnpilot chat
```

It says, before your first message, if the provider the agent would use cannot
run here (no key, a policy that denies it). Then, in order:

1. **A plain question.** `what does @README.md say about tests?` — the file
   should show as `attached README.md`, the answer should come back, and the
   line under it should give tokens and the running total for the conversation.
   No tokens shown means the provider returned no usage, and the budget below
   cannot be enforced for it.
2. **A write.** `create notes.txt containing the word ready` — the approval
   appears in the conversation with the diff. Answer `n` once and see what the
   agent does with a refusal; then ask again and answer `y`.
3. **`/undo`.** `notes.txt` should be gone, and a file you edit by hand between
   the write and the `/undo` should be left alone and named.
4. **Memory.** Ask a follow-up that only makes sense with the earlier turn. Then
   `/compact` and ask another: the model should still know, and
   `etnpilot receipt show` on the summary run should show it used no tool.
5. **Streaming.** Set `stream: true` on the provider (`etnpilot config set
   providers.anthropic.stream true`) and repeat step 1. The answer should
   appear as it is written and not be printed twice. **If the reply is garbled,
   cut short, or the tool loop stops, this is the first thing to switch off.**
6. **Effort.** `/effort high` on Anthropic sends adaptive thinking, which
   models older than the 4.6 generation refuse. The error will say so.
7. **The limit.** `chat.budget.maxTotalTokens` (default 1,000,000) bounds the
   whole conversation, across turns and summaries. Lower it to a few thousand to
   watch it stop a conversation with a sentence, then raise it again.

To keep the first real conversation as a recording the suite can replay for
free, run the equivalent single turns with `etnpilot run --record-fixtures`;
the chat itself does not record yet.

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
