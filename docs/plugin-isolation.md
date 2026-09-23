# Plugin process isolation

ETNPilot runs every configured plugin in its own Node.js worker process. The harness never imports a
plugin module and never receives a plugin function. A worker returns a validated manifest plus a
bounded list of setup actions; provider invocations and event delivery remain behind RPC for the
worker's lifetime.

## Security contract

- A plugin receives only the context methods named by its manifest capabilities.
- The worker environment is empty. Host credentials and configuration variables are not inherited.
- Node's permission system denies filesystem writes, subprocesses, and native addons. Filesystem
  reads are limited to the ETNPilot worker runtime, the entry module, and an
  explicitly configured `moduleRoot` when a multi-file plugin needs one.
- An import hook permits the small set of non-I/O Node built-ins needed by normal plugins and denies
  filesystem, process, module-loader, subprocess, worker, inspection, and network built-ins.
- Global `fetch`, `WebSocket`, and `EventSource` are disabled. CommonJS, native-addon, WebAssembly,
  HTTP/data module URLs, and in-process `Harness.use()` plugins are rejected.
- IPC accepts versioned request/response envelopes only. IDs, methods, payload shape, message size,
  and pending-request counts are validated in both directions.
- Standard output and standard error are counted but not forwarded. Exceeding the configured limit
  terminates the worker without copying plugin output into receipts or diagnostics.

The permission system and V8 heap limit apply on every supported Node.js platform. On Linux, the
parent also monitors resident memory through `/proc` and kills a worker above `memoryMb`; this
catches external allocations such as large buffers. Plugin isolation is a defense boundary for
JavaScript extensions, not a substitute for a container when executing native or untrusted binary
code. Native and non-ESM plugin formats are therefore not accepted.

## Configuration

```yaml
pluginIsolation:
  setupTimeoutMs: 10000
  callTimeoutMs: 30000
  shutdownTimeoutMs: 1000
  memoryMb: 128
  maxOutputBytes: 65536
  maxMessageBytes: 1048576
  maxPendingRequests: 32
  memoryPollIntervalMs: 100

plugins:
  - path: ./.etnpilot/plugins/team-guidance.mjs
    options:
      strict: true
    limits:
      callTimeoutMs: 5000
      memoryMb: 96
```

Global values become defaults. A plugin entry can provide `limits`, a `moduleRoot`, scoped resource
grants, and the restricted `bootstrap` flag. `moduleRoot` is resolved from the project root and
should name the smallest directory containing that plugin's ESM dependency files. Options and all
setup data must be JSON-serializable.

Security-sensitive host services require grants in addition to manifest capabilities:

```yaml
plugins:
  - path: etnpilot/plugins/vault
    bootstrap: true
    secretInputs: [vault.oidcToken]
    networkAllow: [https://vault.example.com/v1/]
```

`secretInputs` contains exact logical secret names. `networkAllow` contains credential-free HTTPS
URL prefixes. A plugin must also declare `secret.read` or `network.fetch`, and network calls must
pass the normal operation policy. The host accepts only GET and POST, a small header allowlist,
bounded string bodies, no redirects, and bounded responses. Direct worker networking remains
disabled.

`bootstrap: true` is reserved for secret providers needed before workspace creation. Bootstrap
plugins may declare only `secret.register`, `secret.read`, and `network.fetch`, preventing early
registration of agents, model providers, instructions, prompts, skills, or event listeners.

| Setting | Purpose | Default |
|---|---|---:|
| `setupTimeoutMs` | Import plus `setup()` deadline | 10000 |
| `callTimeoutMs` | Provider, event, and host-callback deadline | 30000 |
| `shutdownTimeoutMs` | Graceful shutdown deadline before forced termination | 1000 |
| `memoryMb` | V8 old-space limit and Linux RSS ceiling | 128 |
| `maxOutputBytes` | Combined stdout/stderr bytes per worker | 65536 |
| `maxMessageBytes` | Maximum encoded RPC request or response | 1048576 |
| `maxPendingRequests` | Concurrent RPC or callback ceiling | 32 |
| `memoryPollIntervalMs` | Linux RSS sampling interval | 100 |

All values are positive bounded integers. Invalid configuration fails before plugin setup.

## Lifecycle and failures

Workers start while project content is loaded. Dependencies are checked before any setup action is
applied to the harness. If validation or registration fails, applied actions are rolled back and all
workers from that load attempt are terminated.

The harness owns every accepted worker. Normal completion requests a graceful shutdown. Timeout,
abort, malformed protocol, excessive output, excessive memory, unexpected exit, or an oversized
result fails the active operation and forcefully terminates that worker. Event subscriptions are
always removed during termination. A failed worker is not restarted automatically because its
provider or event side effects may be ambiguous.

A plugin may define an optional asynchronous `shutdown()` hook. It runs only during graceful
shutdown and remains subject to the configured shutdown deadline; forced termination still reaps
the process and removes all host registrations.

Stable error codes include `plugin_timeout`, `plugin_aborted`, `plugin_memory_limit`,
`plugin_output_limit`, `plugin_rpc_limit`, `plugin_protocol_error`, `plugin_permission_denied`, and
`plugin_process_exit`. Secret-provider registrations are removed and active host-mediated network
requests are aborted when their worker exits.
