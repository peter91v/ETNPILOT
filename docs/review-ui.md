# Local review UI

```bash
etnpilot ui --root .
# ETNPilot review UI: http://127.0.0.1:8788/?token=…
```

A local page for the evidence ETNPilot already produces: approvals waiting for
a decision, the workflow queue, and finished runs read from their receipt
files. It is a second window onto the same databases the CLI uses, never a
second source of truth.

## What it does

- **Pending approvals** with the full command, file, tool arguments, or URL —
  the same fidelity as the terminal prompt, because a reviewer can only approve
  what they can read — and the rule that stopped the operation. Decisions are
  recorded with the reviewer's name as `ui:<name>`.
- **The workflow queue** with status and attempt counts. `Cancel` and `Resume`
  appear only on the jobs the queue would accept them for, so no button on
  screen teaches an action that cannot happen. Resuming an `orphaned` job is a
  second, explicit decision, exactly as `--force` is in the CLI.
- **Runs** with their status, mode, whether the receipt is sealed and signed,
  and the receipt hash. Opening one reads the receipt itself: the branch and
  sandbox, the merge rehearsal and what it would collide with, every approval
  with who decided it, and which settings layers were in effect.
- **Worktrees**: which branch each holds, which ones a run made, and what
  removing one would throw away. `Remove` goes through the same `removeIfClean`
  the CLI and the TUI use, so a worktree holding unsaved work is kept.
- **Merge requests**: ETNPilot's own first, told apart by their `etnpilot/`
  branch, with everyone else's beside them. This is the only part of the page
  that needs the network and a token; it is read when the page loads and on
  `Ask GitLab`, never in the poll, and says which of the project, the token, or
  GitLab itself is missing.
- **Settings**, against the same layers the CLI and the TUI use: the value, the
  layer it came from, and whether it may be changed (`open`, `stricter-only`,
  `locked`). The value is YAML, as everywhere else. A refusal appears where the
  change was made, with the reason, and the input keeps what was typed. Nothing
  changed here is ever committed — it goes to `.etnpilot/etnpilot.local.yaml`
  or `~/.config/etnpilot/config.yaml`. Local settings the loader refuses are
  reported above the list, because otherwise the next run would be the first to
  mention them.
- **Starting a run**, whose approvals come back to this same page. The request
  is answered at once rather than held for the whole run; what is running, and
  what a run failed with, is part of the state the page polls. Closing the
  server stops the runs it started, as quitting the TUI does.

Every value is inserted as text, never as markup, because all of it is text an
agent controlled.

Long lists say when they are cut rather than showing a count that disagrees
with the rows beneath it, and the poll holds still while a field has focus, so
it never throws away what is being typed.

## Security

The server binds to `127.0.0.1` and mints a token at startup. The token is in
the URL it prints; API calls must send it in an `x-etnpilot-token` header,
which a page on another origin cannot set without a preflight this server
refuses. The page itself loads nothing from anywhere — no CDN, no fonts, no
analytics — and says so in its content security policy.

**Anyone who has the token can approve operations, change local settings, and
start runs**, exactly as anyone who can write these files can. Do not forward the URL, and do not expose the
port. There is no user model here: the UI names the reviewer from an input
field, the same self-declared identity the CLI's `--actor` provides. For an
identity asserted by someone else, use the GitLab comment flow in
[gitlab-webhooks.md](gitlab-webhooks.md).

## Looking at it

The page is a single file with no build step, so changing it means rendering it
and looking: at 1280px and at 390px, in both colour schemes. A page whose
widest table drags every other section off screen still passes a test that only
reads its markup — that one did.

## Limits

The page does not run the checks (`policy check`, `deps check`, `scan secrets`,
`doctor`, `telemetry summary`), verify a receipt, or replay a run; those are
still CLI commands. Every surface is meant to do everything, and the safeguard
is the settings layer described in [settings.md](settings.md), not which window
you happen to be looking at.
