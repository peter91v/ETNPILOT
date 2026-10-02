# The first real run

Everything in `test/` runs against stub providers and a stub GitLab. That is
what makes the suite fast and deterministic, and it is also its limit: a stub
answers the way this project expects, which is exactly the assumption an
end-to-end run is supposed to test.

This is the walkthrough for a run against a real provider and a real GitLab,
and the place to record what broke. **The OpenAI chat and complete workflow were exercised on 2026-09-30;
the real GitLab publication remains open.** Where a step has been carried out, it says so and against what; where
it has not, it says that too. Filling this in is the point of the document.

## What is already proven, and where

| Claim | Evidence | Where |
| --- | --- | --- |
| Runs on Node 26 and Android/arm64 | 196 of 201 tests green, all five failures one cause (no CodeGraph bundle for Android) — since fixed | Termux, 2026-09-23 |
| `node:sqlite`, the queue and the inbox work there | `etnpilot doctor` reports `ready`, `sqlite: true` | Termux, 2026-09-23 |
| A real OpenAI call reaches a real model | a run failed at `plan` with the server's own 400 about `reasoning_effort`, which only a real endpoint produces | Termux, 2026-09-24 |
| The review page works on a phone | driven in Chromium at 412px, every control | this repository |
| A real GitLab instance accepts what a run publishes | **nothing** | — |
| A run completes end to end against a real provider | `plan → build → test → review` succeeded; 101,595 tokens, clean merge rehearsal | Termux, OpenAI, 2026-09-30 |

The real GitLab row remains open: publishing a reviewed run to an isolated test
project, checking its pipeline and approvals, and cleaning up the Draft MR and branch.

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

### 2026-09-30 — the chat, on a phone, against OpenAI (`gpt-6-luna`)

The first real conversation. What it showed:

- **It works end to end.** Turns are answered, the tokens are counted (1,340 on one
  turn), a failed turn stays in the thread as a failed turn and the next one
  carries on, and the page is usable on a phone.
