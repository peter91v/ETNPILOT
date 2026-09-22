# Durable workflow queue

GitLab webhook work is accepted into a local SQLite queue before the HTTP receiver returns. A
unique delivery ID prevents duplicate jobs across retries and process restarts. Queue writes use
WAL mode and worker claims use an immediate transaction, so two service instances cannot claim the
same ready job.

## Configuration

```yaml
queue:
  database: .etnpilot/state/workflows.sqlite
  pollIntervalMs: 500
  leaseMs: 30000
  retryDelayMs: 5000
  maxAttempts: 1
```

Keep `maxAttempts: 1` unless an executor can prove that a failed operation is safe to replay. A
retry is scheduled automatically only when the error is explicitly marked both retryable and safe
to replay.

## Lifecycle

Jobs move through these states:

- `queued` and `retry_scheduled`: safe for a worker to claim;
- `running`: owned by one worker with a renewable lease;
- `cancel_requested`: the worker is propagating cancellation;
- `succeeded`, `failed`, and `canceled`: terminal outcomes;
- `orphaned`: the lease expired or the service stopped during execution.

Each running job records phase checkpoints such as status synchronization, workflow start,
approval wait, workflow completion, and GitLab finalization. These checkpoints are operational
evidence; they do not serialize or recreate a provider session.

Queued jobs are picked up automatically after a restart. An active job whose worker disappears is
marked `orphaned` after its lease expires. ETNPilot never replays it automatically because a tool,
file, or remote action may already have happened.

## Operator commands

```bash
etnpilot queue list --root /path/to/project
etnpilot queue show <job-id> --root /path/to/project
etnpilot queue cancel <job-id> --actor maintainer --reason "Superseded"
etnpilot queue resume <job-id>
etnpilot queue resume <orphaned-job-id> --force
```

Resuming an orphaned job requires `--force` as an explicit acknowledgement of possible prior side
effects. Inspect its checkpoint, run receipt, worktree, and GitLab state first. Canceling a running
job is observed by the worker heartbeat and propagated to workflow execution and any pending human
approval.

## Stored data

The queue stores the filtered GitLab issue task needed for restart recovery, including its title and
description, plus operational metadata and redacted failure summaries. It does not store GitLab API
tokens, webhook secrets, provider credentials, or raw provider responses. The database and its
parent state directory use owner-only permissions on POSIX systems. Protect project filesystem
access because issue descriptions can contain sensitive business context.
