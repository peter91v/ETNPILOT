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
An adapter for an external identity or secret service is not included yet; the contract is the
extension boundary for one.
