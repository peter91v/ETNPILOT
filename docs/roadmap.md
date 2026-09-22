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

- [ ] Manifest discovery for instructions, skills, prompts, and agents
- [ ] DAG scheduler with concurrency, cancellation, retry, and budgets
- [ ] GitLab issue-to-merge-request workflow
- [ ] Human approval inbox for pending tool calls
- [ ] Signed receipt chains and reproducible check execution
- [ ] Codegraph parsers for Python, Go, Java, and C#

## M2 — Production controls

- [ ] OIDC/Vault secret-provider plugin
- [ ] OpenTelemetry traces and cost accounting
- [ ] Policy-as-code for tools, paths, networks, and providers
- [ ] Provider fallback and model routing rules
- [ ] Plugin isolation and capability declarations
- [ ] GitLab webhooks and pipeline status synchronization

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
