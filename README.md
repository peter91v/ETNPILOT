# ETNPilot

ETNPilot is a GitLab-first, provider-neutral harness for auditable software-engineering agents. It combines isolated Git worktrees, explicit human approvals, content-addressed receipts, reusable agents, skills, prompts, plugins, and local [CodeGraph](https://github.com/colbymchenry/codegraph) code intelligence.

## Status

The repository is in early development. The first runnable vertical slice provides:

- a composable harness for providers, plugins, agents, and subagents;
- a GitHub Copilot SDK provider that uses an existing Copilot login or token;
- an OpenAI-compatible provider adapter;
- conservative approval policy hooks and proof-carrying JSONL receipts;
- isolated Git worktrees without shell interpolation;
- a client for self-hosted GitLab projects, branches, merge requests, notes, and pipelines;
- local CodeGraph indexing and MCP access across its supported languages;
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
- OTLP/HTTP traces with provider usage, configurable cost estimates, and workflow budgets.
- one restricted worker process per plugin with bounded RPC, runtime, memory, and output.
- an isolated OIDC/Vault secret-provider plugin with scoped secret and HTTPS grants.
- reviewed SHA-256 pins and run provenance for agents, instructions, prompts, and skills.

## Quick start

Node.js 22.13 or newer is required; `node:sqlite` backs the durable queue and
the approval inbox.

```bash
npm install
npm install @github/copilot-sdk
npm run etnpilot -- init .            # or: init . --template regulated
npm run etnpilot -- doctor            # verify node, git, sqlite, and the SDK
# Describe at least one agent under .etnpilot/agents/, then:
git add .etnpilot && git commit -m "Add ETNPilot configuration"
npm run etnpilot -- content lock --root .
npm run etnpilot -- graph build .
npm test
```

`init` writes the configuration plus a starter `orchestrator` agent and prompt,
and never overwrites files that already exist. A run needs an agent manifest
under `.etnpilot/agents/` whose name matches `defaultAgent` or the workflow
steps; otherwise the run stops before it starts and reports which agents are
configured.

Commit `.etnpilot/` before the first run. Worktree runs check out the committed
base ref, so an uncommitted configuration is not visible inside the run
workspace.

### Where configuration is read from

A worktree run reads its configuration from two places, which matters while you
are editing it:

| Read from the main checkout | Read from the run worktree (committed state) |
| --- | --- |
| policy, approval, secrets, receipt signing, observability, plugin isolation, queue | agents, prompts, skills, instructions, providers, routing, workflow steps |

Governance settings therefore take effect immediately, while agent and workflow
changes take effect once committed. Use `--no-worktree` to run everything from
the working tree.

Optionally create a receipt-signing key and enable `receipts.signing` in the generated configuration:

```bash
etnpilot receipt keygen --root .
etnpilot receipt verify .etnpilot/state/runs/<run-id>.jsonl --root .
```

The private key stays in the ignored `.etnpilot/keys/` directory. The shareable public key
fingerprint is written into signed receipts and GitLab evidence notes. See
[docs/signed-receipts.md](docs/signed-receipts.md).

## Code intelligence

ETNPilot installs the existing `@colbymchenry/codegraph` package and initializes its local
`.codegraph/` index. The same upstream engine supplies CLI evidence and the `codegraph_explore`
tool exposed to GitHub Copilot over a local stdio MCP process. The default allow-list contains only
that read-only exploration tool; the index and source stay on the machine.

CodeGraph detects supported languages automatically, including TypeScript, JavaScript, Python, Go,
Rust, Java, C#, PHP, Ruby, C/C++, Swift, Kotlin, Scala, Dart, Svelte, Vue, Astro, Lua, Terraform,
and others. No language-specific ETNPilot parser configuration is required.

```bash
etnpilot graph build .
etnpilot graph dependencies src/core/harness.js
etnpilot graph dependents src/core/harness.js
etnpilot graph symbols src/core/harness.js
etnpilot graph impact src/core/harness.js --depth 10
etnpilot graph stats
```

`graph build` initializes the project on its first run and performs an incremental sync afterward.
Every normal workflow builds or refreshes the index before the planning step, makes the local MCP
tool available to agent sessions, and syncs again after execution. Changed source files, transitive
consumers, and affected tests are written into the workflow receipt. Static analysis is evidence
for review and test selection, not proof that unaffected files are safe.

The generated configuration keeps upstream telemetry disabled by default and pins the MCP tool
allow-list explicitly:

```yaml
codegraph:
  enabled: true
  autoIndex: true
  maxImpactDepth: 20
  startupTimeoutMs: 30000
  tools: [codegraph_explore]
```

Set `enabled: false` when a project must run without code intelligence. ETNPilot uses the pinned
platform bundle installed with its npm dependency, so repository configuration cannot replace the
MCP executable. CodeGraph telemetry and update checks stay disabled in the managed MCP process.

## Content provenance

Project-owned agents, instructions, prompts, and skills can be locked to a deterministic SHA-256
manifest. Runs in enforcement mode load the verified in-memory snapshot and check the content and
lock again before sealing the terminal receipt:

```bash
etnpilot content lock --root .
etnpilot content verify --root .
```

The lock never updates implicitly. Review and commit `.etnpilot/content-lock.json` together with an
intentional content change. Symbolic links, path escapes, missing or malformed locks, unreviewed
entries, and mid-run replacement are rejected. See
[docs/content-provenance.md](docs/content-provenance.md) for configuration and adoption details.

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

The default comes from `workspace.mode` in `.etnpilot/etnpilot.yaml`. Cleanup defaults to `never`. Requested cleanup only removes a clean worktree; a worktree containing uncommitted changes is retained and reported as `dirty-worktree`. Use `etnpilot worktree list` and `etnpilot worktree cleanup <name>` for manual housekeeping; `etnpilot merge list` shows what those runs published.

`--in-place` remains available as a compatibility alias for `--no-worktree`.

`etnpilot run` exits with status 0 only when the workflow succeeded. A failed
workflow exits 1, is never published, and is reported as failed to GitLab.

Operations such as writes, shell commands, and network access require confirmation in an interactive terminal and are rejected when no terminal is available. The prompt shows the full command, file, tool arguments, and URL with control characters escaped, so what you read is what you approve. Publishing is never implicit. Once the GitLab remote and the `gitlab.apiToken` secret are configured, `--publish` commits the reviewed work, pushes its run branch, and opens a draft merge request. Setting `workspace.cleanup` to `after-publish` removes the clean linked worktree after a successful publication while retaining its branch.

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

The route is, in order: the agent's own `provider`, then `routing.rules`, then
`routing.defaults`, then the project's `defaultProvider`. An agent manifest that names no
provider takes `defaultProvider` too, so one provider does not have to be repeated in every
agent.

Built-in GitHub Copilot sessions provide `chat`, `tools`, `permissions`, and `skills`; the
OpenAI-compatible adapter currently provides `chat`. ETNPilot skips unavailable or incompatible
providers. It retries with another provider only when the adapter marks the failure as both
retryable and safe to replay. The selected provider and all routing attempts are stored in the run
receipt.

When nothing in the route works, the error says what was tried, why each one was passed over or
failed, and which providers are configured and ready — a provider that refused a connection is
named as such rather than reported as "no provider can satisfy".

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
file-security rules, isolated Vault configuration, and extension example.

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

## Observability and budgets

Every workflow can write OpenTelemetry-compatible OTLP/JSON spans locally and optionally export
them to an OTLP/HTTP collector. Provider spans use the GenAI token attributes, while prompts,
responses, credentials, and tool arguments are excluded from telemetry.

```yaml
observability:
  enabled: true
  file: .etnpilot/state/telemetry.jsonl
  failureMode: ignore
  otlp:
    enabled: false
    endpoint: http://127.0.0.1:4318/v1/traces
  pricing:
    currency: USD
    models:
      team-model:
        inputPerMillion: 2
        outputPerMillion: 8
  budgets:
    maxInputTokensPerWorkflow: 500000
    maxEstimatedCostPerWorkflow: 5
```

Pricing is operator-supplied and produces an estimate, not a billing statement. Copilot SDK usage
units are tracked separately from currency. Inspect all data or one workflow without a collector:

```bash
etnpilot telemetry summary
etnpilot telemetry summary <workflow-run-id>
```

See [docs/observability.md](docs/observability.md) for OTLP authentication, supported budgets, and
failure behavior.

## Plugin SDK

Plugins use a versioned manifest and receive only the APIs they declare. Configured plugins are
imported and executed in dedicated worker processes; plugin code is never evaluated in the harness
process:

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
`prompt.register`, `instruction.add`, `event.subscribe`, `secret.register`, `secret.read`, and
`network.fetch`. Secret inputs and HTTPS URL prefixes require explicit per-plugin grants in
addition to capability declarations. Optional `dependencies` are plugin names; ETNPilot loads them
in dependency order and rejects missing or cyclic dependency graphs.

Configure global worker limits and optional per-plugin overrides in `.etnpilot/etnpilot.yaml`:

```yaml
pluginIsolation:
  setupTimeoutMs: 10000
  callTimeoutMs: 30000
  shutdownTimeoutMs: 1000
  memoryMb: 128
  maxOutputBytes: 65536
  maxMessageBytes: 1048576
  maxPendingRequests: 32
  memoryPollIntervalMs: 100

plugins:
  - path: ./.etnpilot/plugins/team-guidance.mjs
    options: { strict: true }
    limits:
      callTimeoutMs: 5000
      memoryMb: 96
```

Plugin entries must be ECMAScript modules. The worker receives an empty environment, cannot import
filesystem, process, subprocess, worker-thread, or network modules, and cannot use global network
clients. Standard output, standard error, RPC messages, heap/RSS, setup, calls, cancellation, and
shutdown are bounded. See [docs/plugin-isolation.md](docs/plugin-isolation.md) for the security and
lifecycle contract.

## GitLab issue trigger

The webhook receiver is opt-in. Enable `git.issueTrigger`, require a dedicated label, and start the
local receiver:

```yaml
git:
  issueTrigger:
    enabled: true
    labels: [etnpilot]
    actions: [open, reopen]
    allowedUsers: [your-gitlab-username]   # required while enabled
    fetchBeforeRun: true
    allowConfidential: false
    publish: false
    syncStatus: true
    comment: false
```

`allowedUsers` must name at least one user while the trigger is enabled;
otherwise the receiver refuses to start. With `fetchBeforeRun` the receiver
fetches the target branch before each run, so queued work starts from its
current tip instead of a stale local `HEAD`. A local `GET /healthz` reports
readiness and queue counts.

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

## Checks

Workflow checks execute code the agent just wrote. They run with an
allow-listed environment — `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`,
plus `ETNPILOT_CHECK=1` — so repository and provider credentials stay out of
reach. Add what a check genuinely needs:

```yaml
checks:
  envAllow: [CI, NPM_CONFIG_REGISTRY]
```

## Settings

```bash
etnpilot config list --changed
etnpilot config set queue.workers 4          # stays on this machine
etnpilot config set sandbox.enabled true     # stricter than the default: allowed
etnpilot config set approval.allow '[read, write]'
# etnpilot: Cannot change 'approval.allow': entries may only be removed; 'write' would be added.
```

Only the default is committed. Everything a person changes lands in
`.etnpilot/etnpilot.local.yaml` or `~/.config/etnpilot/config.yaml`, neither of
which is ever checked in. The committed default declares, per setting, whether a
user may change it freely, only narrow it, or not at all — and a run's receipt
names which layers were in effect. See [docs/settings.md](docs/settings.md).

## Terminal interface

```bash
etnpilot tui --root .
```

Approvals, the queue, runs, settings, the worktrees, and the project's merge
requests in one full-screen view, with the whole command and the rule that
stopped it. Decisions go to the same inbox the CLI and
the page use; settings are edited against the same layers and refused for the
same reasons. `n` starts a run whose approvals come back to this same window,
which is the one thing `etnpilot run` cannot do — it holds the terminal it is
asking from. The worktrees view says what removing one would throw away and
refuses to throw it away; the merge requests view puts the ones a run published
above everyone else's. See [docs/tui.md](docs/tui.md).

## Local review UI

```bash
etnpilot ui --root .
# ETNPilot review UI: http://127.0.0.1:8788/?token=…
# Opened it with 'xdg-open'. Use --no-open to keep it in the terminal.
```

The same things the terminal interface shows, in a browser: approvals with
their full command and the rule that stopped them, the queue with cancel and
resume, a run's sealed receipt, the worktrees, the project's merge requests,
the settings with their layers, and a box to start a run whose approvals come
back to the same page. It binds to localhost, requires the token it prints, and
loads nothing from anywhere. See [docs/review-ui.md](docs/review-ui.md).

## Sandboxed execution

Checks and approved commands can run in a disposable container that sees only
the workspace and, by default, no network:

```yaml
sandbox:
  enabled: true
  runtime: docker
  image: node:24-bookworm-slim
  network: none
  useDevcontainerImage: false
```

If the runtime is missing the run fails rather than quietly executing on the
host. See [docs/sandbox.md](docs/sandbox.md).

## Dry runs, fixtures, and replay

```bash
etnpilot run "Upgrade the driver" --dry-run          # decide nothing, change nothing
etnpilot run "Upgrade the driver" --record-fixtures fixtures.json
etnpilot run "Upgrade the driver" --fixtures fixtures.json   # offline, deterministic
etnpilot replay .etnpilot/state/runs/<run-id>.jsonl          # re-check the record
```

A dry run evaluates policy and records what it would have decided. Fixtures
record redacted provider answers so a run can be repeated offline. Replay
re-runs a receipt's checks and reports drift; it does not pretend to replay the
model. See [docs/reproducibility.md](docs/reproducibility.md).

## Reviewer quorum

A `quorum` step requires independent reviewers, usually on different providers,
to agree before a change counts as reviewed:

```yaml
workflow:
  steps:
    - id: review
      type: quorum
      agents: [reviewer-copilot, reviewer-backup]
      required: 2
      distinctProviders: true
      needs: [build]
```

Each reviewer ends its answer with `VERDICT: approve` or `VERDICT: reject`;
anything else is an abstention. Two reviewers on the same provider count once,
because they are one opinion with two voices. One rejection blocks the step.

## Supply-chain gates

```bash
etnpilot deps check      # npm, PyPI, Go, and Cargo: licenses and denied packages
etnpilot sbom            # CycloneDX inventory
etnpilot scan secrets    # credentials in tracked files
etnpilot attest <receipt-file>   # in-toto/SLSA provenance for a run
```

See [docs/supply-chain.md](docs/supply-chain.md).

## Security

Read [SECURITY.md](SECURITY.md) for the security model and reporting process,
and [docs/threat-model.md](docs/threat-model.md) for the adversaries each
control assumes, together with the accepted risks — the widest of which is that
an approved shell command runs unconstrained.

## Repository strategy

GitHub is the initial development remote. The canonical GitLab target is:

`https://gitlab.metropol-it.at/varga.pter91/etnpilot`

Both repositories may keep their existing initial commits. Synchronization is performed through explicit branches and reviewed merges, never by rewriting `main`.

## Upstream

The design starts from `peter91v/agentwerk` at commit `87ea7e669b8cc5b24462c297817eb8f139b3eeea`. See [UPSTREAM.md](UPSTREAM.md) and [docs/architecture.md](docs/architecture.md).
