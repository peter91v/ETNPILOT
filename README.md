# ETNPilot

ETNPilot is a GitLab-first, provider-neutral harness for auditable software-engineering agents. It combines isolated Git worktrees, explicit human approvals, content-addressed receipts, reusable agents, skills, prompts, plugins, and an embedded SQLite code graph.

## Status

The repository is in early development. The first runnable vertical slice provides:

- a composable harness for providers, plugins, agents, and subagents;
- a GitHub Copilot SDK provider that uses an existing Copilot login or token;
- an OpenAI-compatible provider adapter;
- conservative approval policy hooks and proof-carrying JSONL receipts;
- isolated Git worktrees without shell interpolation;
- a client for self-hosted GitLab projects, branches, merge requests, notes, and pipelines;
- an embedded SQLite code graph for JavaScript and TypeScript;
- `.etnpilot/` project initialization and GitHub/GitLab CI.
- a dependency-aware workflow scheduler with retries, timeouts, concurrency limits, and fail-fast handling;
- `etnpilot run` for isolated agent/check workflows with chained receipts;
- an explicit `--publish` path for reviewed GitLab draft merge requests.
- a versioned plugin SDK with declared capabilities and dependency ordering;
- capability-aware provider routing with conservative, auditable fallback.
- an authenticated GitLab issue webhook backed by a durable SQLite workflow queue with leases,
  checkpoints, cancellation, and conservative restart recovery.
- optional Ed25519 signatures for sealed, independently verifiable receipt chains.
- a versioned secret-provider API with policy-restricted environment and confined file backends.
- deny-first policy-as-code for operation types, workspace paths, network hosts, and providers.

## Quick start

```bash
npm install
npm install @github/copilot-sdk
npm run etnpilot -- init .
npm run etnpilot -- graph build .
npm test
```

Optionally create a receipt-signing key and enable `receipts.signing` in the generated configuration:

```bash
etnpilot receipt keygen --root .
etnpilot receipt verify .etnpilot/state/runs/<run-id>.jsonl --root .
```

The private key stays in the ignored `.etnpilot/keys/` directory. The shareable public key
fingerprint is written into signed receipts and GitLab evidence notes. See
[docs/signed-receipts.md](docs/signed-receipts.md).

## Code intelligence

The embedded code graph incrementally indexes JavaScript and TypeScript files, resolves relative imports to project paths, and traverses reverse dependencies to estimate change impact:

```bash
etnpilot graph build .
etnpilot graph dependencies src/core/harness.js
etnpilot graph dependents src/core/harness.js
etnpilot graph symbols src/core/harness.js
etnpilot graph impact src/core/harness.js --depth 10
etnpilot graph stats
```

Dependency, dependent, and impact results carry a `dangling` flag. Edges to a deleted file are
deliberately retained so impact analysis can still answer "what depended on this?", but the flag
marks the target as no longer present in the index.

Every normal workflow updates the graph before and after execution. Changed source files, transitive consumers, and affected tests are written into the workflow receipt. Static analysis is evidence for review and test selection, not proof that unaffected files are safe.

Run the configured workflow in an isolated worktree:

```bash
npm run etnpilot -- run "Implement the requested change"
```

Worktree use is configurable and can be selected per run:

```bash
# Explicit isolated worktree
npm run etnpilot -- run "Implement the change" --worktree

# Work directly in the current checkout
npm run etnpilot -- run "Implement the change" --no-worktree

# Request cleanup after success
npm run etnpilot -- run "Inspect the project" --worktree --cleanup-worktree
```

The default comes from `workspace.mode` in `.etnpilot/etnpilot.yaml`. Cleanup defaults to `never`. Requested cleanup only removes a clean worktree; a worktree containing uncommitted changes is retained and reported as `dirty-worktree`. Use `etnpilot worktree list` and `etnpilot worktree cleanup <name>` for manual housekeeping.

`--in-place` remains available as a compatibility alias for `--no-worktree`.

Operations such as writes, shell commands, and network access require confirmation in an interactive terminal and are rejected when no terminal is available. Publishing is never implicit. Once the GitLab remote and the `gitlab.apiToken` secret are configured, `--publish` commits the reviewed work, pushes its run branch, and opens a draft merge request. Setting `workspace.cleanup` to `after-publish` removes the clean linked worktree after a successful publication while retaining its branch.

For GitHub Copilot, authenticate with the Copilot CLI/SDK-supported GitHub login. ETNPilot never auto-approves writes, shell commands, or network access by default.

## Provider routing

Agents declare what they need, while routing rules select an ordered provider list:

```yaml
routing:
  defaults: [github-copilot]
  fallback:
    enabled: true
    maxAttempts: 2
  rules:
    - agent: reviewer
      providers: [github-copilot, review-backup]
      require: [chat]
```

Built-in GitHub Copilot sessions provide `chat`, `tools`, `permissions`, and `skills`; the
OpenAI-compatible adapter currently provides `chat`. ETNPilot skips unavailable or incompatible
providers. It retries with another provider only when the adapter marks the failure as both
retryable and safe to replay. The selected provider and all routing attempts are stored in the run
receipt.

## Secret providers

Credentials are referenced by stable names instead of being copied into provider, GitLab, or
receipt-signing configuration. The generated project configuration maps these names to an
allow-listed environment provider and includes an optional confined file provider:

