# Policy as code

ETNPilot evaluates policy before invoking a provider or asking a human to approve an operation.
This separates two questions:

- `policy` decides whether an operation or provider is in scope;
- `approval` decides how an in-scope human decision is collected.

A policy denial is final. The terminal prompt and persistent approval inbox cannot override it.

## Operation rules

```yaml
policy:
  operations:
    default: deny
    rules:
      - id: protect-credentials
        effect: deny
        kinds: [read, write]
        paths: [.env, "**/.env", "**/*.pem", .etnpilot/secrets/**]
      - id: read-project
        effect: allow
        kinds: [read]
        paths: ["**"]
      - id: write-project
        effect: human
        kinds: [write]
        paths: [src/**, test/**, docs/**]
      - id: shell-with-review
        effect: human
        kinds: [shell]
      - id: approved-network-targets
        effect: human
        kinds: [network]
        hosts: [gitlab.example.com, github.com, api.github.com]
```

Effects are:

| Effect | Result |
|---|---|
| `allow` | Approve the single request without prompting |
| `human` | Send the request to the configured approval handler |
| `deny` | Reject before an approval handler sees the request |

Rules may match `kinds`, `agents`, `paths`, and `hosts`. Every specified matcher in a rule must
match. A string or an array of strings is accepted. `*` matches within one path segment, `**`
matches across path segments, and `?` matches one character. Host matching is case-insensitive and
uses the parsed URL hostname, never the query string or credentials.

Relative request paths are resolved against the active workspace. Absolute paths are converted to
workspace-relative paths only when they remain inside that workspace. A path outside the workspace
cannot match any path rule and therefore reaches the section's default effect.

All matching rules are evaluated. The safest effect wins: `deny`, then `human`, then `allow`. This
means the credential-protection rule still wins when a later broad read rule also matches.

## Provider rules

```yaml
policy:
  providers:
    default: deny
    rules:
      - id: builders-use-copilot
        effect: allow
        providers: [github-copilot]
        agents: [orchestrator, builder]
      - id: reviewer-models
        effect: allow
        providers: [github-copilot, review-backup]
        agents: [reviewer]
```

Provider rules accept only `allow` and `deny`. A denied route is recorded as `policy-denied` and is
not invoked. Routing may continue to another configured provider that policy allows. The same check
also protects direct harness invocation when no router is installed.

## Defaults and migration

When an entire section is absent, ETNPilot preserves the earlier behavior: operation decisions use
the `approval` configuration and providers are not restricted by policy. Once `operations` or
`providers` is present, its omitted `default` is `deny`. Generated projects contain explicit,
deny-first rules and protect common credential files and ETNPilot key/secret directories.

Rule IDs must be unique and are included in receipts and diagnostics. Unknown fields, unsupported
effects, empty matchers, and duplicate IDs fail configuration loading instead of being ignored.

## Dry-run diagnostics

```bash
etnpilot policy check --kind read --path src/index.js --agent reviewer --root .
etnpilot policy check --kind network --url https://gitlab.example.com/api/v4 --root .
etnpilot policy check --provider github-copilot --agent builder --root .
```

The command returns the decision plus rule ID or default marker. It exits with status `1` for a
denial or an unconfigured section. It deliberately does not echo the path, URL, or secret-bearing
request data.

## Matching limits

Path patterns are compared textually against the path relative to the workspace. Symbolic links are
not resolved, so a link created during a run can point an allowed path at a protected file. On
macOS and Windows, where the filesystem ignores case, path rules are matched case-insensitively so
that `secret.PEM` cannot step around a rule written for `*.pem`.

Path rules constrain operations ETNPilot mediates. They do not constrain what an approved shell
command does once it runs. Keep `shell` on `human` review, and read
[threat-model.md](threat-model.md) before widening it.

Policy files should be reviewed like source code. Prefer narrow allow rules, keep credential denials
separate and explicit, and require human review for shell, write, and network operations unless a
smaller capability can safely express the task.
