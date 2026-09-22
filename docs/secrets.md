# Secret providers

ETNPilot separates secret consumers from storage. GitLab, model providers, webhook authentication,
and receipt signing request a logical name; `secrets.values` maps that name to a provider and an
opaque provider key. Secret material must not be placed directly in project configuration.

## Configuration

```yaml
secrets:
  providers:
    env:
      type: env
      allow:
        - ETNPILOT_GITLAB_TOKEN
        - ETNPILOT_GITHUB_TOKEN
    local:
      type: file
      root: .etnpilot/secrets
      requireOwnerOnly: true
      maxBytes: 65536
  values:
    gitlab.apiToken: { provider: env, key: ETNPILOT_GITLAB_TOKEN }
    github.token: { provider: env, key: ETNPILOT_GITHUB_TOKEN }
    provider.apiKey: { provider: local, key: model-api-key }
```

The built-in consumers use these default logical names:

| Consumer | Logical name | Provider-specific override |
|---|---|---|
| GitLab API and publishing | `gitlab.apiToken` | none |
| GitLab signed webhook | `gitlab.webhookSigningSecret` | none |
| GitLab legacy webhook token | `gitlab.webhookToken` | none |
| GitHub Copilot | `github.token` | `providers.<name>.tokenSecret` |
| OpenAI-compatible provider | `provider.apiKey` | `providers.<name>.apiKeySecret` |
| Receipt signing | user-defined | `receipts.signing.privateKeySecret` |

Existing environment names remain fallback inputs for compatibility. Named mappings are preferred
because they keep consumers independent of storage and allow environment access to be restricted.
Literal `apiKey` and `gitHubToken` provider fields remain compatible but should not be committed.

## Built-in backends

The `env` provider accepts uppercase environment-variable keys. Set `allow` to the complete list a
project is permitted to request. Omitting `allow` permits any syntactically valid environment name,
which is useful for compatibility but less restrictive.

The `file` provider requires a root. Keys must be relative paths and cannot traverse to a parent.
Both the configured root and target are resolved before access, preventing a symlink from escaping
the root. Targets must be regular files and cannot exceed `maxBytes`. On POSIX systems,
`requireOwnerOnly` defaults to `true` and rejects group or other access bits. A single final newline
is removed so mounted-secret files work without changing the credential.

`.etnpilot/secrets/` is excluded by the generated `.etnpilot/.gitignore`. If a different file root
is used, exclude it separately and manage its permissions outside ETNPilot.

## Safe diagnostics

```bash
etnpilot secret check gitlab.apiToken --root /path/to/project
```

The command reports only the logical name, whether it is configured and available, the selected
provider name, and a normalized failure reason. It never prints the value or forwards backend error
text. ETNPilot also removes raw upstream response bodies from provider and GitLab client errors.

## OIDC/Vault plugin

The bundled `etnpilot/plugins/vault` plugin exchanges a short-lived workload OIDC token through
Vault's JWT auth endpoint and registers a Vault KV secret provider. The plugin runs in its own
restricted worker. It cannot read the host environment or open network connections directly.
Instead, the host grants exact logical secret inputs and HTTPS URL prefixes, then evaluates every
request against the normal operation policy.

```yaml
secrets:
  providers:
    bootstrap:
      type: env
      allow: [ETNPILOT_VAULT_OIDC_TOKEN]
  values:
    vault.oidcToken: { provider: bootstrap, key: ETNPILOT_VAULT_OIDC_TOKEN }
    gitlab.apiToken: { provider: vault, key: apps/etnpilot#gitlabToken }

policy:
  operations:
    default: deny
    rules:
      - id: vault-secrets
        effect: allow
        kinds: [network]
        hosts: [vault.example.com]

plugins:
  - path: etnpilot/plugins/vault
    bootstrap: true
    secretInputs: [vault.oidcToken]
    networkAllow: [https://vault.example.com/v1/]
    options:
      name: vault
      address: https://vault.example.com
      namespace: engineering
      auth:
        method: jwt
        mount: jwt
        role: etnpilot
        tokenSecret: vault.oidcToken
      engine:
        mount: secret
        version: 2
      allowedPaths: [apps/etnpilot]
      renewBeforeSeconds: 30
      revokeOnShutdown: true
```

Vault keys use `path#field`. Both the configured `allowedPaths` and the host-side
`networkAllow` grant must match before a request is made. URL prefixes must be credential-free
HTTPS URLs. Redirects, other methods, unapproved headers, and targets outside the prefix are
rejected. The policy must also approve the Vault host; a deny decision always wins.

Set `bootstrap: true` when Vault supplies startup credentials such as GitLab, receipt-signing, or
telemetry credentials. Bootstrap plugins are loaded before a run worktree is created and may
declare only `secret.register`, `secret.read`, and `network.fetch`; all other plugins retain the
normal content-loading order. The plugin remains attached to the harness for the complete run.

The workload token is obtained by logical secret name and is never placed in plugin options. The
Vault client token remains in worker memory, is renewed before expiry when Vault marks it
renewable, and is revoked during graceful worker shutdown by default. Authentication is retried
once after a 401 or 403 response. Upstream response bodies and secret values are excluded from
diagnostics. Worker RPC, time, memory, output, cancellation, and shutdown limits apply unchanged.

For KV v2, `engine.version` defaults to `2`; use `1` only for a KV v1 mount. One configured plugin
instance registers one named provider. Use a narrowly scoped Vault role whose policies match
`allowedPaths`; ETNPilot's path check supplements rather than replaces Vault ACLs.

## Custom provider contract

External integrations can supply a factory to `createSecretResolver`. The provider contract is
versioned independently from configuration:

```js
import { createSecretResolver, defineSecretProvider } from "etnpilot";

const resolver = createSecretResolver({
  root: process.cwd(),
  config,
  factories: {
    company: (name, providerConfig) => defineSecretProvider({
      apiVersion: 1,
      name,
      type: providerConfig.type,
      async resolve(key, context) {
        return companySecretClient.read(key, { purpose: context.name });
      },
    }),
  },
});
```

Factories receive `(name, providerConfig, { root, env })`. `resolve` must return a string, or
`undefined` when an optional value is unavailable. It should avoid logging the value, cache only
when the external system's policy permits it, and return short-lived credentials where possible.
Custom factories execute in the host process and are intended for trusted embedding code. Project
extensions should use the isolated `secret.register` plugin capability instead.
