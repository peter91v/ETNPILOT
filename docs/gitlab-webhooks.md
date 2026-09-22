# GitLab webhooks

ETNPilot can turn a deliberately labeled GitLab issue into a queued workflow run. The receiver is
disabled by default and never merges code. Publishing, issue comments, and status synchronization
are separate configuration choices.

## Security model

The receiver accepts only the configured path and project. A delivery must pass all of these gates:

1. Valid HMAC signature with a recent timestamp, or a matching legacy webhook token.
2. A stable GitLab delivery ID for deduplication.
3. `Issue Hook` event with a supported action.
4. Exact `git.project` match.
5. Every configured label is present.
6. The author is in `allowedUsers` when that list is non-empty.
7. Confidential issues are rejected unless explicitly enabled.

Signing-token authentication is preferred. ETNPilot validates the signature over the unmodified
request body and accepts timestamps within five minutes by default. If a signature header is
present but no signing secret is configured, the request fails closed instead of falling back to a
weaker token check.

## Configuration

```yaml
git:
  baseUrl: https://gitlab.example.com
  project: group/project
  targetBranch: main
  webhook:
    path: /webhooks/gitlab
    host: 127.0.0.1
    port: 8787
    maxBodyBytes: 1048576
    timestampToleranceSeconds: 300
  issueTrigger:
    enabled: true
    labels: [etnpilot]
    actions: [open, reopen]
    allowedUsers: [maintainer]
    allowConfidential: false
    agent: orchestrator
    worktree: true
    cleanup: never
    publish: false
    syncStatus: true
    comment: false
queue:
  database: .etnpilot/state/workflows.sqlite
  pollIntervalMs: 500
  leaseMs: 30000
  retryDelayMs: 5000
  maxAttempts: 1
```

The generated configuration maps GitLab's logical secret names to environment variables:

| Variable | Purpose |
|---|---|
| `ETNPILOT_GITLAB_WEBHOOK_SIGNING_SECRET` | Preferred `whsec_...` signing token |
| `ETNPILOT_GITLAB_WEBHOOK_TOKEN` | Legacy secret-token fallback |
| `ETNPILOT_GITLAB_TOKEN` | GitLab API token for commit status, comments, or publishing |

At least one webhook authentication secret is mandatory. The API token is mandatory when any
GitLab write-back feature is enabled.

The mappings may instead select another configured backend, for example files provisioned by the
host:

```yaml
secrets:
  providers:
    runtime-files:
      type: file
      root: /run/secrets/etnpilot
      requireOwnerOnly: true
  values:
    gitlab.webhookSigningSecret: { provider: runtime-files, key: webhook-signing }
    gitlab.apiToken: { provider: runtime-files, key: api-token }
```

Use `etnpilot secret check gitlab.webhookSigningSecret --root /path/to/project` to validate
availability without displaying the secret. See [secrets.md](secrets.md) for backend and file
permission rules.

## GitLab setup

1. Expose the receiver through HTTPS and forward only `/webhooks/gitlab` to its local port.
2. In the project, open **Settings → Webhooks**.
3. Enter the public HTTPS endpoint.
4. Configure a signing token when the GitLab version supports it; otherwise use a secret token.
5. Enable **Issue events** only.
6. Test the webhook before enabling `git.issueTrigger.enabled`.

Start the receiver:

```bash
etnpilot webhook serve --root /path/to/project
```

The HTTP request is acknowledged after authentication, filtering, and an atomic SQLite queue
insert. Workflow execution is serialized in the background. Duplicate deliveries return the
existing job state without starting another run. Pending jobs survive service restarts.

## Status and publishing

With `syncStatus: true`, ETNPilot creates or updates an external commit status named
`etnpilot/issue-<iid>` on the checked-out base commit. Temporary GitLab `409` conflicts are retried
up to three times. `comment: true` writes a completion note to the issue. `publish: true` follows the
normal reviewed draft-merge-request path; it does not merge.

Webhook runs use the normal approval policy. Human-required operations pause in the persistent
approval inbox and continue only after an explicit one-time CLI decision. A graceful service
shutdown rejects active waits. A running job with an expired worker lease becomes `orphaned` and
requires an inspected, explicit `etnpilot queue resume <job-id> --force`; queued jobs resume
automatically. Provider sessions themselves are not serialized. See
[workflow-queue.md](workflow-queue.md).
