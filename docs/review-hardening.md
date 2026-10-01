# Review hardening after PR #29

Base: `23568a4fb24be08c46880ccacbfeceb99c65486b` (`main` after PR #29).
The existing harness, policy, sealed receipts, isolated plugin workers, SQLite
state, GitLab integration and external `@colbymchenry/codegraph` remain the
architecture. This document maps the review to implemented changes and evidence.

| Review | Change | Regression coverage |
| --- | --- | --- |
| R01 | Verify one bounded receipt snapshot before any executor; require a terminal record; inspection-only mode; current check environment and sandbox | Tampered, incomplete, unsigned receipts; valid filtered replay |
| R02 | Authorize reads before diffs or edit matching; pin parent directory descriptors, reject links, bound reads, and compare inode/content after approval | Protected substring lookup, changed content, parent/symlink swap, existing edit tests |
| R03 | Withhold attachments without an explicit allow/approval; normal `read_file` can obtain human approval during the turn | Async human-required read, deny policy, shared CLI/Web/TUI resolver |
| R04 | Reversible API-safe tool aliases; retain internal names and allowlists; offer declared CodeGraph exploration in manifests | Provider schema/name round trips; MCP tool policy; starter agent tests |
| R05 | Validate MCP JSON-RPC envelopes, tool schemas/counts, frames, total output and pending calls; abort RPC; await graceful then forced shutdown | Null/array/malformed frames, oversized unterminated output, server calls and shutdown |
| R06 | Regex search in a separately terminated worker; bounded patterns/files/total bytes and literal mode | Catastrophic backtracking, event-loop responsiveness, cancellation, normal searches |
| R07 | Bound and cancel response streams; bounded regular-file reads; complete UTF-8 prefixes; directory budgets; attachment digests of sent text | Multibyte truncation, response cancellation, attachments/directories, size limits |
| R08 | Count HTTP attempts, retain observed usage on errors/abort, report partial/unknown usage and gate between requests | Both providers: tool response then HTTP failure; retries; token/request budgets; streaming |
| R09 | Anthropic total input includes uncached and cache read/write tokens; separate published five-minute cache rates | Mixed cache fixture, token totals, cost arithmetic |
| R10 | Atomic SQLite workspace reservation before preparation; serialize turns, compact/undo/in-place runs; conservative crash recovery; attributed file journal for undo | Concurrent independent leases/turns, live-owner recovery refusal, foreign and changed files |
| R11 | Shared process lifecycle: combined output limit, timeout, abort, POSIX group cleanup; uniquely owned sandbox containers removed after interruption | Descendant delayed write prevented; check/git/tool failures; sandbox naming and cleanup |
| R12 | Project-scoped bounded catalogs; newer dated source precedence; manual tariff override; source/date/status/staleness/cache TTL; retrospective label | Two project roots, automatic rates disabled, catalog freshness, provenance, configured prices |
| R13 | Verify RSS measurement before import; handle PID namespaces; fail closed if unavailable; explicit separately reported heap-only mode | Real buffer/RSS limit and injected missing measurement; heap-only declaration |
| R14 | Inject and catch adapter discovery; listening resolves with fallback/warning | Adapter exception; deterministic exposed/loopback UI tests |
| R15 | Update README, threat model, roadmap, real-run evidence and configuration/security docs | Documentation commands, status assertions, content lock verification |

The supplementary review-page Markdown renderer uses DOM nodes, displays raw HTML as text,
allows only HTTP(S)/mailto/anchor links, and bounds input and node counts. Receipt
and session reads stop at 16 MiB, telemetry reads at 64 MiB; run-list expansion
stops at 500 instead of offering an ineffective control. Archive older evidence
before exceeding those limits. The separate GitLab smoke entry point is opt-in
and requires an isolated test project; it supplies a runnable integration check,
not evidence that a real GitLab run has occurred.

## Configuration

MCP servers accept `timeoutMs` (default 30000) and `limits`:
`maxMessageBytes` (1048576), `maxOutputBytes` (16777216), `maxTools` (256),
`maxPendingRequests` (32), `shutdownTimeoutMs` (250). These settings and plugin
entries are locked against local override. MCP processes are executable project
configuration and do not receive the plugin permission boundary.

Workspace tools accept `limits` through `createWorkspaceTools`, including
`maxFileBytes` (262144), `maxFetchBytes` (131072), `maxOutputBytes` (65536),
`maxEntries` (500), `maxSearchBytes` (4194304), `searchTimeoutMs` (1000),
`fetchTimeoutMs` (30000), `shellTimeoutMs` (120000). Positive integer values are
validated. The existing provider configuration passes tool options to adapters.
Plugin `memoryMonitoring` is `required` by default; `heap-only` is an explicit
weaker mode that does not bound external allocations. Workflow observability adds
`maxProviderRequestsPerWorkflow` alongside existing token and cost budgets.

## Operational boundaries

- Secure file writes require a directory-descriptor namespace (`/proc/self/fd`
  or `/dev/fd`); unsupported platforms refuse writes. The final write is not
  a kernel compare-and-swap against a hostile local process.
- POSIX groups clean ordinary descendants. A program deliberately starting a
  new session and Windows descendants require container isolation.
- Leases serialize ETNPilot, not editors. Crash recovery names the exact owner
  and requires its process to have stopped; it never replays a turn automatically.
- Undo applies only attributed tool writes. Shell/formatter effects and older
  turns without a journal need review. Changed files are left alone.
- Provider budgets act when usage arrives; missing or partial usage remains
  explicit. An already submitted response may exceed a configured token budget.
- Published/catalog prices are dated estimates with provenance, not invoices.
  Retrospective display leaves sealed evidence unchanged.
- The documented OpenAI workflow succeeded on 2026-09-30. Live GitLab publication
  and new paid provider smoke runs remain separate integration evidence.

## Validation commands

```bash
npm ci --ignore-scripts
node scripts/check-syntax.mjs
NODE_OPTIONS="--import=$PWD/test/helpers/offline-network.mjs" node --test --test-timeout=90000 test/*.test.js
node bin/etnpilot.js scan secrets
node bin/etnpilot.js deps check
node bin/etnpilot.js content verify
node bin/etnpilot.js eval
```

The preload refuses real outbound HTTP(S) and fetch calls; loopback test servers
and injected fixtures remain available. Node.js 22 and 24 are checked separately.
CI retains Node 22/24/26 on x64 and Node 26 on arm64.

## Validation results — 2026-10-01

| Check | Result |
| --- | --- |
| Full suite, Node.js 22.23.3 | 537 passed; 0 failed, cancelled or skipped |
| Full suite, Node.js 24.21.0 | 537 passed; 0 failed, cancelled or skipped |
| Syntax | 217 JavaScript files passed |
| Secret scan (including all new files) | 263 files; no findings |
| Dependency policy | 3 packages; no violations |
| Content lock | 9 entries verified in enforce mode |
| Offline evals | `fix-a-failing-test` and `write-a-file`: passed, 3/3 checks each |
| Whitespace/diff check | Passed |

The suites include 34 new regression/integration cases. Provider responses and
GitLab publication are exercised with fixtures; no new paid provider call or
live GitLab smoke run was performed. The existing recorded real-run evidence
remains in `docs/first-real-run.md`.
