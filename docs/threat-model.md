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
| Deny-first policy (`src/policy/engine.js`) | Steered model touching protected files or hosts | Paths are compared textually; the workspace has no misleading symlinks |
| Human approval with full-fidelity display | Steered model smuggling a command past review | The reviewer reads the command |
| Worktree isolation | Damage to the operator's checkout | `git worktree` semantics; run cleanup policy |
| Allow-listed check environment | Exfiltration of credentials by agent-authored test code | Checks are started by ETNPilot, not by an approved shell command |
| Plugin worker processes | Malicious plugin reading the filesystem or environment | Node permission model; no network restriction is enforced by it |
| Hash-chained, signed receipts | Later tampering with the record of a run | Signing key is not readable by the agent; verifier holds the public key |
| Webhook signature and delivery de-duplication | Forged or replayed GitLab deliveries | Signing secret stays secret; clock skew below tolerance |
| `git.issueTrigger.allowedUsers` | Untrusted contributor starting runs | The GitLab account list is maintained |

## Accepted risks

- **An approved shell command is unconstrained.** It runs with the operator's
  privileges and can reach anything that process can reach, including the
  network and the GitLab token in the parent environment. Policy path rules do
  not apply to it. This is the single largest hole; a disposable container per
  run is the mitigation we have not yet implemented.
- **Path rules are textual.** `realpath` is not applied, so a symlink created
  during a run can point a permitted path at a protected file. Path matching is
  case-insensitive on macOS and Windows, which closes the `.ENV` variant of this
  problem but not the symlink variant.
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
