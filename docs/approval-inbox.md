# Human approval inbox

The approval inbox lets a non-interactive ETNPilot service pause a provider operation until a human
approves or rejects it from another process. It uses a local SQLite database in WAL mode, so the
webhook service and CLI can safely access it at the same time.

## Configuration

```yaml
approval:
  allow: [read]
  requireHuman: [write, shell, network]
  inbox:
    enabled: true
    database: .etnpilot/state/approvals.sqlite
    timeoutMs: 86400000
    pollIntervalMs: 500
```

Interactive `etnpilot run` commands continue to use the terminal prompt. The inbox is attached to
the GitLab webhook service, where no interactive terminal exists.

## Review workflow

List pending requests:

```bash
etnpilot approval list --root /path/to/project
```

Inspect one request:

```bash
etnpilot approval show <id> --root /path/to/project
```

Approve or reject exactly once:

```bash
etnpilot approval approve <id> --actor maintainer --reason "Command reviewed"
etnpilot approval reject <id> --actor maintainer --reason "Path is outside task scope"
```

Use `--status all` to inspect the history. Supported states are `pending`, `approved`, `rejected`,
and `expired`. A second decision for the same request fails instead of replacing the first decision.

## Stored evidence

The database records the run ID, agent, operation type, timestamps, decision, reviewer, reason, and
a redacted operation summary. Shell secrets, authorization headers, URL queries, and credential-like
environment assignments are removed before persistence. Raw prompts and complete provider requests
are not stored. The database file is created with owner-only permissions where the operating system
supports POSIX file modes.

Each provider approval result is also written to the run receipt with the approval ID, decision,
redacted details, reviewer, and decision timestamp.

## Lifecycle limits

The first version resumes work only while the ETNPilot service and provider session remain alive.
A graceful service shutdown rejects active waits. After an ungraceful process crash, pending rows
remain visible until they expire, but approving them does not recreate the lost provider session.
Automatic restart recovery requires durable workflow checkpoints and is a separate roadmap item.

Protect the project directory and approval CLI with normal operating-system access controls. Anyone
who can write the inbox database can authorize agent operations.
