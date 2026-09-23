# The terminal interface

```bash
etnpilot tui --root .
```

A full-screen view of the same things every surface shows: approvals waiting
for a decision, the workflow queue, finished runs read from their receipts, and
the settings in effect. It reads and writes the same files and databases the
CLI uses, so a decision made here is the same decision made there, and a
setting changed here is refused for the same reasons.

## Keys

| Key | Does |
| --- | --- |
| `tab`, `1`–`4` | Switch between approvals, runs, queue, and settings |
| `↑` `↓`, `k` `j` | Move the cursor |
| `enter` | Open the approval under the cursor |
| `a` / `r` | Approve once / reject |
| `c` | Request cancellation of the queue job under the cursor |
| `esc` | Leave the detail view |
| `g` | Refresh now, rather than waiting for the next poll |
| `q`, `ctrl-c` | Quit |

In the settings view:

| Key | Does |
| --- | --- |
| `enter` | Edit the setting under the cursor |
| `d` | Put it back to the committed default |
| `s` | Switch between writing locally and writing to `~/.config` |
| `/` | Filter by path; `enter` keeps the filter, `esc` clears it |

While a filter or a value is being typed, every printable key is text. `q` does
not quit and `d` does not reset — the caret on screen says which mode you are
in.

## What the detail view shows

The whole command, file, tool arguments, or URL — never an abbreviation,
because a reviewer can only approve what they can read. Underneath it, the
rule that stopped the operation:

```
Why you are being asked
  human ← rule 'shell-with-review'
```

That trace is recorded with the approval itself, so it is available to every
surface and survives in the receipt.

## Deciding from two places at once

The same request can be open in the TUI, in `etnpilot approval`, on the web
page, and as a GitLab comment. Whichever answers first wins. The others report
what happened rather than overwriting it:

```
Approval '6f1c…' is already rejected.
```

## How it is built

The views are pure functions: state and viewport in, lines out
(`src/tui/render.js`). The runtime around them only paints what they return and
routes keys (`src/tui/app.js`). That split is why the interface has tests at
all — a frame can be rendered and asserted without a terminal.

Colour is 256-colour ANSI, matching the palette the web surface uses, and is
dropped when the output is not a TTY or `NO_COLOR` is set. Every frame is
measured in visible columns, so styled text is cut without a colour bleeding
into the rest of the line.

## Changing settings

The settings view lists every effective setting with the layer it came from —
`committed`, `local`, or `global` — and what you are allowed to do with it:
`open`, `stricter-only`, or `locked`. `enter` opens an editor prefilled with the
current value; the value is YAML, so `4`, `true`, and `["read"]` all mean what
they look like.

Nothing you change here is ever committed. `s` decides whether the change lands
in `.etnpilot/etnpilot.local.yaml` (this project) or `~/.config/etnpilot/config.yaml`
(every project). See [settings.md](settings.md) for the layers and the modes.

A refusal is shown where the change was made, and the editor stays open so it
can be corrected:

```
approval.allow  stricter-only

Committed default
  ["read"]

This setting may only be narrowed, never widened.

New value as YAML, written to this project, locally
  ["read","write"]▌

  Cannot change 'approval.allow': entries may only be removed; 'write' would be added.
```

A `locked` setting does not open at all, and says why.

Two things the view is deliberately honest about. A local settings file that
the loader would refuse is reported above the list, because otherwise the next
run would be the first to mention it:

```
1 local setting is refused; a run will not start until it is gone:
  secrets.values — the project default locks this setting, so it can only change
  in the committed file
```

And `queue.database` and `approval.inbox.database` name files this session
already opened. Changing one is allowed and is written, but the open handles
cannot follow it, so the TUI says `restart to use it` rather than showing a
setting that has visibly changed and quietly has not.
