# The terminal interface

```bash
etnpilot tui --root .
```

A full-screen view of the same three things every surface shows: approvals
waiting for a decision, the workflow queue, and finished runs read from their
receipts. It reads and writes the databases the CLI uses, so a decision made
here is the same decision made there.

## Keys

| Key | Does |
| --- | --- |
| `tab`, `1` `2` `3` | Switch between approvals, runs, and queue |
| `↑` `↓`, `k` `j` | Move the cursor |
| `enter` | Open the approval under the cursor |
| `a` / `r` | Approve once / reject |
| `c` | Request cancellation of the queue job under the cursor |
| `esc` | Leave the detail view |
| `g` | Refresh now, rather than waiting for the next poll |
| `q`, `ctrl-c` | Quit |

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

## Not here yet

Editing policy and configuration from the TUI is next, and it waits on the
local settings layer: a user's changes belong in a local override that is never
committed, on top of the defaults that are. Until that exists, the TUI decides
and inspects but does not configure.
