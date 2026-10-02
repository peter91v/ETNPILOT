# Adding a provider

Anything that speaks the OpenAI chat API needs no code, only an address, a key and a model.

```bash
etnpilot provider presets                 # gemini, mistral, openrouter, groq, github-models, ollama
etnpilot provider add gemini              # then: export GEMINI_API_KEY=...
etnpilot smoke --provider gemini          # does it answer, call tools, stream?
etnpilot models --provider gemini         # which model ids this account has
```

`provider add` edits the YAML in place (comments stay) and says what it changed:

- A provider with a key (`gemini`, `mistral`, `openrouter`, `groq`) goes into the **committed**
  `.etnpilot/etnpilot.yaml`, together with a secret mapped to its environment variable and that variable on
  the `secrets.providers.env.allow` list. Your local file is not allowed to widen what a project may read, so
  this cannot live there. Because the committed file changed, `etnpilot trust` asks again.
- A provider without a key (`ollama`, on this machine) goes into your own local settings. So does `github-models`:
  its key is your stored GitHub login. A browser sign-in (OAuth app) cannot carry the Models permission: GitHub rejects
  `models:read` as a scope there. Use a fine-grained personal access token with Account permissions → Models: Read, and
  paste it on the Accounts page (or pipe it: `etnpilot login github --key-stdin`). If `smoke` reports an answer of `OK` from
  models.github.ai, the token was not accepted as a Models token.
  Projects created by `init` already have a `github-models` entry; this is for projects from before that.
- `--name` adds a second entry from the same preset; `--force` replaces an existing one; `--model` picks the
  model. The model in a preset is a starting point: ask `etnpilot models` what the account has.

These providers use keys from the environment. Stored logins (`etnpilot login`) exist for Anthropic and
OpenAI; a key from the environment is not bound to a host, and `etnpilot doctor` says so when the address is
not the vendor's own (see `docs/login.md`).

To add a provider that is not in the list, `etnpilot config set providers.<name> '{type: openai-compatible,
baseUrl: https://…/v1, model: …}'` writes the same thing by hand.

## GitHub Copilot on a Linux, macOS or Windows machine

This is the route for real work: the Copilot provider talks to Copilot through GitHub's own SDK, so it needs no
inofficial endpoint. GitHub publishes the SDK only for those three systems, so it does not install on Android/Termux.

```bash
npm install @github/copilot-sdk        # in the ETNPilot directory
etnpilot doctor                         # github-copilot should show as usable
etnpilot smoke --provider github-copilot
```

`smoke` checks that the SDK loads and that one tiny request is answered. Tools and streaming are not checked: the
SDK runs its own tool loop and ETNPilot has no switch for either. The first real run with a Copilot account is
still the test of this provider; so far it has only been exercised against stand-ins.

Which login the SDK uses: the GitHub token stored by `etnpilot login github` (or `ETNPILOT_GITHUB_TOKEN`) if there is
one, otherwise the user the Copilot CLI is signed in as. If the first request is refused while the Copilot CLI works,
the stored token is the likely cause (a browser sign-in with `read:user` is not necessarily a Copilot token): remove
it with `etnpilot logout github` and let the SDK use the Copilot CLI's login.