- **The known `reasoning_effort` 400 appeared in the chat** ("Function tools with
  reasoning_effort are not supported for gpt-6-luna…"). The error carried no
  advice, which means the effort came from something that was set — the agent's
  `effort:`, `/effort`, or `providers.<name>.reasoningEffort` — not from the
  server's default. The message now says so and how to clear it.
- **"Ich kann in dieser Umgebung keine Dateiänderung direkt ausführen"** for an
  edit of `.etnpilot/etnpilot.yaml`. That was the policy doing its job
  (`protect-etnpilot-governance` denies an agent's writes under `.etnpilot/`), but
  the reply did not say so and the person could not tell it from a model that
  cannot write. Each turn now lists what the agent did and what was refused, and
  why, from the record and not from the reply.
- **"Was gibt es neues bei openai"** was answered from the model's own knowledge:
  the starter agents have no `fetch_url` (it reads text nobody here wrote, so it is
  opt-in). To let an agent read the web: add `fetch_url` to its `tools:` and allow
  the host under `policy.operations`.
- At the time, answers were plain text. The review hardening adds a bounded
  Markdown subset using DOM nodes, with raw HTML displayed as text and checked URL protocols.

### 2026-09-30 — a full workflow run on a phone, against OpenAI (`plan → build → test → review`)

The first real workflow run, through the page. It ended `succeeded`: four steps, the
build step ran `doctor`, `check doctor` and the whole test suite (486 tests, 0 failed)
on Android/arm64 under the harness, the merge rehearsal was clean, 101,595 tokens of
which 72,445 were read from the provider's cache. What it showed:

- **`search_files` was refused every time** ("Operation is denied by the default
  policy", five times). It asked to read without naming a path, so the generated
  rule `read-project` (which lists `paths: ["**"]`) matched nothing and the default
  denied. Its tests approved everything with a stub and could not have said so.
  Fixed, and a test now runs it under the policy a generated project has.
- **Fixing that opened a second hole, closed in the same change:** a search reads
  many files under one approval, so it could have shown the inside of a file
  `read_file` is forbidden to open (`.env`, `*.pem`). Each candidate is now held to
  the read policy on its own, and the result says how many it left out.
- **A missing file was counted as a refusal** ("Tools it used": `read_file … Refused 1`
  was an `ENOENT`). A tool that ran and failed, and an operation that was not
  allowed, are different things and are now counted and labelled apart everywhere
  (page, terminal interface, chat).
- **"read was reject", five times, with nothing else.** Approvals in the record now
  carry what they were about and the reason, and the page names who or what decided
  (a person, or `policy · rule '…'` / `policy · the section default`). A refusal is
  listed once, not once as an approval and again as a failed tool.
- **"No provider usage was recorded for this run"** under every agent, while the run
  above showed 101,595 tokens. The per-agent record has tokens but not a call count,
  and the reader required the count. It shows the tokens now.
- **Still open:** the planner looked for `first-real-run.md` at the repository root
  (it lives in `docs/`) and the run was not told otherwise; `gpt-6-luna` is not
  priced, so the cost reads "not priced".

### Opt-in GitLab protocol smoke

The short way, with the project's own GitLab login (`etnpilot login gitlab`) and `git.baseUrl` / `git.project`:

```bash
etnpilot smoke --gitlab-write --confirm-writes --skip key,reply,tools,stream,toolstream,forge
```

Same checks as below, same guard (the project's name must contain `etnpilot-smoke`), no separate environment variables.
The script that follows keeps working for CI and for a token that is not the one you signed in with.

For an isolated, unarchived test project named `etnpilot-smoke`, set
`ETNPILOT_SMOKE_GITLAB_URL`, `ETNPILOT_SMOKE_GITLAB_PROJECT`, and
`ETNPILOT_GITLAB_TOKEN`, then run `npm run smoke:gitlab -- --confirm-writes`.
It creates a unique branch and commit, opens a Draft MR, reads approvals and
pipelines, closes the MR, deletes the branch, and verifies its bounded receipt.
It never merges and observes pipelines for at most 60 seconds. Exit 3 means no successful pipeline was observed; configure
and run CI before treating that part as proven. This check exercises the forge
protocol and cleanup; it does not replace the provider-to-publication walkthrough.
No real GitLab smoke has been recorded in this change.


## 2026-10-01 — a model that wants /v1/responses

`gpt-5.6-sol` answered the first tool request with 400: "Function tools with reasoning_effort are not
supported ... in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to
'none'." The advice this adapter gave was the second half, which switches the model's reasoning off.

The adapter now speaks `/v1/responses` as well (`providers.<name>.api`: `auto`, `chat` or `responses`). With
`auto`, the default, it starts on chat completions and, when the server's refusal names `/v1/responses`
before any tool has run, repeats the same request there and stays there. The Responses loop is stateless
(`store: false`): the conversation travels with each request, the model's own output items, reasoning
included as encrypted content, are handed back with the tool results, and the effort is sent as
`reasoning.effort`. Usage is read from the same fields. With `stream: true` the route streams too: the text pieces are shown as they
arrive, and the finished response in the stream's last event is what the loop continues from, so tool calls and
reasoning items are never reassembled from fragments.

**Checked on a real key (2026-10-02).** `etnpilot smoke --provider openai --model gpt-5.6-sol` passed 6/6 on a
phone: reply on chat completions, tools on `/v1/responses` (`auto` switched by itself), stream on chat, and the
combination, `toolstream`, on `/v1/responses` with the tool call arriving while 8 pieces streamed; 1,118
tokens in, 92 out. `etnpilot usage` for `gpt-5-2025-08-07` reproduces by hand from the published rates (1.25 / 0.125
cached / 10 USD per million): 78,285 uncached in + 369,792 cached in + 35,931 out = USD 0.5034.

## `etnpilot smoke` — the quick check on a real key

```
etnpilot smoke                       # the project's default provider
etnpilot smoke --provider openai --model gpt-5.6-sol
etnpilot smoke --skip tools,stream,toolstream   # fewer requests
etnpilot smoke --json
```

A handful of tiny real requests (a few cents at most), then a report that can
be pasted as it is:

```
✓ key    provider 'openai' (openai-compatible, gpt-5), key stored login (peter91v)
✓ reply  gpt-5 via responses, 12 in / 3 out                          1.1 s
✓ tools  1 tool call(s), gpt-5 via responses, 160 in / 24 out        3.9 s
✓ stream 9 pieces, gpt-5 via responses, 31 in / 36 out               1.8 s
✓ toolstream 1 tool call(s) while streaming 6 pieces, gpt-5 via responses   4.2 s
✓ forge  digest of 40 files (6 KiB), 0 credential files left out; nothing sent
6/6 passed against 'openai'; 363 tokens in, 90 out.
```

| Step | Checks |
| --- | --- |
| `key` | a key resolves for the provider, and from where |
| `reply` | a plain answer ("pong"), and which API answered (`chat` or `responses`) |
| `tools` | a read-only tool call in a scratch directory: the model must call it and use what it read |
| `stream` | the answer arrives in several pieces (the setting `stream` is switched on for this step only) |
| `toolstream` | the same tool call while the answer streams, on whichever API the model needs — the combination used day to day |
| `forge` | the repository digest is built; it is not sent |

It never writes to the project, and the tool step runs in a temporary
directory with only `read_file` and `list_files` offered. A failure prints the
reason and, where there is one, the command that fixes it.
