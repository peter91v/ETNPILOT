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
| `tab`, `1`–`6` | Switch between approvals, runs, queue, settings, worktrees, and merge requests |
| `↑` `↓`, `k` `j` | Move the cursor |
| `enter` | Open the approval under the cursor |
| `a` / `r` | Approve once / reject |
| `c` / `R` | Request cancellation of / resume the queue job under the cursor |
| `x` | Remove the worktree under the cursor, if it is clean |
| `enter` (worktrees) | What that worktree is holding, file by file |
| `n` | Start a run |
| `esc` | Leave the detail view |
| `g` | Refresh now, rather than waiting for the next poll |
| `?` | Every key, on one screen |
| `q`, `ctrl-c` | Quit |

In the settings view:

| Key | Does |
| --- | --- |
| `enter` | Edit the setting under the cursor; the line beneath names the values it accepts |
| `←` `→` (editing) | Step through those values, where a setting has a list |
| `d` | Put it back to the committed default |
| `s` | Switch between writing locally and writing to `~/.config` |
| `/` | Filter by path; `enter` keeps the filter, `esc` clears it |

While a filter or a value is being typed, every printable key is text. `q` does
not quit and `d` does not reset — the caret on screen says which mode you are
in.

## From a tablet or a phone

In a terminal app on the device, over SSH, or in Termux where ETNPilot runs on
the device itself. Every view lays out from 46 columns up, the detail panes
stack instead of sitting side by side below 92 columns, and a value longer than
the line is cut at the front so the caret stays visible. For a browser instead,
see [review-ui.md](review-ui.md#from-a-tablet-or-a-phone).

## Worktrees

A run works in its own worktree, so what is on disk is evidence as much as the
receipt is. `5` lists them: which branch each holds, which ones ETNPilot made,
and what removing one would throw away.

```
3 worktrees · 2 from runs · 1 with unsaved work

  WORKTREE          BRANCH                  HEAD      FROM      STATE
  service           main                    3c278aed  checkout  clean
› run-7e1b0a33      etnpilot/run-7e1b0a33   3c278aed  a run     1 unsaved
  run-9f2a1c44      etnpilot/run-9f2a1c44   3c278aed  a run     clean
```

`enter` lists what a worktree is holding, file by file, each marked as a
person's work or as state ETNPilot wrote itself. `x` removes the one under the
cursor through the same `removeIfClean` the CLI uses, which is the point: a
worktree holding unsaved work is **not** removed, and the screen says what it
is keeping.

```
run-7e1b0a33 keeps 1 unsaved change — nothing was removed.
```

The state ETNPilot itself writes into a workspace — the CodeGraph index,
`.etnpilot/state/` — never counts as unsaved work, exactly as it does not for
`etnpilot worktree cleanup`. The checkout you work in, a locked worktree, and
one that is not ETNPilot's are refused with the reason; when no row on screen
can be removed, the view says so rather than letting `x` look broken.

Worktrees are local but not free — one `git status` each — so they are reread
while this view is open and at most every five seconds. `g` rereads now.

## Merge requests

`6` shows what is open in GitLab for this project, ours first. Ours are the
ones a run published: told apart by their branch, `etnpilot/…`, not by a name
in the title that anyone could copy.

```
group/service · 3 opened · 2 ours · target main

  MR     TITLE                                BRANCH                 WHOSE  MERGE      UPDATED
  !42    Draft: ETNPilot: add a health check  etnpilot/run-9f2a1c44  ours   draft      2h
› !41    Draft: ETNPilot: retry the lease     etnpilot/run-7e1b0a33  ours   conflicts  1d
  !39    Split the scheduler out              feature/scheduler      mira   mergeable  5m

https://gitlab.internal/group/service/-/merge_requests/41
```

Everyone else's are listed too, because what lands before ours is what breaks
ours — the same reason a run rehearses its merge against the target branch.
Titles, branches, and names written by other people are data here: escaped and
bounded, like every other value on screen.

This is the one view that needs the network and a token, so it is never fetched
behind your back: it reads when you open it and again on `g`, never on the
poll. Without `git.project` it says what to configure; without a token, or when
GitLab refuses, it says that instead of looking like a project with nothing
open. Everything else in the TUI keeps working either way.

The same two are in the terminal: `etnpilot worktree list` prints exactly what
the worktrees view shows, and `etnpilot merge list [--status …]` what the merge
requests view shows.

## Starting a run

`n` puts a prompt on the bottom line, the way a terminal tool has always done
it. Whatever you were looking at stays on screen while you type:

```
›   SHELL builder · 4f2a9c1b                                              4m
    npm run migrate -- --database production --apply

agent: the project's workflow: build → verify · tab to name one · enter starts
run> Add a health check endpoint█
```

The line above the input says what an empty agent field would run, so it is
never just a blank; `tab` moves to the agent and back. Naming an agent runs
that agent instead of the configured steps.

The run works in its own worktree, exactly as `etnpilot run` does, and it does
not block the screen. Everything it needs approved appears under approvals in
this same window, where you can read the whole command and answer it — the
decision is recorded as `tui:<you>`. That is the one thing the terminal command
cannot do: `etnpilot run` holds the terminal it is asking from.

Quitting stops any run started here rather than stranding it: each is asked to
abort, its waiting request is closed, and its receipt records why.

## What a run's receipt shows

`enter` on a run opens what was sealed, beginning with why it ended — the
failing step and its own error, the steps that never ran because of it, and
whether it was published:

```
Why it ended
  verify: checks failed: 2 of 18 tests (src/workflow/queue.test.js)
  publish: never ran: a step it needs failed
  not published: the workflow did not succeed
```

Then every step with its attempts, what the run cost:

```
Usage
  204,621 tokens 184,203 in · 20,418 out · 120,000 cached
  7 provider calls USD 0.8123
```

and the branch and sandbox, the merge rehearsal and any conflicts, the
approvals with who decided them, and which settings layers were in effect:

```
Settings in effect
  project → user-local
  2 changed locally  queue.workers, sandbox.enabled
```

That last part matters for review: it says whether a run used the committed
configuration or something a person changed for themselves.

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

Editing works the same way: the list stays on screen with the cursor on the row
you are changing, and the value is typed on the bottom line.

```
› approval.allow           ["read"]        committed    stricter-only

stricter-only · default ["read"] · writing this project, locally · enter saves
set approval.allow> ["read","write"]█
```

A refusal replaces the hint, directly above the line it was typed on, and the
input stays open so the change can be corrected:

```
Cannot change 'approval.allow': entries may only be removed; 'write' would be added.
set approval.allow> ["read","write"]█
```

A `locked` setting does not open at all, and says why.

A value longer than the line is cut at the **front**, so the caret is always
visible — which matters at phone and tablet widths.

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
