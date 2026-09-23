# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is
pre-1.0, so breaking changes may appear in any release.

## [Unreleased]

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
