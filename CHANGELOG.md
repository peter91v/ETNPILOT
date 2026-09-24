# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is
pre-1.0, so breaking changes may appear in any release.

## [Unreleased]

### Added — roadmap UI-1: the page does what the TUI does

- The review page resumes queue jobs, opens a run's receipt (branch, sandbox,
  merge rehearsal and its collisions, every approval with who decided it, and
  the settings layers that were in effect), lists and changes settings against
  the same layers as the CLI and the TUI, and starts runs whose approvals come
  back to the same page.
- `POST /api/runs/start` answers `202` rather than holding the request for the
  whole run. What is running and what a run failed with are part of the state
  the page polls (`active`, `recentRunErrors`), and closing the server stops
  the runs it started.
- Runs started from a surface are tracked in `project-state.js` rather than in
  each surface, so the TUI and the page cannot disagree about what is running.
- A refusal is an answer: `SettingsRefused` and the queue's and inbox's state
  errors are `409` with `{ error, path, reason }`, unparsable YAML is `400`,
  and a receipt name that is not this project's is refused before anything is
  read.
- The page also lists the worktrees and the project's merge requests, with the
  same `removeIfClean` behaviour as the other surfaces.

### Added — `etnpilot ui` opens the page

- At a terminal the command opens the review page in a browser, because the
  link carries a token nobody wants to retype. Not when the output is a pipe,
  not under `CI`, not with `BROWSER=none`, and not with `--no-open`; `--open`
  asks for it anyway. `BROWSER` chooses the opener, and `termux-open-url` is
  tried before `xdg-open`, since a phone is a place this runs.
- The URL is passed as an argument and never through a shell, the opener is
  detached so the browser outlives the command and writes nothing into the
  terminal, and an opener that is missing or fails is reported rather than
  failing the server that is already listening.

### Added — four things the surfaces were not saying

- **Settings offer the values they accept.** Where a setting takes one of a
  known list, the page shows a dropdown; where it takes a set, checkboxes; the
  terminal interface names the same values under the editor. The lists are the
  ones the code validates against, and `test/settings.test.js` checks each
  offered value against its own validator, so a surface cannot suggest a value
  a run would then refuse. Providers come from the project's own
  configuration rather than from a fixed list.
- **A worktree says which files it is holding.** Opening one lists them with
  what happened to each, and marks the state ETNPilot writes itself apart from
  a person's work — so "1 unsaved, removing refused" can be read rather than
  taken on trust.
- **A run says why it ended.** Opening a receipt leads with the failing step
  and its own error, the steps that never ran because of it, a rejected
  approval, and whether it was published, followed by every step with its
  attempts and duration.
- **Usage is shown.** Tokens sent, tokens read from cache, provider calls and
  estimated cost: per run in its receipt, and for the project on the overview.
  Where `observability.enabled` is false, the surfaces say so instead of
  showing a zero that looks like a measurement.
- **A run in progress says where it is**: which step, which agent inside it,
  and how far along the plan — from the events the harness already emits,
  which `runProject` now lets a caller observe.

### Fixed

- `git()` no longer trims output where a column matters: the first status
  column of `git status --porcelain` is a space for an unstaged change, and
  trimming it shifted every path in the first line by one character.
- The terminal interface reads an input chunk as the keys it contains. A
  terminal delivers what it has, so typing quickly or pasting a task arrived
  as one chunk and every character in it was dropped.

### Changed — the review page follows the GUI draft

- The page is a shell now: a sidebar of views (Overview, Approvals, Queue,
  Runs, Worktrees, Merge requests, Settings) instead of one long scroll, a top
  bar that says which project is being reviewed, panels with heads, status
  pills, stat cards, a command palette on `ctrl` `K`, toasts, and a dialog for
  starting a run. The view is in the address, so a reload returns to it.
- Taken from the draft only where something real is behind it. Its screens for
  features that do not exist are not here, and the page still supports light as
  well as dark, loads nothing from anywhere, and inserts every agent-controlled
  value as text.

### Fixed — found by looking, again

- Every grid that holds content now says `minmax(0, 1fr)`: the new inner grid
  had brought the sideways drag back at 390px.
- The views no longer render on top of each other — a `display` declaration
  overrides the `hidden` attribute, so they are told twice.

### Added — reaching the surfaces from a tablet

- The page is checked at tablet widths (768px, 820px, 1180px) as well as at
  1280px and 390px, and its controls are finger-sized on a touch screen.
