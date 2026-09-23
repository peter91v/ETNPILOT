# Local review UI

```bash
etnpilot ui --root .
# ETNPilot review UI: http://127.0.0.1:8788/?token=…
```

A local page for the evidence ETNPilot already produces: approvals waiting for
a decision, the workflow queue, and finished runs read from their receipt
files. It is a second window onto the same databases the CLI uses, never a
second source of truth.

## What it shows

- **Pending approvals** with the full command, file, tool arguments, or URL —
  the same fidelity as the terminal prompt, because a reviewer can only approve
  what they can read. Decisions are recorded with the reviewer's name as
  `ui:<name>`.
- **The workflow queue** with status and attempt counts.
- **Runs** with their status, mode, whether the receipt is sealed and signed,
  how many approvals they required, and the receipt hash.

Every value is inserted as text, never as markup, because all of it is text an
agent controlled.

## Security

The server binds to `127.0.0.1` and mints a token at startup. The token is in
the URL it prints; API calls must send it in an `x-etnpilot-token` header,
which a page on another origin cannot set without a preflight this server
refuses. The page itself loads nothing from anywhere — no CDN, no fonts, no
analytics — and says so in its content security policy.

**Anyone who has the token can approve operations**, exactly as anyone who can
write the inbox database can. Do not forward the URL, and do not expose the
port. There is no user model here: the UI names the reviewer from an input
field, the same self-declared identity the CLI's `--actor` provides. For an
identity asserted by someone else, use the GitLab comment flow in
[gitlab-webhooks.md](gitlab-webhooks.md).

## Limits

The UI is read-mostly: it decides approvals and cancels queue jobs. It does not
start runs, edit configuration, or change policy — those belong in the CLI,
where they are reviewable as commands.
