# Architecture

## Boundaries

| Area | Responsibility | Default implementation |
|---|---|---|
| Harness | Runs agents, subagents, plugins, events, approvals, receipts | `src/core/` |
| Providers | Capability-aware model/agent runtime adapters and safe fallback | GitHub Copilot SDK, OpenAI-compatible |
| Content | Instructions, skills, prompts, agent manifests | `.etnpilot/` |
| Git | Safe local operations and isolated branches | native Git worktrees |
| Forge | Remote repository lifecycle | self-hosted GitLab API |
| Code intelligence | Files, symbols, imports, impact queries | embedded SQLite code graph |
| Evidence | Authenticated, tamper-evident run results | SHA-256 chains with optional Ed25519 signatures |
| Workflow | Dependency ordering, retries, limits, cancellation | bounded DAG scheduler |
| Queue | Durable intake, leases, checkpoints, restart recovery | SQLite workflow queue and worker |
| Webhooks | Authenticated, deduplicated event intake | GitLab issue receiver |
| Approvals | Cross-process human decisions and redacted evidence | SQLite approval inbox |

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

Providers do not own orchestration policy. GitLab does not own local Git state. Plugins receive a
versioned, capability-scoped context and cannot silently replace an already registered component.
These boundaries keep the runtime testable and prevent a model provider from becoming the
architecture.

Provider selection combines agent preferences, matching routing rules, and configured defaults.
Each candidate must satisfy the required capability set. Fallback is intentionally conservative:
it only proceeds after a structured provider error declares the operation retryable and safe to
replay. This prevents duplicate file changes or tool calls after an ambiguous failure.

Plugin manifests declare their API version, version, dependencies, and required SDK capabilities.
All manifests are validated before setup, dependencies are topologically ordered, and setup code
can access only its declared registration and event APIs.

## Runnable workflow

`etnpilot run` loads the project's manifests, registers configured providers, and executes the configured DAG. The user chooses an isolated worktree or the current checkout through configuration or CLI flags. Agent steps receive the outputs of their dependencies. Check steps execute argument arrays directly without a shell. A failed dependency blocks downstream work. Cleanup is policy-driven and never removes a worktree with uncommitted changes. Publishing to GitLab requires the explicit `--publish` flag and a token supplied through the environment.

The code graph stores file fingerprints, extracted declarations, raw imports, and resolved project paths in SQLite. Indexing uses file metadata and hashes to update only changed or deleted files. Reverse traversal reports direct and transitive consumers with their depth and highlights test files. Workflow receipts include the graph state before and after execution plus impact evidence for changed source files.

Receipt signing is opt-in and uses an external Ed25519 private key. The proof version, algorithm,
and public-key fingerprint are included inside each hashed entry before the signature is created.
The final workflow entry seals the chain. Strict verification requires every signature and the
terminal entry, so content changes, signer replacement, appended entries, and tail truncation are
detected. Existing hash-only receipts remain readable in migration mode.

## GitLab event intake

GitLab issue events pass through raw-body authentication, timestamp validation, project and label
filters, and an atomic queue insert before entering the serialized workflow worker. The HTTP
receiver acknowledges accepted work before model execution. External commit statuses expose
running, successful, or failed outcomes in GitLab; a transient status-update conflict is retried.
Webhook execution reuses the same workflow, worktree, approval, receipt, provider-routing, and
publishing boundaries as an interactive run.

Queued jobs survive restarts and are leased to one worker at a time. Heartbeats extend ownership,
while expired active leases become `orphaned` rather than being replayed automatically. Phase
checkpoints show how far a job progressed. They deliberately do not claim to serialize a provider
session; replaying an orphaned job requires an explicit operator acknowledgement because prior side
effects may be ambiguous.

Human-required provider operations create an expiring SQLite inbox record and suspend that provider
call. The CLI resolves a pending request with an atomic state transition; a second decision cannot
replace it. Only a redacted operation summary is persisted, and the final decision is attached to
the agent run receipt. The approval carries its workflow job ID, and queue cancellation aborts a
pending wait. This is live-session continuation, not durable provider-session serialization.

## Security defaults

- read-only actions may be approved by policy;
- writes, shell execution, and network access require a human decision;
- subprocesses use argument arrays with `shell: false`;
- worktrees are confined to `.etnpilot/worktrees/`;
- secrets come from environment variables or a future secret-provider plugin;
- receipts contain execution metadata, but should never include raw credentials.
- webhook signing secrets and API tokens are read from the environment and never persisted.