- `etnpilot ui --host 0.0.0.0` prints an address the other device can actually
  reach, instead of a `127.0.0.1` link that only works where it was printed,
  and says plainly that the port is now open to the network and what that
  gives away. The SSH tunnel that keeps the loopback guarantee is printed with
  it.

### Fixed — the page, from looking at it

- A wide table no longer stretches the whole page: grid children are
  `min-width: auto` by default, so one settings row dragged every section off
  screen at both 1280px and 390px.
- The settings list says when it is cut ("Showing 25 of 122") instead of
  running to 122 rows, and long values are shortened with the whole value in
  the tooltip.
- The five-second poll holds still while a field has focus, so it no longer
  throws away a half-typed reason, and it no longer overwrites the answer to
  something you just did.

### Added — roadmap UI-2.3 and UI-2.5

- The TUI shows the worktrees (`5`): which branch each holds, which ones a run
  made, and what removing one would throw away. `x` removes the one under the
  cursor through the same `removeIfClean` the CLI uses, so a worktree holding
  unsaved work is kept and the screen says what it is keeping.
- The TUI shows the project's merge requests (`6`), ETNPilot's own first —
  identified by their `etnpilot/` branch, not by a title anyone could copy —
  with everyone else's beside them, because what lands before ours is what
  breaks ours. It is the one view that needs the network, so it reads when
  opened and on `g`, never on the poll, and says plainly when the project,
  the token, or GitLab itself is not there.
- Both go through `project-state.js` like every other surface reads:
  `state.worktrees()`, `state.removeWorktree()`, `state.mergeRequests()`.
- `etnpilot merge list [--status opened|merged|closed|all]` prints the same
  merge requests, and `etnpilot worktree list` now prints the same description
  the view shows rather than git's porcelain.

### Fixed

- Cutting a line that carried no colour no longer appends a reset sequence,
  which printed as `\u001B[39m` wherever colour is off.

### Added — local settings

- Configuration now loads in layers: the committed default, then
  `~/.config/etnpilot/config.yaml`, then `.etnpilot/etnpilot.local.yaml`.
  A user's changes stay on their machine and are never committed; with no local
  file a checkout behaves exactly as it was committed.
- The committed default declares what a user may change, per setting: `open`,
  `stricter-only` (narrow it, never widen it — policy effects may only be
  raised, policy rules are added rather than replaced, allow-lists may only
  shrink, `sandbox.enabled` may only be switched on), or `locked`. A locked or
  widening change is refused with a reason, never silently ignored.
- `etnpilot config list|set|unset|diff`, writing the local file by default and
  `~/.config` with `--global`. The same module backs every surface, so the TUI
  and the page will refuse a change for exactly the reason the terminal gives.
- A run's terminal receipt records which layers were in effect, by hash, and
  which settings they changed — never the values, which can carry local paths.

### Added — terminal interface

- `n` starts a run from the TUI. It works in its own worktree and does not
  block the screen; everything it needs approved appears under approvals in the
  same window, recorded as `tui:<you>`. Quitting aborts any run started there
  rather than stranding it. An empty agent field names the workflow steps that
  would run instead of showing a blank.
- `enter` on a run opens what its receipt sealed: branch and sandbox, the merge
  rehearsal and its conflicts, the approvals with who decided them, and which
  settings layers were in effect.
- `R` resumes a queue job; `?` shows every key on one screen, in two columns
  where one will not fit and scrolling where neither does.

- The TUI has a settings view: every effective setting with the layer it came
  from and whether it may be changed, an editor for the one under the cursor,
  `d` to put it back to the committed default, `s` to choose between the local
  and the global file, and `/` to filter. Refusals appear in the editor, which
  stays open so the change can be corrected; a locked setting does not open.
- A local settings file the loader would refuse is reported above the settings
  list, rather than leaving the next run to be the first to mention it.
  `etnpilot config list` and `config diff` fail for the same reason.
- `queue.database` and `approval.inbox.database` name files an open surface
  already holds. Changing one is written but reported as needing a restart,
  instead of showing a setting that has visibly changed and quietly has not.

- `etnpilot tui` shows approvals, the queue, and runs in one full-screen view
  and decides against the same inbox the CLI and the review page use. Its views
  are pure functions of state and viewport, so frames are asserted in tests
  without a terminal.
- The policy decision that stopped an operation is recorded with the approval,
  so every surface can say which rule is asking rather than only showing what
  was asked.
- `openProjectState` collects approvals, queue, and runs once for every
  surface; the review server now reads through it.

### Added — roadmap M6

