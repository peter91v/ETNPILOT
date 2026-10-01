# Threat model

This document states what ETNPilot defends against, what it does not, and which
assumption each control rests on. It is written to be falsifiable: if a
statement here is wrong, that is a bug.

## Assets

| Asset | Why it matters |
| --- | --- |
| Repository contents | The agent can modify them and publish the result. |
| GitLab API token | Grants push and merge-request access to the project. |
| Receipt signing key | Signs evidence others rely on. |
| Secrets reachable from the host environment | Anything the process can read, the agent may be able to exfiltrate through an approved command. |
| The reviewer's attention | Every control ends in a human decision. |

## Adversaries

1. **A steered model.** The agent reads untrusted content — issue text, source
   files, dependency metadata, tool output — and may be instructed by it. This
   is the primary adversary and is assumed to be present in every run.
2. **An untrusted contributor.** Somebody who can open an issue, apply a label,
   or land a commit in the repository the agent reads.
3. **A malicious or careless plugin.** Third-party code loaded by configuration.
4. **A network attacker** between ETNPilot and GitLab or an OTLP collector.

Out of scope: an attacker with local code execution as the ETNPilot user, a
malicious operator, and compromise of the provider itself. Any of these ends the
game.

## Controls and the assumption each rests on

| Control | Defends against | Assumes |
| --- | --- | --- |
| Deny-first policy (`src/policy/engine.js`) | Steered model touching protected files or hosts | Policy canonicalizes paths; workspace file tools pin directory descriptors, reject symlinks and hard links, and recheck approved contents |
| Human approval with full-fidelity display | Steered model smuggling a command past review | The reviewer reads the command |
| Worktree isolation | Damage to the operator's checkout | `git worktree` semantics; run cleanup policy |
| Allow-listed check environment | Exfiltration of credentials by agent-authored test code | Checks, replay and workspace commands use the same reviewed environment allowlist |
| Plugin worker processes | Malicious plugin reading the filesystem or environment | Node permissions, restricted imports, mediated resource grants, and available RSS monitoring; sockets are not restricted by the kernel |
| Hash-chained, signed receipts | Later tampering with the record of a run | Signing key is not readable by the agent; verifier holds the public key |
| Webhook signature and delivery de-duplication | Forged or replayed GitLab deliveries | Signing secret stays secret; clock skew below tolerance |
| `git.issueTrigger.allowedUsers` | Untrusted contributor starting runs | The GitLab account list is maintained |

## Accepted risks

- **Approved commands execute code.** Policy path rules do not mediate filesystem
  accesses inside them. Commands receive an allowlisted environment and run with
  the operator's privileges unless the existing Docker/Podman sandbox is enabled.
  The sandbox mounts the workspace and defaults to no network. Each invocation
  has an owned container name, cleaned up even after client interruption.
- **Concurrent local writers remain outside the trust boundary.** File tools
  detect content and parent changes during approvals and anchor access through
  directory descriptors. Node does not provide a filesystem compare-and-swap:
  a hostile local process racing the final write is out of scope. Secure writes
  require `/proc/self/fd` or `/dev/fd`; unsupported platforms fail closed.
- **Workspace leases coordinate ETNPilot processes.** They do not lock a person's
  editor. Undo uses the tool's content journal and skips modified files; shell
  commands, formatters, and provider-owned filesystem effects are not attributed
  automatically. Historical turns without a journal require manual review.
- **Process groups are lifecycle management.** POSIX cancellation kills ordinary
  descendants; programs intentionally creating another session can escape a group.
  Use container isolation for such commands. Windows has leader-only termination;
  a container is required for descendant containment there.
- **Plugin network access is blocked in the worker only by removing the client
  globals and refusing network imports.** The Node permission model in the
  supported versions does not restrict sockets, so a determined plugin that
  finds another path to the network is not stopped by the kernel.
- **Receipts record decisions, not consequences.** A signed receipt proves what
  ETNPilot observed and approved. It cannot prove that an approved command did
  nothing else.
- **Prompt injection is not solved.** Every control above assumes the model may
  be hostile; none of them prevents it from *trying*.
- **Evidence and secrets live on one machine.** The signing key, the approval
  database, and the agent run on the same host.

## Verifying a run after the fact

```bash
etnpilot receipt verify .etnpilot/state/runs/<run-id>.jsonl --root . --require-signatures
```

A trustworthy result reports `valid: true`, `terminal: true`, the expected
`keyIds`, and `encoding: "canonical"`. Check the approvals recorded in the run
against the diff that was published.

## Evidence and transport limits

Replay refuses invalid, incomplete, or required-but-unsigned evidence before
execution, parses the verified snapshot once, and applies current check environment
and sandbox configuration. A hash chain alone does not authenticate its author;
use `--require-signatures` with trusted public keys for imported receipts.

MCP servers are project-configured executable code, started before tool approvals.
Their stdio transport has frame, total-output, schema-count, pending-RPC, timeout,
and shutdown bounds. They do not receive plugin worker permissions; review the
committed command and environment, or run the server in an appropriate container.
Tool approvals authorize calls, not server startup or its internal side effects.

Search regexes execute in a bounded worker thread rather than the event loop.
Fetches and attachments stop at byte limits during reading, cancel discarded
response bodies, and preserve complete UTF-8 characters. Directories are bounded
and charged against the attachment budget. Attachment digests identify sent text.
