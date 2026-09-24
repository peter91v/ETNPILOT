# Local review UI

```bash
etnpilot ui --root .
# ETNPilot review UI: http://127.0.0.1:8788/?token=…
# Opened it with 'xdg-open'. Use --no-open to keep it in the terminal.
```

At a terminal it opens the page for you, because the link carries a token
nobody wants to retype. It does not when the output is a pipe, when `CI` is
set, when `BROWSER` is `none`, or with `--no-open`; `--open` asks for it
anyway. `BROWSER` names the opener if you have a preference, and on Android
`termux-open-url` is tried before `xdg-open`. If nothing can open a browser,
the command says so and keeps serving — the link is still on screen.

A local page for the evidence ETNPilot already produces: approvals waiting for
a decision, the workflow queue, and finished runs read from their receipt
files. It is a second window onto the same databases the CLI uses, never a
second source of truth.

## The shape of it

A sidebar of views rather than one long scroll: Overview, Approvals, Queue,
Runs, Worktrees, Merge requests, Settings. The button beside the project name
collapses it to a rail of icons — the counts stay — and remembers that for
this browser; where the sidebar is a drawer, the same button opens it. The view is in the address
(`#approvals`), so a reload comes back where you were. `ctrl` `K` opens a
command palette that goes to a view or runs a command; `Escape` closes
whatever is open. Below 860px the sidebar becomes a drawer, and below 560px the
labels in the top bar give way to their icons.

The layout follows a GUI draft; what it does not follow is the draft's screens
for things that do not exist. A surface that shows an empty "Plugins" page
teaches the wrong thing about what this can do.

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
  and the receipt hash. Opening one reads the receipt itself and leads with
  **why it ended**: the failing step and its own error, the steps that never
  ran because of it, an approval that was rejected, and whether it was
  published. Under that, **the agents that ran, as the tree they actually ran
  in** — a subagent a manifest declares nests under the agent that spawned it
  rather than being listed beside it — with each row clickable to read that
  agent's full text exactly as the receipt holds it, whatever it called and
  what came back, and what it cost. Then every step with its attempts and
  duration, what the run cost in tokens and money, the branch and workspace
  path, the sandbox, the merge rehearsal and what it would collide with or
  why it never ran, every approval with who decided it, and which settings
  layers were in effect.
- **What a run is doing right now**: the overview shows each run this page
  started, which step it is in, which agent is inside that step, and how far
  along the plan it is.
- **Usage**: tokens sent, tokens read from cache, provider calls and the
  estimated cost, across every run the project recorded. Where
  `observability.enabled` is false the cards say that rather than showing a
  zero that looks like a measurement.
- **Worktrees**: which branch each holds, which ones a run made, and what
  removing one would throw away. Opening one lists the files it is holding —
  with how many lines each one added and deleted, and marked as a person's
  work or as state ETNPilot wrote itself — and opening a file shows the diff
  with the line numbers it touched. `Remove` goes through the same
  `removeIfClean` the CLI and the TUI use.
- **Merge requests**: ETNPilot's own first, told apart by their `etnpilot/`
  branch, with everyone else's beside them. This is the only part of the page
  that needs the network and a token; it is read when the page loads and on
  `Ask GitLab`, never in the poll, and says which of the project, the token, or
  GitLab itself is missing.
- **Settings**, against the same layers the CLI and the TUI use: the value, the
  layer it came from, and whether it may be changed (`open`, `stricter-only`,
  `locked`). The control is in the row: a setting that takes one of a known
  list is a dropdown there, and choosing saves at once; a refusal puts the row
  back. Everything else shows its value with a caret that opens the editor —
  checkboxes for a set of values, a YAML field otherwise. A `locked` setting
  has no control at all and says why when you ask. A refusal appears where the
  change was made, with the reason, and the input keeps what was typed. Nothing
  changed here is ever committed — it goes to `.etnpilot/etnpilot.local.yaml`
  or `~/.config/etnpilot/config.yaml`. Local settings the loader refuses are
  reported above the list, because otherwise the next run would be the first to
  mention them.
- **Starting a run**, with the agent chosen from the project's own — the list
  is read from `.etnpilot/agents/`, and each choice says which provider it
  would use and what it needs. Its approvals come back to this same page. The request
  is answered at once rather than held for the whole run; what is running, and
  what a run failed with, is part of the state the page polls. Closing the
  server stops the runs it started, as quitting the TUI does.

Every value is inserted as text, never as markup, because all of it is text an
agent controlled.

Long lists say when they are cut rather than showing a count that disagrees
with the rows beneath it, and the poll holds still while a field has focus, so
it never throws away what is being typed.

## From a tablet or a phone

The page is built for it: it fits at 390px, at 768px and at 820px without a
horizontal scrollbar, and every control is finger-sized on a touch screen. The
question is only how the device reaches the server, and the answer is never
"open the port and hope".

**ETNPilot runs on the tablet itself** (Termux on Android, for example): there
is nothing to do. Open the URL `etnpilot ui` printed, token and all, in the
browser on that device. `etnpilot tui` works the same way in the terminal
there.

**ETNPilot runs on another machine**: forward the port over SSH from the
tablet, with any SSH client, and open the loopback URL on the device:

```bash
ssh -N -L 8788:127.0.0.1:8788 <user>@<the-machine>
# then open http://127.0.0.1:8788/?token=… on the tablet
```

The server keeps its loopback binding, the traffic is encrypted, and nothing
else on the network can reach it. The same tunnel serves a phone.

**Binding to the network instead** (`etnpilot ui --host 0.0.0.0`) works and is
sometimes what you want on a trusted network. It prints an address the other
device can actually use, and it says what you have given up: the port is then
reachable by everyone on that network, and everyone who reaches it and has the
token can approve operations, change local settings, and start runs. There is
no second check behind the token. Do not do it on a network you share with
people you would not hand the token to, and never on a public one.

## Security

The server binds to `127.0.0.1` and mints a token at startup. The token is in
the URL it prints; API calls must send it in an `x-etnpilot-token` header,
which a page on another origin cannot set without a preflight this server
refuses. The page itself loads nothing from anywhere — no CDN, no fonts, no
analytics — and says so in its content security policy.

Opening the browser passes that URL to another program as an argument, where
other processes of the same user can read it. It is on your terminal either
way; `--no-open` is there for a machine where that difference matters.

**Anyone who has the token can approve operations, change local settings, and
start runs**, exactly as anyone who can write these files can. Do not forward the URL, and do not expose the
port. There is no user model here: the UI names the reviewer from an input
field, the same self-declared identity the CLI's `--actor` provides. For an
identity asserted by someone else, use the GitLab comment flow in
[gitlab-webhooks.md](gitlab-webhooks.md).

## Looking at it

The page is a single file with no build step, so changing it means rendering it
and looking: at 1280px, 820px and 390px, in both colour schemes, and pressing
every control. Three kinds of fault have come out of that and none of them out
of a test: a wide table dragging every other section off screen (a grid child
is `min-width: auto`, so every grid that holds content needs
`minmax(0, 1fr)`), all seven views rendering at once (a `display` declaration
overrides the `hidden` attribute), and a poll overwriting the answer to
something you had just done.

## Limits

The page does not run the checks (`policy check`, `deps check`, `scan secrets`,
`doctor`, `telemetry summary`), verify a receipt, or replay a run; those are
still CLI commands. Every surface is meant to do everything, and the safeguard
is the settings layer described in [settings.md](settings.md), not which window
you happen to be looking at.
