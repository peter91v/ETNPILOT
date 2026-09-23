# Roadmap

## M0 — Bootstrap

- [x] Harness registries and lifecycle events
- [x] Agents and subagent execution
- [x] Plugin loader
- [x] GitHub Copilot SDK adapter
- [x] OpenAI-compatible adapter
- [x] Local CodeGraph integration through MCP and its published API
- [x] Safe Git worktree manager
- [x] Self-hosted GitLab API client
- [x] GitHub Actions and GitLab CI

## M1 — Runnable workflow

- [x] Manifest discovery for instructions, skills, prompts, and agents
- [x] DAG scheduler with concurrency, cancellation, retry, timeouts, and step budgets
- [x] Optional run worktrees, safe cleanup policies, and reproducible check execution
- [x] Hash-chained receipts
- [x] Explicit GitLab draft-merge-request publishing
- [x] Incremental CodeGraph indexing and refresh
- [x] Cross-language symbol and dependency analysis
- [x] Transitive impact analysis and affected-test discovery
- [x] Workflow-integrated codegraph evidence
- [x] Versioned plugin SDK with capability declarations and dependency ordering
- [x] Capability-aware provider routing with replay-safe fallback
- [x] Authenticated and deduplicated GitLab issue-to-workflow trigger
- [x] Persistent human approval inbox for pending tool calls
- [x] Durable workflow queue with leases, checkpoints, cancellation, and conservative recovery
- [x] Cryptographically signed receipt chains
- [x] Versioned secret-provider API with restricted environment and confined file backends
- [x] Python, Go, Java, and C# code intelligence through CodeGraph

## M2 — Production controls

- [x] OIDC/Vault secret-provider plugin
- [x] OpenTelemetry traces, usage budgets, and cost accounting
- [x] Policy-as-code for tools, paths, networks, and providers
- [x] Process-level plugin isolation and resource limits
- [x] GitLab webhook authentication and external pipeline status synchronization

## M3 — Reproducibility and supply chain

- [x] Version pinning and provenance for agents, instructions, prompts, and skills

## M4 — Operability

- [x] Disposable container sandbox for checks and approved commands
- [x] Concurrent queue workers, so one pending approval no longer blocks other issues
- [x] Tool support in the OpenAI-compatible adapter, with mediated workspace tools
- [x] Approvals from GitLab comments with GitLab-asserted identity
- [x] Symlink-aware path policy
- [x] Dry-run mode, and replay of the deterministic half of a recorded run
- [x] Bounded subagent recursion (audit finding)
- [x] Reading GitLab pipeline verdicts back into the run (audit finding)

## M5 — Supply chain and reproducibility

- [x] Disposable container sandbox, reusing a devcontainer image where declared
- [x] Reviewer quorum across different providers
- [x] Replayable runs from redacted fixtures, which also gives offline execution
- [x] Dependency and license policy gates
- [x] SBOM, secret scanning, and in-toto/SLSA run attestations
- [x] Merge rehearsal against the target branch before publishing
- [x] Organization-level project templates (`init --template`)

## M6 — Review surface and multi-language support

- [x] Local-first web UI for reviewing runs and approvals
- [x] Merge-train awareness: which queued merge requests this branch collides with
- [x] Dependency inventory and license gates for Python, Go, and Rust
- [x] Building a devcontainer image rather than only reusing a prebuilt one

## M7 — Surfaces at parity (in progress)

Every surface should be able to do everything; none of them is the junior one.

- [x] Shared project state, so the terminal, the TUI and the page cannot disagree
- [x] Terminal interface: approvals, runs, queue, and decisions
- [x] The policy reason recorded with each approval, not only in the receipt
- [x] Local settings layer: a user's changes stay local, only defaults are committed
- [x] Editing settings, policy included, from the TUI
- [x] Starting a run from the TUI, deciding its approvals in the same window
- [ ] Editing settings from the page and the app
- [ ] Starting a run from the page and the app
- [ ] The remaining CLI commands from every surface

The surfaces have a roadmap of their own, with exact steps, file paths and
acceptance criteria: [roadmap-ui.md](roadmap-ui.md).

## Brainstorming backlog

- an end-to-end run against a real provider and a real GitLab instance, which
  nothing in the test suite covers today;
- vulnerability data (OSV) alongside the license gate;
- devcontainer `dockerComposeFile` support;
- license detection for Go and Cargo, which needs the module cache rather than
  the manifest.
