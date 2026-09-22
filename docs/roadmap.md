# Roadmap

## M0 — Bootstrap

- [x] Harness registries and lifecycle events
- [x] Agents and subagent execution
- [x] Plugin loader
- [x] GitHub Copilot SDK adapter
- [x] OpenAI-compatible adapter
- [x] Embedded SQLite code graph
- [x] Safe Git worktree manager
- [x] Self-hosted GitLab API client
- [x] GitHub Actions and GitLab CI

## M1 — Runnable workflow

- [x] Manifest discovery for instructions, skills, prompts, and agents
- [x] DAG scheduler with concurrency, cancellation, retry, timeouts, and step budgets
- [x] Optional run worktrees, safe cleanup policies, and reproducible check execution
- [x] Hash-chained receipts
- [x] Explicit GitLab draft-merge-request publishing
- [x] Incremental code indexing and schema migration
- [x] Resolved JavaScript/TypeScript dependency edges
- [x] Transitive impact analysis and affected-test discovery
- [x] Workflow-integrated codegraph evidence
- [x] Versioned plugin SDK with capability declarations and dependency ordering
- [x] Capability-aware provider routing with replay-safe fallback
- [x] Authenticated and deduplicated GitLab issue-to-workflow trigger
- [ ] Human approval inbox for pending tool calls
- [ ] Cryptographically signed receipt chains
- [ ] Codegraph parsers for Python, Go, Java, and C#

## M2 — Production controls

- [ ] OIDC/Vault secret-provider plugin
- [ ] OpenTelemetry traces and cost accounting
- [ ] Policy-as-code for tools, paths, networks, and providers
- [ ] Process-level plugin isolation and resource limits
- [x] GitLab webhook authentication and external pipeline status synchronization

## Brainstorming backlog

- disposable devcontainers per run;
- semantic codegraph enrichment without a server database;
- reviewer quorum across different providers;
- prompt/skill version pinning and provenance;
- replayable runs with redacted fixtures;
- dependency and license policy gates;
- SBOM, secret scanning, and SLSA attestations;
- local-first web UI and offline execution;
- merge-train awareness and automatic rebase rehearsal;
- organization-level templates for regulated teams.