- `etnpilot ui` serves a local review page for pending approvals, the workflow
  queue, and finished runs, read from the same databases and receipt files the
  CLI uses. Loopback-bound, token-protected, and loading nothing from anywhere.
- Merge-train awareness: after a clean rehearsal, a run can report which other
  open merge requests its branch would collide with once they land
  (`git.mergeTrain`).
- Dependency inventory and license gates now cover PyPI (from installed
  `dist-info` metadata), Go (`go.mod`), and Cargo (`Cargo.lock`) alongside npm.
  Ecosystems that carry no license data are counted rather than reported as
  violations, because a finding nobody can act on is noise.
- The sandbox can build a devcontainer image when the devcontainer defines a
  Dockerfile, tagging it by content so an unchanged definition is reused and a
  changed one cannot be served stale.

### Added — roadmap M4 and M5

- Policy resolves symbolic links before matching paths, so a link created
  during a run cannot point an allowed path at a protected file.
- The OpenAI-compatible adapter has a bounded tool loop with mediated
  workspace tools (`read_file`, `list_files`, `write_file`, `run_command`),
  so a second provider can edit code. `run_command` takes argv, never a shell
  string.
- The workflow queue runs a pool of workers, so one pending approval no longer
  blocks every other issue (`queue.workers`).
- A disposable container sandbox runs checks and approved commands with no
  network and a read-only root, optionally reusing a devcontainer image. A
  missing runtime fails the run rather than downgrading to host execution.
- Approvals can be given as GitLab comments, with the identity GitLab reports
  for the note author. Decisions still land in the durable inbox.
- `--dry-run` evaluates policy and records what it would have decided without
  changing anything; `--record-fixtures` and `--fixtures` record and replay
  redacted provider answers, which also makes runs offline and deterministic;
  `etnpilot replay` re-runs a receipt's checks and reports drift.
- A `quorum` workflow step requires independent reviewers to agree, counting
  at most one approval per provider.
- Supply-chain gates: `etnpilot deps check` (licenses with SPDX OR/AND
  semantics, denied packages), `etnpilot sbom` (CycloneDX), `etnpilot scan
  secrets`, and `etnpilot attest` (in-toto/SLSA provenance from a receipt).
  Both CI pipelines run the scan and the dependency gate.
- Every worktree run rehearses the merge into its target branch with
  `git merge-tree`; a conflicting branch is not published by default.
- `etnpilot init --template minimal|regulated`, `etnpilot pipeline status`.

### Changed — typing happens on the bottom line

- Starting a run, editing a setting and filtering all used to take over the
  screen with a form. They now use a single prompt on the bottom line, the way
  a terminal tool has always done it, so the list you are filtering or the
  approval you are about to answer stays visible while you type. The line above
  carries the context — the agent that would run, a setting's mode and
  committed default, the scope being written — and a refusal replaces it in
  place, directly above the line it was typed on.
- A value longer than the line is cut at the front, so the caret stays visible
  at phone and tablet widths. The filter caret no longer appears twice.

### Added — trying it out without a provider account

- A `scripted` provider type performs exactly the workspace tool calls the
  configuration lists, through the same mediated tools and the same approval
  path every other provider uses. It asks no model and needs no SDK, endpoint
  or key, so the harness — policy, approvals, worktree, checks, receipts,
  merge rehearsal — can be exercised on a machine that has none of those.
  Every test in this repository injected a provider; that seam lived only in
  the test code, so nobody using ETNPilot could do what its tests do.
  See `docs/trying-it-out.md`.
- `etnpilot run --approvals inbox` puts a run's requests in the durable inbox
  instead of the terminal that started it, so they can be answered from the
  TUI, the page or another window. Without it a run with no interactive
  terminal rejects every request, which is safe but unusable unattended.
- A refused or failed scripted step fails the run and names the step, rather
  than reporting `succeeded` over a receipt full of denials.
- When every candidate provider is passed over, the error names why for each
  one. It used to blame capabilities and send people to the agent manifest
  when the cause was a denial in `policy.providers`.

### Fixed — advice that cannot be followed

- `etnpilot doctor` and the Copilot provider both said "Install
  '@github/copilot-sdk'" on every platform. The SDK keeps its runtime in
  per-platform packages that GitHub publishes for linux, macOS and Windows
  only; elsewhere — Android, for instance — that install reports success and
  installs nothing, so the advice sent people in a circle. Both now name the
  platform and point at the `openai-compatible` provider instead. `doctor`
  reports `copilotSdkAvailableForPlatform`.

### Fixed — an absent code index no longer costs the run

