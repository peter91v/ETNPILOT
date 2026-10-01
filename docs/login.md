# Signing in instead of exporting keys

```
etnpilot login anthropic      # asks for the key once, checks it, keeps it
etnpilot login openai
etnpilot login github         # browser sign-in (device flow)
etnpilot login gitlab
etnpilot auth status          # who is connected, and from where
etnpilot logout <service>
```

The web page has the same under **Accounts**.

## What "login" means for each service

| Service | How | Why |
|---|---|---|
| GitHub | Browser sign-in (OAuth device flow), or a token | GitHub supports it for tools like this one |
| GitLab | Browser sign-in (device flow, GitLab 17.9+), or a token | The access token is renewed by itself; GitLab's last two hours |
| Anthropic | The API key, entered once | The API is sold by key; other tools cannot sign in for you |
| OpenAI | The API key, entered once | The same |

ETNPilot does not imitate the sign-in of another vendor's own tool to reach
the Anthropic or OpenAI API with a subscription. It would break without
warning and is not what those services allow.

## One-time setup for the browser sign-in

The device flow needs the id of an OAuth application, because the sign-in page
names the application that asks. It is not a secret and is typed once; ETNPilot
remembers it.

- **GitHub:** github.com/settings/developers → New OAuth App, tick **Enable
  Device Flow**. Then `etnpilot login github --client-id <id>`.
- **GitLab:** Preferences → Applications, scope `api`, not confidential. Then
  `etnpilot login gitlab --client-id <id> [--host https://gitlab.example.com]`.
  The host defaults to `git.baseUrl` of the project.

Without a client id, `login` says so and offers a pasted token instead
(`--key-stdin` reads one from a pipe).

## Where it lives

`~/.config/etnpilot/credentials.json` (or `$XDG_CONFIG_HOME/etnpilot/`, or
`$ETNPILOT_HOME/`), mode `0600`, outside every repository. A project never holds
it, so it cannot be committed and a worktree does not copy it.

A stored login answers the same question the environment would: the secret
`anthropic.apiKey`, `openai.apiKey`, `github.token`, `gitlab.apiToken`. **A
variable set in the environment wins**; the stored login fills in when there is
none. `etnpilot logout` removes the stored one and says if the environment
still provides one.

A key is checked with one harmless request (list models, read the user) before
it is kept. A key the service refuses is not stored. If the service could not be
reached the key is kept and marked *not verified*.
