# Architecture

## Boundaries

| Area | Responsibility | Default implementation |
|---|---|---|
| Harness | Runs agents, subagents, plugins, events, approvals, receipts | `src/core/` |
| Providers | Model/agent runtime adapters | GitHub Copilot SDK, OpenAI-compatible |
| Content | Instructions, skills, prompts, agent manifests | `.etnpilot/` |
| Git | Safe local operations and isolated branches | native Git worktrees |
| Forge | Remote repository lifecycle | self-hosted GitLab API |
| Code intelligence | Files, symbols, imports, impact queries | embedded SQLite code graph |
| Evidence | Tamper-evident run results | SHA-256 JSONL receipts |

## Execution flow

```mermaid
flowchart TD
    Request[Task request] --> Harness[ETNPilot harness]
    Harness --> Policy{Approval policy}
    Policy --> Provider[Selected provider]
    Provider --> Worktree[Isolated worktree]
    Worktree --> Checks[Checks and receipts]
    Checks --> MR[GitLab merge request]
    Harness --> Graph[(SQLite code graph)]
```

Providers do not own orchestration policy. GitLab does not own local Git state. Plugins receive the harness API but cannot silently replace an already registered capability. These boundaries keep the runtime testable and prevent a model provider from becoming the architecture.

## Security defaults

- read-only actions may be approved by policy;
- writes, shell execution, and network access require a human decision;
- subprocesses use argument arrays with `shell: false`;
- worktrees are confined to `.etnpilot/worktrees/`;
- secrets come from environment variables or a future secret-provider plugin;
- receipts contain execution metadata, but should never include raw credentials.