- CodeGraph ships its compiled library in per-platform bundles and publishes
  none for some platforms. Where the bundle is missing, indexing threw and
  **every run died** — a run that would otherwise have finished, lost to an
  optional enrichment. The run now continues and the receipt records
  `codegraph: { available: false, reason }`, so no later reader assumes an
  index was consulted. Any other indexing failure still stops the run, and
  `etnpilot graph build` still fails loudly, because that command is a request
  for CodeGraph itself.
- Tests that need the compiled engine are skipped where no bundle exists for
  the platform, naming it. Only that one failure is skippable: a package that
  is missing outright stays red.

### Fixed — asking for an agent by name

- Naming an agent was silently ignored wherever a project defined
  `workflow.steps`: `etnpilot run --agent`, `git.issueTrigger.agent`, and any
  caller of `runProject({ agent })` ran the configured steps instead. A named
  agent now runs that agent. Projects that never named one are unaffected.

### Fixed — first-run experience

- Enabling receipt signing without a key reported a raw ENOENT. It now names
  the missing file and the two ways out.

### Fixed — audit of the completed milestones

- Subagent spawning had no depth limit or cycle detection, so mutually
  referencing manifests recursed until the process died.
- The OpenAI-compatible adapter dropped agent skills from its system message.
- `pipelines()` was dead code, so "pipeline status synchronization" only ever
  pushed statuses to GitLab and never read its verdict back. The issue trigger
  can now wait for the merge-request pipeline and turn its commit status red
  when CI disagrees.

### Fixed

- A workflow that ends in `failed` is no longer published as a merge request,
  no longer reports `success` to GitLab, and makes `etnpilot run` exit with a
  non-zero status. With `failFast: false` the engine returns a failed summary
  instead of throwing, which the publish path previously ignored.
- An event listener that throws can no longer fail a successful run or append a
  second, contradicting receipt for the same run. Listener errors are reported
  and contained.
- A run whose setup fails now removes its worktree and run branch instead of
  leaving one behind per attempt.
- Worktree cleanup no longer treats ETNPilot's own workspace artifacts, such as
  the local CodeGraph index, as unsaved work. `--cleanup-worktree` previously
  never removed anything on a project with CodeGraph enabled.
- A missing `.etnpilot/etnpilot.yaml` inside a run worktree and an unknown
  workflow agent are reported as actionable messages before the run starts.
- The CLI prints a single-line error instead of a raw stack trace. Set
  `ETNPILOT_DEBUG=1` for the stack.
- Provider invocations honour step cancellation: the OpenAI-compatible adapter
  passes the abort signal to `fetch`, and the Copilot adapter stops its session.
- `engines.node` requires 22.13, the first release with usable `node:sqlite`.
- Publishing sets an explicit committer identity, so it also works where git has
  no `user.name` configured, and a failed evidence note no longer discards the
  merge request.

### Security

- Approval requests show the full command, file, tool arguments, and URL, with
  control characters escaped so terminal output cannot be spoofed. Masking of
  credential-looking text is now opt-in via `approval.inbox.redactSecrets`.
  Approval fingerprints are computed over the original request.
- Checks run with an allow-listed environment (`checks.envAllow`), so
  agent-authored test code no longer inherits repository or provider tokens.
- `git.issueTrigger.allowedUsers` must name at least one user while the issue
  trigger is enabled.
- The default policy denies writes to `.etnpilot/**`, `.gitlab-ci.yml`,
  `.github/workflows/**`, and `.git/hooks/**`.
- Policy path rules match case-insensitively on macOS and Windows.

### Added

- `docs/threat-model.md` and `SECURITY.md`.
- A local `/healthz` probe on the webhook receiver.
- `git.issueTrigger.fetchBeforeRun` fetches the target branch so queued runs
  start from its current tip rather than a stale local `HEAD`.
- `etnpilot init` writes a starter `orchestrator` agent and prompt, so a fresh
  project is runnable.
- `etnpilot doctor` reports the Node version requirement, `node:sqlite`, project
  presence, and actionable hints.
- Dependabot configuration and a syntax check in `npm run check`.

### Changed

- Receipts are hashed over canonical, sorted-key JSON so independent verifiers
  can rebuild the signed bytes. Receipts written earlier still verify and are
  reported as `encoding: "mixed"`.
- The GitLab client applies a request timeout, follows list pagination, and
  includes the API error message.
- The default configuration uses placeholder host names instead of one
  organization's GitLab instance.
- The CLI dispatch moved to `src/cli/commands.js`; `bin/etnpilot.js` only parses
  arguments and reports failures.
