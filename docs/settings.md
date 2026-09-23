# Settings

A checkout behaves the same for everyone who clones it. What a person changes
for themselves stays on their machine and is never committed. Only the default
is committed — and it decides what a person is allowed to change.

## The layers

Later wins:

| Layer | File | Committed |
| --- | --- | --- |
| project default | `.etnpilot/etnpilot.yaml` | yes |
| user global | `~/.config/etnpilot/config.yaml` | no |
| user local | `.etnpilot/etnpilot.local.yaml` | no, it is gitignored |
| environment | `${VAR}` interpolation in any layer | n/a |

With no local file, the effective configuration is the committed one, byte for
byte. `etnpilot init` writes the gitignore entry, so the local file cannot be
committed by accident.

`ETNPILOT_CONFIG_HOME` overrides the global directory, `XDG_CONFIG_HOME` is
honoured, and `ETNPILOT_IGNORE_USER_CONFIG=1` loads the committed default alone
— useful in CI, where a user's settings have no business taking part.

## The three modes

The committed default declares, under `settings.modes`, what each configuration
path may become. A pattern matches dotted config paths; `*` is one segment,
`**` is the rest; the most specific pattern wins; anything undeclared is `open`.

- **`open`** — the user decides. The sandbox image, worker counts, poll
  intervals, provider models, telemetry destinations: roughly everything.
- **`stricter-only`** — the user may narrow it, never widen it:

  | Setting | What "stricter" means |
  | --- | --- |
  | `policy.operations.default`, `policy.providers.default` | raise the effect: `allow` → `human` → `deny` |
  | `policy.operations.rules`, `policy.providers.rules` | rules are **added**, never replaced; an added rule must be at least as strict as the section default |
  | `approval.allow` | entries may only be removed |
  | `approval.requireHuman` | entries may only be added |
  | `checks.envAllow` | entries may only be removed |
  | `sandbox.enabled` | `false` → `true` only |

- **`locked`** — the committed file decides alone: `secrets.*`,
  `content.provenance.*`, `receipts.signing.*`, `supplyChain.*`, and
  `settings.*` itself. Modes are read from the project layer only; a local file
  that could relax its own limits would not be a limit.

A stricter-only path with no mechanical rule for narrowing it — say, one rule's
effect deep inside a list — is refused rather than guessed at. "Probably
stricter" is not a safeguard.

## Refusals are reported

A locked key or a widening change is never silently dropped. `etnpilot config
set` refuses before writing anything, and a local file that already contains one
fails the load with the path, the file, and the reason. Someone who believes
they tightened a setting must not be told nothing at all.

## Commands

```
etnpilot config list [--path prefix] [--changed]
etnpilot config set <path> <value> [--global]
etnpilot config unset <path> [--global]
etnpilot config diff
```

`set` and `unset` write the local file by default and `~/.config` with
`--global`. Values are parsed as YAML, so `true`, `4`, `[a, b]`, and plain text
all mean what they look like. `list` reports each effective value with the layer
it came from and its mode; `diff` reports only what differs from the committed
default.

```
$ etnpilot config set queue.workers 4
queue.workers = 4 (local, open)
Written to .etnpilot/etnpilot.local.yaml. This file is yours and is never committed.

$ etnpilot config set approval.allow '[read, write]'
etnpilot: Cannot change 'approval.allow': entries may only be removed; 'write' would be added.
```

The same module backs every surface, so the TUI, the review page, and the app
refuse a change for exactly the reason the terminal gives.

## What the receipt records

A run's terminal receipt names the layers that were in effect and the settings
they changed — not the values, which can carry local paths and machine names:

```json
"settings": {
  "layers": [
    { "source": "project", "sha256": "…" },
    { "source": "user-local", "sha256": "…" }
  ],
  "overrides": ["queue.workers", "sandbox.enabled"]
}
```

A reviewer can therefore tell whether a run used the committed configuration or
something a person changed for themselves, and re-check the hash of each layer
against the file it came from. A run works inside a worktree, where the local
file is not checked out; layer discovery is pointed back at the repository so a
run obeys the same settings as every other surface.