```yaml
secrets:
  providers:
    env:
      type: env
      allow: [ETNPILOT_GITLAB_TOKEN, ETNPILOT_GITHUB_TOKEN]
    local:
      type: file
      root: .etnpilot/secrets
      requireOwnerOnly: true
  values:
    gitlab.apiToken: { provider: env, key: ETNPILOT_GITLAB_TOKEN }
    github.token: { provider: env, key: ETNPILOT_GITHUB_TOKEN }
```

Check whether a configured secret is available without printing its value:

```bash
etnpilot secret check gitlab.apiToken --root .
```

Provider adapters can select another named reference with `tokenSecret` or `apiKeySecret`; receipt
signing supports `privateKeySecret`. See [docs/secrets.md](docs/secrets.md) for the full contract,
file-security rules, and extension example.

## Policy as code

The optional `policy` section is evaluated before human approval. It can deny protected files,
require review for writes and shell operations, restrict network hosts, and constrain which agents
may use a provider. When multiple rules match, the safest effect wins:
`deny` over `human` over `allow`.

```yaml
policy:
  operations:
    default: deny
    rules:
      - id: read-source
        effect: allow
        kinds: [read]
        paths: [src/**, test/**]
      - id: reviewed-writes
        effect: human
        kinds: [write]
        paths: [src/**, test/**]
  providers:
    default: deny
    rules:
      - id: copilot
        effect: allow
        providers: [github-copilot]
```

Inspect a decision without executing the operation:

```bash
etnpilot policy check --kind write --path src/index.js --agent builder
etnpilot policy check --provider github-copilot --agent reviewer
```

See [docs/policy.md](docs/policy.md) for matching semantics and secure defaults.

## Plugin SDK

Plugins use a versioned manifest and receive only the APIs they declare:

```js
import { definePlugin } from "etnpilot";

export default definePlugin({
  apiVersion: 1,
  name: "team-guidance",
  version: "1.0.0",
  capabilities: ["instruction.add", "event.subscribe"],
  setup(context) {
    context.addInstruction("Follow the team's review checklist.");
    context.subscribe("run.completed", (event) => console.log(event.runId));
  },
});
```

Available capabilities are `provider.register`, `agent.register`, `skill.register`,
`prompt.register`, `instruction.add`, and `event.subscribe`. Optional `dependencies` are plugin
names; ETNPilot loads them in dependency order and rejects missing or cyclic dependency graphs.

## GitLab issue trigger

The webhook receiver is opt-in. Enable `git.issueTrigger`, require a dedicated label, and start the
local receiver:

```yaml
git:
  issueTrigger:
    enabled: true
    labels: [etnpilot]
    actions: [open, reopen]
    allowedUsers: [your-gitlab-username]
    allowConfidential: false
    publish: false
    syncStatus: true
    comment: false
```

```bash
export ETNPILOT_GITLAB_WEBHOOK_SIGNING_SECRET='whsec_...'
export ETNPILOT_GITLAB_TOKEN='...'
etnpilot webhook serve --root .
```

For GitLab versions without signing-token support, configure
`ETNPILOT_GITLAB_WEBHOOK_TOKEN` instead. Newer signing tokens authenticate the raw body and reject
stale timestamps. Delivery IDs are claimed atomically in `.etnpilot/state/workflows.sqlite`, so
GitLab retries and service restarts do not launch duplicate workflows. The receiver binds to
`127.0.0.1` by default; expose it
only through a TLS reverse proxy or another authenticated private route.

Inspect and control queued work from another process:

```bash
etnpilot queue list
etnpilot queue show <job-id>
etnpilot queue cancel <job-id> --reason "Superseded"
etnpilot queue resume <job-id>
```

Jobs that were still running when their worker disappeared become `orphaned`; they require
`queue resume <job-id> --force` after inspection because provider or tool side effects may already
have occurred. Jobs that had not started are resumed automatically. See
[docs/workflow-queue.md](docs/workflow-queue.md).

The normal approval policy remains active for webhook runs. With the default policy, writes, shell
commands, and network calls are placed in the persistent approval inbox. Review them from a second
terminal:

```bash
etnpilot approval list
etnpilot approval show <id>
etnpilot approval approve <id> --actor maintainer --reason "Reviewed"
etnpilot approval reject <id> --reason "Unsafe command"
```

The waiting provider receives a one-time decision and the redacted decision evidence is attached to
the run receipt. Approval rows include their durable queue job ID. See
[docs/approval-inbox.md](docs/approval-inbox.md) for lifecycle and recovery limits.
See [docs/gitlab-webhooks.md](docs/gitlab-webhooks.md) for setup and operational details.

## Repository strategy

GitHub is the initial development remote. The canonical GitLab target is:

`https://gitlab.metropol-it.at/varga.pter91/etnpilot`

Both repositories may keep their existing initial commits. Synchronization is performed through explicit branches and reviewed merges, never by rewriting `main`.

## Upstream

The design starts from `peter91v/agentwerk` at commit `87ea7e669b8cc5b24462c297817eb8f139b3eeea`. See [UPSTREAM.md](UPSTREAM.md) and [docs/architecture.md](docs/architecture.md).
