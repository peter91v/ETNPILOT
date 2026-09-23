# Security policy

ETNPilot runs language models with access to a repository, a shell, and a
GitLab account. Treat every deployment as security-relevant.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository owner rather than
through a public issue. Include the affected version or commit, the
configuration that reproduces the problem, and the impact you observed. Expect
an acknowledgement within five working days.

Do not include credentials, customer data, or full receipt files in a report.
A receipt hash and the relevant lines are enough.

## Supported versions

The project is pre-1.0. Only the `main` branch receives fixes.

## Security model in one page

ETNPilot assumes the model is untrusted and may be steered by the content it
reads — issue text, source files, dependency READMEs, tool output. Its defences
are therefore about *containment and evidence*, not about trusting the agent:

- **Deny-first policy.** Operations are rejected unless a rule allows them.
  Writes, shell commands, and network calls default to human review.
- **Human approval.** Approvals show the full command, file, tool arguments, and
  URL, with control characters escaped, so a reviewer sees exactly what they
  approve. Approval decisions are recorded in the run receipt.
- **Isolation.** Runs happen in a dedicated Git worktree. Plugins run in
  separate processes under the Node permission model with an empty environment.
  Checks inherit an allow-listed environment only.
- **Evidence.** Every run produces a hash-chained, optionally Ed25519-signed
  receipt that seals when the run ends.

## Known limits

These are deliberate gaps, not oversights. Read `docs/threat-model.md` for the
full list before deploying:

- An approved shell command runs with the operator's own privileges. Shell is
  the widest hole in the policy, and path rules do not constrain it.
- Path rules are textual. Symbolic links are not resolved.
- Receipts prove what ETNPilot recorded. They do not prove the absence of side
  effects from an approved command.
- The receipt signing key lives on the machine that runs the agent.

## Hardening checklist

1. Keep `policy.operations.default: deny` and review the rule set.
2. Set `git.issueTrigger.allowedUsers` to the smallest possible list.
3. Run the webhook receiver on localhost behind an authenticated TLS proxy.
4. Never store credentials the run does not need in the environment of the
   process that starts ETNPilot.
5. Enable receipt signing and archive the public key separately.
6. Prefer a disposable container per run where untrusted input can reach the
   agent.
