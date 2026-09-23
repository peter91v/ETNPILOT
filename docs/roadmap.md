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

## Brainstorming backlog

- disposable devcontainers per run;
- reviewer quorum across different providers;
- replayable runs with redacted fixtures;
- dependency and license policy gates;
- SBOM, secret scanning, and SLSA attestations;
- local-first web UI and offline execution;
- merge-train awareness and automatic rebase rehearsal;
- organization-level templates for regulated teams.
