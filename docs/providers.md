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
  its key is your stored GitHub login (`etnpilot login github`), which needs the "models" permission (a fine-grained
  token with Models: read is the sure way; the browser sign-in now asks for `read:user models:read`, but that is not verified against GitHub, and an
  earlier sign-in has to be repeated: `etnpilot login github`. If `smoke` reports an answer of `OK` from
  models.github.ai, the token was not accepted as a Models token).
  Projects created by `init` already have a `github-models` entry; this is for projects from before that.
- `--name` adds a second entry from the same preset; `--force` replaces an existing one; `--model` picks the
  model. The model in a preset is a starting point: ask `etnpilot models` what the account has.

These providers use keys from the environment. Stored logins (`etnpilot login`) exist for Anthropic and
OpenAI; a key from the environment is not bound to a host, and `etnpilot doctor` says so when the address is
not the vendor's own (see `docs/login.md`).

To add a provider that is not in the list, `etnpilot config set providers.<name> '{type: openai-compatible,
baseUrl: https://…/v1, model: …}'` writes the same thing by hand.
